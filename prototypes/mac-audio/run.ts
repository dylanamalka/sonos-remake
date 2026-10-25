import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LiveRadio } from './radio';
import { privateIPv4 } from '../../server/sonos';
const synthetic = process.argv.includes('--synthetic');
const lan = process.argv.includes('--lan');
const safari = process.argv.includes('--safari');
const port = Number(process.env.PROTOTYPE_PORT || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PROTOTYPE_PORT');
if (!synthetic && process.platform !== 'darwin')
  throw new Error('ScreenCaptureKit requires macOS. Use --synthetic for a transport-only test.');
let advertised = new URL(`http://127.0.0.1:${port}`);
if (lan) {
  const base = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost');
  if (base.protocol !== 'http:' || !privateIPv4(base.hostname) || base.username || base.password)
    throw new Error('--lan requires PUBLIC_BASE_URL with this Mac’s private IPv4 HTTP origin.');
  advertised = new URL(`http://${base.hostname}:${port}`);
}
const producer = synthetic
  ? spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-ac',
        '2',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
  : spawn(
      path.resolve('.local/mac-capture/CurrentCapture.app/Contents/MacOS/CurrentCapture'),
      [safari ? 'com.apple.Safari' : 'com.google.Chrome'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
const radio = new LiveRadio({
  httpMode: process.env.PROTOTYPE_HTTP_MODE === 'chunked' ? 'chunked' : 'close',
});
const server = createServer((req, res) => {
  const expected = [advertised.host, `127.0.0.1:${port}`, `localhost:${port}`];
  if (!expected.includes(req.headers.host || '') || req.headers.origin) {
    res.writeHead(403).end();
    return;
  }
  radio.handle(req, res);
});
let exiting = false;
async function stop(failed = false) {
  if (exiting) return;
  exiting = true;
  producer.kill('SIGTERM');
  const kill = setTimeout(() => producer.kill('SIGKILL'), 1500);
  kill.unref();
  await radio.stop();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
producer.stderr.on('data', () => {}); // Native errors are summarized without dumping process output.
producer.on('error', () => {
  console.error('Capture executable unavailable. Build the helper first, or use --synthetic.');
  void stop(true);
});
producer.on('close', () => {
  if (!exiting) {
    console.error('Capture ended. Verify browser availability and macOS permission, then restart.');
    void stop(true);
  }
});
server.on('error', () => {
  console.error('Prototype port unavailable.');
  void stop(true);
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  await radio.start(producer.stdout, () => producer.kill('SIGTERM'));
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(
      `EXPERIMENTAL ${synthetic ? 'SYNTHETIC TONE — not captured SoundCloud' : 'BROWSER AUDIO — ScreenCaptureKit'}\nPrivate bearer stream (do not share): ${advertised.origin}/live/${radio.token}.mp3\nNo Sonos playback has been verified. Use only the group coordinator. Stop with Ctrl-C.`,
    );
  });
} catch {
  console.error(
    'No encoded audio became ready. Check FFmpeg, browser, display, and capture permission.',
  );
  await stop(true);
}
