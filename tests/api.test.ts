import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const dir = await mkdtemp(path.join(os.tmpdir(), 'current-api-'));
process.env.SONOS_DATA_DIR = dir;
process.env.PAIRING_CODE = 'test-pairing-password';
process.env.PUBLIC_BASE_URL = 'http://192.168.1.50:3000';
const { createApi } = await import('../server/api');
const { Sonos } = await import('../server/sonos');
const { initPairing } = await import('../server/security');
const { localMedia, mediaDir } = await import('../server/gateway');
test('HTTP controller enforces pairing and origin checks, validates commands, persists favorites, groups rooms, and streams local MP3 ranges', async () => {
  const originalFetch = global.fetch;
  await initPairing();
  const sonos = new Sonos(true),
    { app } = createApi(sonos);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(
    p: string,
    body?: unknown,
    method?: string,
    headers: Record<string, string> = {},
  ) {
    return fetch(base + p, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    assert.equal((await request('/api/state')).status, 401);
    assert.equal((await request('/api/listening')).status, 401);
    assert.equal((await request('/api/listening/connect', {})).status, 401);
    assert.equal((await request('/api/auth', { code: 'incorrect' })).status, 401);
    const auth = await request('/api/auth', { code: process.env.PAIRING_CODE });
    assert.equal(auth.status, 200);
    cookie = auth.headers.get('set-cookie')!.split(';')[0];
    assert.match(auth.headers.get('set-cookie')!, /HttpOnly/i);
    assert.equal(
      (await request('/api/state', undefined, undefined, { Origin: 'https://attacker.example' }))
        .status,
      403,
    );
    const hostileHost = await new Promise<number>((resolve) => {
      const req = http.get(
        base + '/api/state',
        { headers: { Host: 'attacker.example', Cookie: cookie } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', () => resolve(0));
    });
    assert.equal(hostileHost, 403);
    assert.equal((await (await request('/api/discover', {})).json()).rooms.length, 3);
    assert.equal(
      (await request('/api/rooms/MOCK_0/control', { action: 'volume', value: 101 })).status,
      400,
    );
    assert.equal(
      (await request('/api/rooms/MOCK_0/control', { action: 'volume', value: 40 })).status,
      200,
    );
    assert.equal(sonos.room('MOCK_0').volume, 40);
    await request('/api/rooms/MOCK_1/group', { coordinator: 'MOCK_0' });
    assert.equal(sonos.room('MOCK_1').coordinator, 'MOCK_0');
    await request('/api/rooms/MOCK_1/control', { action: 'pause' });
    assert.equal(sonos.room('MOCK_0').state, 'PAUSED_PLAYBACK');
    const track = {
      id: 'favorite',
      title: 'Your station',
      artist: 'Test',
      uri: 'https://example.com/music.mp3',
    };
    await request('/api/settings', { favorites: [track] }, 'PUT');
    const state = await (await request('/api/state')).json();
    assert.equal(state.settings.favorites[0].title, track.title);
    assert.equal((await stat(path.join(dir, 'settings.json'))).mode & 0o777, 0o600);
    await request('/api/rooms/MOCK_0/queue', { action: 'add', track });
    assert.equal((await (await request('/api/rooms/MOCK_0/queue')).json()).items.length, 3);
    await request('/api/rooms/MOCK_0/line-in', { source: 'MOCK_2' });
    assert.equal(sonos.room('MOCK_0').track?.uri, 'x-rincon-stream:MOCK_2');
    await localMedia();
    await writeFile(path.join(mediaDir, 'owned.mp3'), Buffer.from('ID3test-audio-file'));
    assert.equal((await (await request('/api/media')).json()).items[0].source, 'local');
    assert.equal(
      (await request('/api/media/play', { room: 'MOCK_0', file: '../settings.json' })).status,
      502,
    );
    assert.equal(
      (await request('/api/media/play', { room: 'MOCK_0', file: 'owned.mp3' })).status,
      200,
    );
    const url = new URL(sonos.room('MOCK_0').track!.uri!);
    // Speakers have no browser cookie. The high-entropy, expiring stream grant authorizes this path.
    const response = await fetch(base + url.pathname, { headers: { Range: 'bytes=0-2' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'ID3');
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/18');
    assert.equal(
      (await fetch(base + url.pathname, { method: 'HEAD' })).headers.get('content-length'),
      '18',
    );
    assert.equal((await fetch(base + '/audio/unknown.mp3')).status, 410);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.25',
      '-y',
      path.join(mediaDir, 'owned.wav'),
    ]);
    await request('/api/media/play', { room: 'MOCK_0', file: 'owned.wav' });
    const converted = await fetch(base + new URL(sonos.room('MOCK_0').track!.uri!).pathname);
    assert.equal(converted.status, 200);
    assert.equal(converted.headers.get('content-type'), 'audio/mpeg');
    assert.ok((await converted.arrayBuffer()).byteLength > 1000);
    assert.equal(
      (
        await request(
          '/api/listening',
          { sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_1', 'MOCK_2'] },
          'PUT',
        )
      ).status,
      200,
    );
    const listening = await (await request('/api/listening/connect', {})).json();
    assert.equal(listening.phase, 'input-selected');
    assert.equal(listening.audiblePlaybackVerified, false);
    assert.equal((await (await request('/api/listening/open', {})).json()).simulated, true);
    assert.equal(
      (
        await request(
          '/api/listening',
          { sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_1'], url: 'https://attacker.example' },
          'PUT',
        )
      ).status,
      400,
    );
    assert.equal((await request('/api/listening/stop', {})).status, 200);
    await writeFile(
      path.join(dir, 'soundcloud.json'),
      JSON.stringify({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
      }),
    );
    let format = 'progressive';
    global.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.hostname === 'api.soundcloud.com') {
        assert.equal(headers?.Authorization, 'OAuth test-access');
        if (url.pathname.endsWith('/streams'))
          return Response.json(
            format === 'progressive'
              ? { http_mp3_128_url: 'https://media.sndcdn.com/full.mp3' }
              : { hls_mp3_128_url: 'https://media.sndcdn.com/full.m3u8' },
          );
        return Response.json({
          urn: 'soundcloud:tracks:123',
          title: 'Authorized full track',
          streamable: true,
          access: 'playable',
          duration: 120000,
        });
      }
      if (url.hostname === 'media.sndcdn.com') {
        assert.equal(
          headers?.Authorization,
          undefined,
          'OAuth must never be forwarded to CDN hosts',
        );
        if (url.pathname.endsWith('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXTINF:60,\nhttps://media.sndcdn.com/one.mp3\n#EXTINF:60,\nhttps://media.sndcdn.com/two.mp3\n#EXT-X-ENDLIST' +
              (format === 'encrypted' ? '\n#EXT-X-KEY:METHOD=AES-128' : ''),
            { headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
          );
        return new Response(
          url.pathname === '/full.mp3'
            ? 'ID3full'
            : url.pathname.includes('one')
              ? 'ID3one'
              : 'ID3two',
          { headers: { 'content-type': 'audio/mpeg' } },
        );
      }
      return originalFetch(input, init);
    };
    assert.equal(
      (await request('/api/soundcloud/play', { room: 'MOCK_0', track: 'soundcloud:tracks:123' }))
        .status,
      200,
    );
    let scAudio = await originalFetch(base + new URL(sonos.room('MOCK_0').track!.uri!).pathname);
    assert.equal(await scAudio.text(), 'ID3full');
    format = 'hls';
    assert.equal(
      (await request('/api/soundcloud/play', { room: 'MOCK_0', track: 'soundcloud:tracks:123' }))
        .status,
      200,
    );
    scAudio = await originalFetch(base + new URL(sonos.room('MOCK_0').track!.uri!).pathname);
    assert.equal(await scAudio.text(), 'ID3oneID3two');
    format = 'encrypted';
    const refused = await request('/api/soundcloud/play', {
      room: 'MOCK_0',
      track: 'soundcloud:tracks:123',
    });
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error, /unsupported/);
    assert.ok((await (await request('/api/diagnostics')).json()).events.length > 0);
  } finally {
    global.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
