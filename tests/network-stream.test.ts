import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
const dir = await mkdtemp(path.join(os.tmpdir(), 'current-network-'));
process.env.SONOS_DATA_DIR = dir;
process.env.PUBLIC_BASE_URL = 'http://192.168.1.50:3000';
const { Sonos, parseXml } = await import('../server/sonos');
const { NetworkStream, streamProfiles } = await import('../server/network-stream');
const { startCapture, StreamError } = await import('../server/mac-capture');
const { PcmClock } = await import('../server/pcm-clock');
const { radioUri, radioMetadata } = await import('../server/radio-uri');
const { createApi } = await import('../server/api');
const { initPairing } = await import('../server/security');
const profile = {
  browser: 'chrome' as const,
  roomIds: ['MOCK_0', 'MOCK_1'],
  httpMode: 'close' as const,
  bufferSeconds: 1,
};
async function until(check: () => boolean | Promise<boolean>, timeout = 7000) {
  const begin = Date.now();
  while (!(await check())) {
    if (Date.now() - begin > timeout) throw new Error('Expected stream state was not reached');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function fixture() {
  const s = new Sonos(false),
    mock = new Sonos(true);
  for (const r of mock.rooms.values()) s.rooms.set(r.id, { ...r, host: '127.0.0.1' });
  s.refresh = async () => [...s.rooms.values()];
  s.group = async (id, target) => {
    const r = s.room(id);
    r.coordinator = target || id;
    r.group = r.coordinator;
  };
  s.playUri = async (id, track) => {
    const c = s.coordinator(id);
    for (const r of s.rooms.values())
      if (r.coordinator === c.id) {
        r.track = track;
        r.transportUri = track.uri;
        r.state = 'PLAYING';
      }
  };
  s.control = async (id, action, value) => {
    const c = s.coordinator(id);
    if (action === 'volume') s.room(id).volume = Number(value);
    else
      for (const r of s.rooms.values())
        if (r.coordinator === c.id) r.state = action === 'play' ? 'PLAYING' : 'STOPPED';
  };
  return s;
}
const dependencies = {
  openBrowser: async () => {},
  capture: async (browser: 'chrome' | 'safari', _mock: boolean, _phase: any, onError: any) =>
    startCapture(browser, true, undefined, undefined, onError),
};
test('radio wrapper replaces HTTP scheme and emits escaped broadcast DIDL, with real SOAP coordinator targeting', async () => {
  const uri = radioUri('http://192.168.1.50:3000/live/abc.mp3');
  assert.equal(uri, 'x-rincon-mp3radio://192.168.1.50:3000/live/abc.mp3');
  const metadata = radioMetadata('http://192.168.1.50:3000/live/abc.mp3', 'DJ < X & Y');
  const item = parseXml(metadata)['DIDL-Lite'].item;
  assert.equal(item.title, 'DJ < X & Y');
  assert.equal(item.class, 'object.item.audioItem.audioBroadcast');
  assert.equal(item.res['@_protocolInfo'], 'http-get:*:audio/mpeg:*');
  for (const url of [
    'file:///tmp/a',
    'https://192.168.1.1/a',
    'http://attacker.example/a',
    'http://user:pass@192.168.1.1/a',
  ])
    assert.throws(() => radioUri(url));
  const s = new Sonos(false),
    m = new Sonos(true);
  for (const r of m.rooms.values())
    s.rooms.set(r.id, { ...r, host: '192.168.1.50', coordinator: 'MOCK_0' });
  const original = global.fetch;
  const calls: string[] = [];
  global.fetch = async (_url, options) => {
    const body = String(options!.body);
    calls.push(body);
    const action = body.match(/<u:(\w+) /)![1];
    return new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="test"/></s:Body></s:Envelope>`,
    );
  };
  try {
    await s.playUri('MOCK_1', { id: 'radio', title: 'Live', artist: 'Browser', uri, metadata });
    assert.match(calls[0], /x-rincon-mp3radio:\/\/192\.168/);
    assert.doesNotMatch(calls[0], /mp3radio:http/);
    assert.match(calls[0], /audioBroadcast/);
    assert.match(calls[1], /<u:Play /);
  } finally {
    global.fetch = original;
  }
});
test(
  'network session encodes 192k MP3, routes a group, observes its HTTP reader, reconnects, revokes old URLs, preserves levels, and stops',
  { timeout: 18000 },
  async () => {
    const s = fixture(),
      service = new NetworkStream(s, { ...dependencies, pollMs: 40 });
    const server = createServer((req, res) => service.handleAudio(req as any, res as any));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      s.room('MOCK_1').mute = true;
      await service.start(profile);
      await until(async () => Boolean((await service.status()).coordinator));
      assert.equal(s.room('MOCK_1').coordinator, 'MOCK_0');
      assert.equal(s.room('MOCK_1').mute, true);
      assert.equal(s.room('MOCK_1').volume, 35);
      const oldPath = new URL(s.room('MOCK_0').transportUri!.replace('x-rincon-mp3radio:', 'http:'))
        .pathname;
      let deniedStatus = 0;
      service.handleAudio(
        {
          socket: { remoteAddress: '203.0.113.77' },
          url: oldPath,
          method: 'GET',
          headers: {},
        } as any,
        {
          writeHead: (code: number) => {
            deniedStatus = code;
            return { end: () => {} };
          },
        } as any,
      );
      assert.equal(deniedStatus, 403);
      const token = oldPath.split('/').pop()!.replace('.mp3', '');
      assert.equal(
        JSON.stringify(await service.status()).includes(token),
        false,
        'status never exposes the bearer grant',
      );
      const response = await fetch(base + oldPath);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('icy-br'), '192');
      assert.equal(response.headers.get('content-length'), null);
      const reader = response.body!.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes < 32000) {
        const n = await reader.read();
        assert.equal(n.done, false);
        chunks.push(Buffer.from(n.value!));
        bytes += n.value!.length;
      }
      execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 'null', '-'],
        { input: Buffer.concat(chunks) },
      );
      await until(async () => (await service.status()).phase === 'streaming');
      const status = await service.status();
      assert.equal(status.audiblePlaybackVerified, false);
      assert.equal(status.encoder.bitrateKbps, 192);
      assert.ok(status.encoder.bufferedBytes < 40000);
      assert.ok(status.capture?.signalDetected);
      await reader.cancel();
      await service.reconnect({ ...profile, httpMode: 'chunked' });
      assert.equal((await fetch(base + oldPath)).status, 410);
      await until(async () => Boolean((await service.status()).coordinator));
      const newPath = new URL(s.room('MOCK_0').transportUri!.replace('x-rincon-mp3radio:', 'http:'))
        .pathname;
      assert.notEqual(newPath, oldPath);
      const resumed = await fetch(base + newPath);
      assert.equal(resumed.headers.get('transfer-encoding'), 'chunked');
      await resumed.body!.cancel();
      await service.stop();
      assert.equal((await service.status()).active, false);
      assert.equal(s.room('MOCK_0').state, 'STOPPED');
      assert.equal((await fetch(base + newPath)).status, 410);
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
test('capture denial and encoder absence are distinct failures; starting is serialized and cancellation cleans sessions', async () => {
  const s = fixture();
  let stopCount = 0;
  const denied = new NetworkStream(s, {
    openBrowser: async () => {},
    capture: async () => {
      throw new StreamError('CAPTURE_PERMISSION', 'Recording permission denied.');
    },
  });
  try {
    await denied.start(profile);
    await until(async () => (await denied.status()).phase === 'failed');
    assert.equal((await denied.status()).code, 'CAPTURE_PERMISSION');
  } finally {
    await denied.dispose();
  }
  const broken = new NetworkStream(s, {
    ...dependencies,
    capture: async (browser, _m, _p, onError) => {
      const c = startCapture(browser, true, undefined, undefined, onError);
      const stop = c.stop;
      return {
        ...c,
        stop: async () => {
          stopCount++;
          await stop();
        },
      };
    },
  });
  const old = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/missing/current-ffmpeg';
  try {
    const first = broken.start(profile);
    await assert.rejects(broken.start({ ...profile, roomIds: ['MOCK_2'] }), /already/);
    await first;
    await until(async () => (await broken.status()).phase === 'failed');
    assert.equal((await broken.status()).code, 'ENCODER_FAILED');
    assert.deepEqual((await streamProfiles.read()).roomIds, profile.roomIds);
    assert.ok(stopCount > 0);
  } finally {
    if (old === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = old;
    await broken.dispose();
  }
});
test('no speaker request produces a connection diagnostic, while another source interrupts capture without being stopped', async () => {
  const s = fixture(),
    service = new NetworkStream(s, { ...dependencies, pollMs: 30, connectTimeoutMs: 150 });
  try {
    await service.start(profile);
    await until(async () => (await service.status()).phase === 'failed');
    assert.equal((await service.status()).code, 'SONOS_NO_HTTP');
    await service.start(profile);
    await until(async () => Boolean((await service.status()).coordinator));
    await s.playUri('MOCK_0', {
      id: 'other',
      title: 'Other music',
      artist: 'Test',
      uri: 'https://example.com/music.mp3',
    });
    await until(async () => (await service.status()).phase === 'interrupted');
    assert.equal(s.room('MOCK_0').state, 'PLAYING');
    assert.equal(s.room('MOCK_0').track?.id, 'other');
  } finally {
    await service.dispose();
  }
});
test('PCM queue stays bounded across arbitrary byte boundaries, supplies silence without capture data, and stops its timer', async () => {
  const pcm = new PcmClock();
  const collected: Buffer[] = [];
  pcm.on('data', (b) => collected.push(b));
  pcm.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(collected.length);
  assert.ok(collected[0].every((v: number) => v === 0));
  const wave = Buffer.alloc(48000 * 8);
  for (let i = 0; i < wave.length; i += 4) wave.writeFloatLE(0.1, i);
  pcm.accept(wave.subarray(0, 3));
  pcm.accept(wave.subarray(3));
  assert.ok(pcm.stats().queuedBytes <= 192000);
  assert.ok(pcm.stats().droppedBytes > 0);
  pcm.stop();
  const n = collected.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(collected.length, n);
});
test('HTTP stream controls require pairing and strict input, and the main server serves only expiring private audio grants', async () => {
  process.env.PAIRING_CODE = 'network-test-only';
  await initPairing();
  const s = new Sonos(true);
  const { app, networkStream } = createApi(s);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = '';
  const post = (path: string, body: any) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/api/stream/start', profile)).status, 401);
    const auth = await post('/api/auth', { code: 'network-test-only' });
    cookie = auth.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (await post('/api/stream/start', { ...profile, command: 'anything' })).status,
      400,
    );
    assert.equal((await post('/api/stream/start', profile)).status, 202);
    await until(() => Boolean(s.room('MOCK_0').transportUri?.startsWith('x-rincon-mp3radio:')));
    assert.equal(
      (await (await fetch(base + '/api/stream', { headers: { Cookie: cookie } })).json()).mock,
      true,
    );
    const path = new URL(s.room('MOCK_0').transportUri!.replace('x-rincon-mp3radio:', 'http:'))
      .pathname;
    assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
    const pause = await post('/api/rooms/MOCK_0/control', { action: 'pause' });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json()).captureManaged, true);
    assert.equal((await networkStream.status()).active, false);
    assert.equal((await fetch(base + path)).status, 410);
  } finally {
    await networkStream.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
test('native protocol fixture distinguishes permission/errors and waits for helper exit on repeated stop', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const script = path.join(dir, 'fake-capture.cjs'),
    pidFile = path.join(dir, 'capture.pid');
  await writeFile(
    script,
    `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\nif(process.argv[2]==='com.apple.Safari'){process.stderr.write(JSON.stringify({event:'permission'})+'\\n');process.stderr.write(JSON.stringify({event:'error',code:'CAPTURE_PERMISSION'})+'\\n');setTimeout(()=>process.exit(2),20);}else{process.stderr.write(JSON.stringify({event:'ready'})+'\\n');const t=setInterval(()=>{process.stdout.write(Buffer.alloc(7680));process.stderr.write(JSON.stringify({event:'heartbeat'})+'\\n');},20);process.on('SIGTERM',()=>{clearInterval(t);setTimeout(()=>process.exit(0),50);});}\n`,
    { mode: 0o700 },
  );
  const phases: string[] = [],
    errors: string[] = [];
  const denied = startCapture(
    'safari',
    false,
    script,
    (p) => phases.push(p),
    (e) => errors.push(e.code),
  );
  await assert.rejects(denied.ready, /recording|Recording/);
  await denied.stop();
  assert.deepEqual(phases, ['permission']);
  assert.deepEqual(errors, ['CAPTURE_PERMISSION']);
  const helper = startCapture('chrome', false, script);
  await helper.ready;
  helper.pcm.resume();
  await until(() => Boolean(helper.pcm.stats().lastPcmAt));
  const pid = Number(await readFile(pidFile, 'utf8'));
  await Promise.all([helper.stop(), helper.stop()]);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(helper.pcm.destroyed, true);
});
test('stopping during encoder prebuffer cancels startup and never routes stale capture; UPnP failure preserves diagnostics', async () => {
  const s = fixture(),
    service = new NetworkStream(s, dependencies);
  try {
    await service.start({ ...profile, bufferSeconds: 3 });
    await until(async () => (await service.status()).phase === 'encoding');
    await service.stop();
    assert.equal((await service.status()).active, false);
    assert.ok(!s.room('MOCK_0').transportUri?.startsWith('x-rincon-mp3radio:'));
  } finally {
    await service.dispose();
  }
  const rejected = fixture();
  rejected.playUri = async () => {
    throw new Error('Sonos SetAVTransportURI failed (714)');
  };
  const fault = new NetworkStream(rejected, dependencies);
  try {
    await fault.start(profile);
    await until(async () => (await fault.status()).phase === 'failed');
    assert.equal((await fault.status()).code, 'SONOS_UPNP_714');
    assert.match((await fault.status()).message, /714/);
  } finally {
    await fault.dispose();
  }
});
