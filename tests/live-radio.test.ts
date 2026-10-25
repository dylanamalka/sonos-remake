import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { LiveRadio, Mp3Frames } from '../prototypes/mac-audio/radio';
function syntheticPcm() {
  const input = new PassThrough();
  let phase = 0;
  const timer = setInterval(() => {
    const data = Buffer.alloc(480 * 2 * 4);
    for (let i = 0; i < 480; i++) {
      const value = Math.sin((phase++ * 2 * Math.PI * 440) / 48000) * 0.08;
      data.writeFloatLE(value, i * 8);
      data.writeFloatLE(value, i * 8 + 4);
    }
    input.write(data);
  }, 10);
  return {
    input,
    stop: () => {
      clearInterval(timer);
      input.destroy();
    },
  };
}
for (const mode of ['close', 'chunked'] as const)
  test(
    `continuous ${mode}-delimited radio emits decodable continuous MP3, bounds history, reconnects at a frame, and cleans up`,
    { timeout: 15000 },
    async () => {
      const source = syntheticPcm();
      const radio = new LiveRadio({ httpMode: mode, maxClients: 1 });
      const server = createServer((req, res) => radio.handle(req, res));
      const before = process.memoryUsage().rss;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/live/${radio.token}.mp3`;
      try {
        await radio.start(source.input, source.stop);
        assert.equal(radio.stats().state, 'streaming');
        assert.equal((await fetch(url.replace(radio.token, '0'.repeat(64)))).status, 404);
        assert.equal((await fetch(url, { headers: { Range: 'bytes=200-' } })).status, 416);
        const head = await fetch(url, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('accept-ranges'), 'none');
        assert.equal(head.headers.get('content-length'), null);
        const probe = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        assert.equal(probe.status, 206);
        assert.equal(probe.headers.get('content-range'), 'bytes 0-15/*');
        assert.equal((await probe.arrayBuffer()).byteLength, 16);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/mpeg');
        assert.equal(
          response.headers.get('transfer-encoding'),
          mode === 'chunked' ? 'chunked' : null,
        );
        const reader = response.body!.getReader();
        const received: Buffer[] = [];
        let size = 0;
        while (size < 50000) {
          const next = await reader.read();
          assert.equal(next.done, false);
          received.push(Buffer.from(next.value!));
          size += next.value!.length;
        }
        assert.equal((await fetch(url)).status, 503, 'only one coordinator at a time in this test');
        assert.ok(radio.stats().frames > 40);
        assert.ok(radio.stats().bufferedBytes < 60000);
        assert.ok(
          process.memoryUsage().rss - before < 80 * 1024 * 1024,
          'bounded parent-process memory in a short synthetic run',
        );
        const captured = Buffer.concat(received);
        execFileSync(
          'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 'null', '-'],
          { input: captured },
        );
        await reader.cancel();
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(radio.stats().clients, 0);
        const reconnect = await fetch(url);
        const retry = reconnect.body!.getReader();
        const first = await retry.read();
        assert.equal(first.done, false);
        assert.equal(first.value![0], 0xff);
        assert.equal(first.value![1] & 0xfe, 0xfa);
        await retry.cancel();
        await radio.stop();
        assert.equal(radio.stats().clients, 0);
        assert.equal(radio.stats().bufferedFrames, 0);
        assert.equal((await fetch(url)).status, 503);
      } finally {
        source.stop();
        await radio.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
test('prototype encoder failure and missing capture samples fail visibly and release resources', async () => {
  const missing = new LiveRadio({ ffmpeg: '/definitely-not-installed/current-ffmpeg' });
  await assert.rejects(missing.start(new PassThrough()), /FFmpeg/);
  await missing.stop();
  assert.equal(missing.stats().state, 'error');
  const stalled = new LiveRadio({ stallMs: 200 });
  const input = new PassThrough();
  await assert.rejects(stalled.start(input), /No PCM/);
  await stalled.stop();
  input.destroy();
  assert.equal(stalled.stats().clients, 0);
});
test('MP3 frame parser tolerates arbitrary boundaries without accumulating an unbounded history', () => {
  const parser = new Mp3Frames();
  for (let i = 0; i < 100; i++) parser.push(Buffer.alloc(1000));
  assert.ok(parser.bufferedBytes < 4);
  const frame = Buffer.alloc(626);
  frame.set([0xff, 0xfb, 0xb0, 0x00]);
  assert.equal(parser.push(frame.subarray(0, 100)).length, 0);
  assert.equal(parser.push(frame.subarray(100)).length, 1);
});
test('a slow subscriber is dropped without blocking capture or retaining its output queue', async () => {
  const { EventEmitter } = await import('node:events');
  const source = syntheticPcm(),
    radio = new LiveRadio();
  class SlowResponse extends EventEmitter {
    writableLength = 129 * 1024;
    destroyed = false;
    writableEnded = false;
    useChunkedEncodingByDefault = false;
    setHeader() {
      return this;
    }
    flushHeaders() {}
    write() {
      return false;
    }
    destroy() {
      this.destroyed = true;
      this.emit('close');
      return this;
    }
  }
  try {
    await radio.start(source.input, source.stop);
    const response = new SlowResponse();
    radio.handle(
      { url: `/live/${radio.token}.mp3`, headers: {}, method: 'GET' } as any,
      response as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(response.destroyed, true);
    assert.equal(radio.stats().clients, 0);
    assert.equal(radio.stats().state, 'streaming');
  } finally {
    source.stop();
    await radio.stop();
  }
});
