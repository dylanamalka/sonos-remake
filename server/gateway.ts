import { randomBytes } from 'node:crypto';
import { readdir, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import type { Request, Response } from 'express';
import { dataDir, diagnose } from './store';
import { fetchMedia, resolveMp3, hlsSegments, mp3Segment } from './soundcloud';
import { gatewayBase } from './security';
const grants = new Map<string, { kind: 'soundcloud' | 'local'; id: string; expires: number }>();
let activeStreams = 0;
export const mediaDir = path.join(dataDir, 'media');
export function grant(kind: 'soundcloud' | 'local', id: string) {
  for (const [key, value] of grants) if (value.expires < Date.now()) grants.delete(key);
  if (grants.size > 1000) throw new Error('Too many active streams; restart to clear old grants.');
  const base = gatewayBase(),
    token = randomBytes(32).toString('hex');
  grants.set(token, { kind, id, expires: Date.now() + 24 * 3600_000 });
  return `${base}/audio/${token}.mp3`;
}
export async function localMedia() {
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  return (await readdir(mediaDir, { withFileTypes: true }))
    .filter((f) => f.isFile() && /\.(mp3|m4a|aac|flac|wav|aiff|ogg|opus)$/i.test(f.name))
    .map((f) => ({
      source: 'local' as const,
      id: f.name,
      title: f.name.replace(/\.[^.]+$/, ''),
      artist: 'Local library · your authorized files',
    }));
}
export async function mediaPath(id: string) {
  if (path.basename(id) !== id || !(await localMedia()).some((f) => f.id === id))
    throw new Error('Local audio file not found');
  return path.join(mediaDir, id);
}
export async function audio(req: Request, res: Response) {
  const token = String(req.params.token).replace(/\.mp3$/, ''),
    source = grants.get(token);
  if (!source || source.expires < Date.now()) {
    res.status(410).end('Stream expired. Start playback again.');
    return;
  }
  if (activeStreams >= 16) {
    res.status(503).end('Gateway is busy. Try again shortly.');
    return;
  }
  activeStreams++;
  const abort = new AbortController();
  res.once('close', () => {
    activeStreams--;
    abort.abort();
  });
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    if (source.kind === 'soundcloud') {
      const resolved = await resolveMp3(source.id);
      if (resolved.format === 'hls-mp3') {
        const segments = await hlsSegments(resolved, abort.signal);
        res.type('audio/mpeg');
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        for (const segment of segments) {
          if (abort.signal.aborted) break;
          const part = await fetchMedia(segment, undefined, 'GET', abort.signal);
          if (Number(part.headers.get('content-length')) > 8_000_000)
            throw new Error('Oversized MP3 segment');
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of part.body as any) {
            size += chunk.length;
            if (size > 8_000_000) {
              await part.body?.cancel().catch(() => {});
              throw new Error('Oversized MP3 segment');
            }
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (!mp3Segment(bytes))
            throw new Error(
              'HLS segment is not plain MP3; conversion is not permitted by this gateway.',
            );
          if (!res.write(bytes)) await once(res, 'drain', { signal: abort.signal });
        }
        res.end();
        return;
      }
      const upstream = await fetchMedia(resolved.url, req.headers.range, req.method, abort.signal);
      res.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
        const v = upstream.headers.get(header);
        if (v) res.setHeader(header, v);
      }
      if (req.method === 'HEAD') {
        await upstream.body?.cancel();
        res.end();
      } else if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body as any);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } else res.end();
    } else {
      const file = await mediaPath(source.id);
      res.type('audio/mpeg');
      if (/\.mp3$/i.test(file)) {
        const info = await stat(file);
        if (!info.size) {
          res.status(422).end('Empty audio file');
          return;
        }
        let start = 0,
          end = info.size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) {
            res.status(416).end();
            return;
          }
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(Number(match[2]), end);
          }
          if (start > end || start >= info.size) {
            res.setHeader('Content-Range', `bytes */${info.size}`);
            res.status(416).end();
            return;
          }
          res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') res.end();
        else {
          const stream = createReadStream(file, { start, end });
          res.on('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          stream.pipe(res);
        }
      } else {
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        // Local files only. Never transcode SoundCloud, encrypted, or restricted streams.
        const child = spawn(
          process.env.FFMPEG_PATH || 'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            file,
            '-vn',
            '-ar',
            '44100',
            '-ac',
            '2',
            '-codec:a',
            'libmp3lame',
            '-b:a',
            '192k',
            '-f',
            'mp3',
            'pipe:1',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.pipe(res);
        child.stderr.resume();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        child.stdout.once('data', () => clearTimeout(timer));
        child.on('error', () => {
          clearTimeout(timer);
          if (!res.headersSent)
            res
              .status(503)
              .end('FFmpeg is required for this local file. Install with brew install ffmpeg.');
          else res.destroy();
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code && !abort.signal.aborted)
            diagnose(
              'Gateway',
              'TRANSCODE',
              'Local audio conversion failed',
              'Check that FFmpeg can decode this unencrypted file.',
            );
          if (!res.writableEnded) res.end();
        });
        res.on('close', () => child.kill('SIGTERM'));
      }
    }
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message.replace(/https?:\/\/\S+/g, '[URL omitted]')
        : 'Unknown error';
    diagnose(
      'Gateway',
      'STREAM_FAILED',
      `Audio gateway: ${reason}`,
      'Check SoundCloud authorization, stream eligibility, PUBLIC_BASE_URL, and speaker access to this Mac.',
    );
    if (!res.headersSent) res.status(502).end('Audio unavailable. Check diagnostics.');
    else res.destroy();
  }
}
