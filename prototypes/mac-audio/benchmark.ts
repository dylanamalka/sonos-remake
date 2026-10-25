/** Opt-in synthetic Linux/Mac transport exercise, not a SoundCloud/Sonos acceptance test. */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { LiveRadio } from './radio';
const seconds = Number(process.env.BENCH_SECONDS || 30);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120)
  throw new Error('BENCH_SECONDS must be 5–120');
const producer = spawn(
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
);
producer.stderr.resume();
producer.on('error', () => console.error('Synthetic PCM producer could not start.'));
const radio = new LiveRadio();
const server = createServer((req, res) => radio.handle(req, res));
let peakParentRss = process.memoryUsage().rss,
  peakEncoderRss = 0,
  encoderCpu = 0;
const timer = setInterval(() => {
  peakParentRss = Math.max(peakParentRss, process.memoryUsage().rss);
  const pid = radio.stats().encoderPid;
  if (pid) {
    try {
      const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .map(Number);
      peakEncoderRss = Math.max(peakEncoderRss, rss * 1024);
      encoderCpu = cpu;
    } catch {}
  }
}, 1000);
let bytes = 0,
  reconnects = 0;
const started = Date.now(),
  cpu = process.cpuUsage();
try {
  await radio.start(producer.stdout, () => producer.kill('SIGTERM'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/live/${radio.token}.mp3`;
  for (let part = 0; part < 3; part++) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP radio unavailable');
    const reader = response.body!.getReader();
    while (Date.now() - started < (seconds * 1000 * (part + 1)) / 3) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Stream ended before the synthetic exercise completed');
      bytes += value!.length;
    }
    await reader.cancel();
    if (part < 2) {
      reconnects++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const usage = process.cpuUsage(cpu);
  console.log(
    JSON.stringify(
      {
        source: 'synthetic 440 Hz PCM, not SoundCloud capture',
        hardwareVerified: false,
        durationSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
        bytesReceived: bytes,
        reconnects,
        framesEncoded: radio.stats().frames,
        retainedAudioBytes: radio.stats().bufferedBytes,
        peakParentRssBytes: peakParentRss,
        peakEncoderRssBytes: peakEncoderRss,
        encoderAverageCpuPercent: encoderCpu,
        parentCpuMs: Math.round((usage.user + usage.system) / 1000),
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(timer);
  producer.kill('SIGTERM');
  await radio.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
