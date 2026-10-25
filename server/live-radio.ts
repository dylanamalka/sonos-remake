/** Continuous MP3 radio transport. Audible Sonos firmware compatibility requires LAN testing. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
export class Mp3Frames {
  private pending = Buffer.alloc(0);
  constructor(private bitrate: 128 | 192 = 192) {}
  push(data: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, data]);
    const frames: Buffer[] = [];
    while (this.pending.length >= 4) {
      // Encoder is fixed to MPEG-1 Layer III, 128/192 kbps, 44.1 kHz. Reservoir is disabled.
      if (
        this.pending[0] !== 0xff ||
        (this.pending[1] & 0xfe) !== 0xfa ||
        (this.pending[2] & 0xfc) !== (this.bitrate === 192 ? 0xb0 : 0x90)
      ) {
        this.pending = this.pending.subarray(1);
        continue;
      }
      const length = Math.floor((144 * this.bitrate * 1000) / 44100) + ((this.pending[2] >> 1) & 1);
      if (this.pending.length < length) break;
      frames.push(Buffer.from(this.pending.subarray(0, length)));
      this.pending = this.pending.subarray(length);
    }
    return frames;
  }
  get bufferedBytes() {
    return this.pending.length;
  }
}
export class LiveRadio {
  readonly token = randomBytes(32).toString('hex');
  private encoder?: ChildProcessWithoutNullStreams;
  private clients = new Set<ServerResponse>();
  private ring: Buffer[] = [];
  private frames: Mp3Frames;
  private ringLimit: number;
  private writtenBytes = 0;
  private requests = 0;
  private rejectedRanges = 0;
  private headRequests = 0;
  private probeRequests = 0;
  private lastRequestAt: number | null = null;
  private lastWriteAt: number | null = null;
  private onFailure?: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private input?: Readable;
  private totalFrames = 0;
  private stopInput?: () => void;
  private state: 'idle' | 'starting' | 'streaming' | 'stopped' | 'error' = 'idle';
  private message = '';
  private exit?: Promise<void>;
  constructor(
    private options: {
      ffmpeg?: string;
      httpMode?: 'close' | 'chunked';
      maxClients?: number;
      stallMs?: number;
      bitrate?: 128 | 192;
      bufferSeconds?: number;
      onFailure?: (message: string) => void;
    } = {},
  ) {
    if (
      options.bufferSeconds !== undefined &&
      (!Number.isFinite(options.bufferSeconds) ||
        options.bufferSeconds < 0.1 ||
        options.bufferSeconds > 5)
    )
      throw new Error('Buffer must be between 0.1 and 5 seconds');
    this.frames = new Mp3Frames(options.bitrate || 192);
    this.ringLimit = Math.ceil(((options.bufferSeconds ?? 2) * 44100) / 1152);
    this.onFailure = options.onFailure;
  }
  stats() {
    return {
      state: this.state,
      bitrateKbps: this.options.bitrate || 192,
      bufferedSeconds: (this.ring.length * 1152) / 44100,
      writtenBytes: this.writtenBytes,
      requests: this.requests,
      rejectedRanges: this.rejectedRanges,
      headRequests: this.headRequests,
      probeRequests: this.probeRequests,
      httpMode: this.options.httpMode || 'close',
      lastRequestAt: this.lastRequestAt,
      lastWriteAt: this.lastWriteAt,
      encoderPid: this.encoder?.pid,
      message: this.message,
      clients: this.clients.size,
      frames: this.totalFrames,
      bufferedFrames: this.ring.length,
      bufferedBytes: this.ring.reduce((n, b) => n + b.length, 0) + this.frames.bufferedBytes,
    };
  }
  async start(input: Readable, stopInput?: () => void) {
    if (this.state !== 'idle')
      throw new Error('Create a fresh radio instance for each capture session.');
    this.state = 'starting';
    this.input = input;
    this.stopInput = stopInput;
    this.lastFrame = Date.now();
    const child = spawn(
      this.options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'f32le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-i',
        'pipe:0',
        '-vn',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        `${this.options.bitrate || 192}k`,
        '-reservoir',
        '0',
        '-write_xing',
        '0',
        '-id3v2_version',
        '0',
        '-flush_packets',
        '1',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.encoder = child;
    this.exit = new Promise((resolve) => child.once('close', () => resolve()));
    child.stderr.resume();
    child.stdin.on('error', () => {
      if (!['stopped', 'error'].includes(this.state))
        this.fail('Encoder input closed. Capture has stopped.');
    });
    child.once('error', () =>
      this.fail('FFmpeg could not start. Check its installation and permissions.'),
    );
    child.once('close', () => {
      if (!['stopped', 'error'].includes(this.state))
        this.fail(
          'Audio encoder exited. Check encoder/capture diagnostics and restart Stream from Mac.',
        );
    });
    input.once('error', () =>
      this.fail('Audio capture failed. Restart after checking macOS permissions.'),
    );
    input.once('end', () => {
      if (!['stopped', 'error'].includes(this.state))
        this.fail('Audio capture ended. This stream is no longer live.');
    });
    child.stdout.on('error', () => this.fail('Encoder output failed.'));
    child.stdout.on('data', (data: Buffer) => {
      if (this.state === 'stopped' || this.state === 'error') return;
      for (const frame of this.frames.push(data)) {
        this.lastFrame = Date.now();
        this.totalFrames++;
        this.ring.push(frame);
        if (this.ring.length > this.ringLimit) this.ring.shift();
        this.state = 'streaming';
        for (const res of this.clients) {
          if (res.destroyed || res.writableEnded) {
            this.clients.delete(res);
            continue;
          }
          if (res.writableLength > 128 * 1024) {
            this.clients.delete(res);
            res.destroy();
            continue;
          }
          res.write(frame);
          this.writtenBytes += frame.length;
          this.lastWriteAt = Date.now();
        }
      }
    });
    input.pipe(child.stdin);
    this.timer = setInterval(() => {
      if (Date.now() - this.lastFrame > (this.options.stallMs || 5000))
        this.fail('No PCM/MP3 frames arrived. Capture may be stalled, blocked, or revoked.');
    }, 250);
    this.timer.unref();
    // Readiness means real encoded audio bytes, never merely a PID or open port.
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (this.state === 'streaming' && this.ring.length >= this.ringLimit) {
          clearInterval(check);
          resolve();
        } else if (this.state === 'error' || this.state === 'stopped') {
          clearInterval(check);
          reject(new Error(this.message || 'Capture stopped'));
        }
      }, 20);
    });
  }
  handle(req: IncomingMessage, res: ServerResponse) {
    const value = new URL(req.url || '/', 'http://localhost').pathname.match(
      /^\/live\/([a-f0-9]{64})\.mp3$/,
    )?.[1];
    if (!value || !timingSafeEqual(Buffer.from(value), Buffer.from(this.token))) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (this.state !== 'streaming') {
      res.writeHead(503, { 'Retry-After': '2' }).end('Capture is not streaming.');
      return;
    }
    this.requests++;
    this.lastRequestAt = Date.now();
    if (req.method === 'HEAD') this.headRequests++;
    const probe = /^bytes=0-(\d{1,5})$/.exec(req.headers.range || '');
    if (req.headers.range && req.headers.range !== 'bytes=0-' && !probe) {
      this.rejectedRanges++;
      res.writeHead(416).end('A live source is not seekable.');
      return;
    }
    if (!probe && req.method !== 'HEAD' && this.clients.size >= (this.options.maxClients || 2)) {
      res.writeHead(503).end('Only the Sonos group coordinator should connect.');
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('icy-name', 'Current · Stream from Mac'.replace('·', '-'));
    res.setHeader('icy-br', String(this.options.bitrate || 192));
    res.setHeader('icy-pub', '0');
    res.setHeader('icy-description', 'Private local browser audio');
    res.setHeader('icy-genre', 'Local audio');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.options.httpMode !== 'chunked') {
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');
    }
    if (probe) {
      const snapshot = Buffer.concat(this.ring);
      const length = Math.min(Number(probe[1]) + 1, snapshot.length, 65536);
      if (!length) {
        res.writeHead(503).end();
        return;
      }
      this.probeRequests++;
      res.statusCode = 206;
      res.setHeader('Content-Length', length);
      res.setHeader('Content-Range', `bytes 0-${length - 1}/*`);
      res.end(req.method === 'HEAD' ? undefined : snapshot.subarray(0, length));
      return;
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.flushHeaders();
    this.clients.add(res);
    res.once('close', () => this.clients.delete(res));
    res.on('error', () => this.clients.delete(res));
    for (const frame of this.ring) {
      res.write(frame);
      this.writtenBytes += frame.length;
      this.lastWriteAt = Date.now();
    }
  }
  private fail(message: string) {
    if (this.state === 'stopped' || this.state === 'error') return;
    this.state = 'error';
    this.message = message;
    this.cleanup();
    this.onFailure?.(message);
  }
  private cleanup() {
    clearInterval(this.timer);
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.ring = [];
    this.input?.unpipe();
    this.stopInput?.();
    this.encoder?.stdin.destroy();
    this.encoder?.kill('SIGTERM');
  }
  async stop() {
    if (this.state !== 'error') this.state = 'stopped';
    this.cleanup();
    const child = this.encoder;
    if (this.exit && child) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      timer.unref();
      await this.exit;
      clearTimeout(timer);
    }
  }
}
