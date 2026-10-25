/** Experimental audio transport. Not enabled by the application or a proven S1 transport. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
export class Mp3Frames {
  private pending = Buffer.alloc(0);
  push(data: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, data]);
    const frames: Buffer[] = [];
    while (this.pending.length >= 4) {
      // Encoder is fixed to MPEG-1 Layer III, 128 kbps, 44.1 kHz. Reservoir is disabled.
      if (
        this.pending[0] !== 0xff ||
        (this.pending[1] & 0xfe) !== 0xfa ||
        (this.pending[2] & 0xfc) !== 0x90
      ) {
        this.pending = this.pending.subarray(1);
        continue;
      }
      const length = Math.floor((144 * 128000) / 44100) + ((this.pending[2] >> 1) & 1);
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
  private frames = new Mp3Frames();
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
    } = {},
  ) {}
  stats() {
    return {
      state: this.state,
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
        '128k',
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
          'Audio encoder exited. Restart the prototype after checking capture permissions.',
        );
    });
    input.once('error', () =>
      this.fail('Audio capture failed. Restart after checking macOS permissions.'),
    );
    input.once('end', () => {
      if (!['stopped', 'error'].includes(this.state))
        this.fail('Audio capture ended. This stream is no longer live.');
    });
    child.stdout.on('data', (data: Buffer) => {
      for (const frame of this.frames.push(data)) {
        this.lastFrame = Date.now();
        this.totalFrames++;
        this.ring.push(frame);
        if (this.ring.length > 40) this.ring.shift();
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
        if (this.state === 'streaming') {
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
    if (req.headers.range && req.headers.range !== 'bytes=0-') {
      res.writeHead(416).end('A live source is not seekable.');
      return;
    }
    if (this.clients.size >= (this.options.maxClients || 2)) {
      res.writeHead(503).end('Only the Sonos group coordinator should connect.');
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.options.httpMode !== 'chunked') {
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.flushHeaders();
    this.clients.add(res);
    res.once('close', () => this.clients.delete(res));
    res.on('error', () => this.clients.delete(res));
    for (const frame of this.ring) res.write(frame);
  }
  private fail(message: string) {
    if (this.state === 'stopped' || this.state === 'error') return;
    this.state = 'error';
    this.message = message;
    this.cleanup();
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
