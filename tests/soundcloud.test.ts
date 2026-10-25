import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(os.tmpdir(), 'current-sc-'));
process.env.SONOS_DATA_DIR = dir;
process.env.SOUNDCLOUD_CLIENT_ID = 'test-client';
process.env.SOUNDCLOUD_CLIENT_SECRET = 'test-secret';
process.env.SOUNDCLOUD_REDIRECT_URI = 'http://localhost:3000/api/soundcloud/callback';
const sc = await import('../server/soundcloud');
const original = global.fetch;
test('OAuth PKCE binds callback state to session, persists tokens, handles URNs and cursor paging, refuses restricted playback', async () => {
  try {
    const url = new URL(sc.authorize('session-a'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    await assert.rejects(
      sc.callback('code', url.searchParams.get('state')!, 'wrong-session'),
      /state/,
    );
    const second = new URL(sc.authorize('session-a'));
    let tokenRequests = 0;
    global.fetch = async (input, init) => {
      const u = String(input);
      if (u.includes('oauth/token')) {
        tokenRequests++;
        assert.match(String(init?.body), /code_verifier=/);
        return Response.json({
          access_token: 'mock-access',
          refresh_token: 'mock-refresh',
          expires_in: 3600,
        });
      }
      assert.equal((init?.headers as Record<string, string>).Authorization, 'OAuth mock-access');
      if (u.includes('/streams'))
        return Response.json({ preview_mp3_128_url: 'https://cf-media.sndcdn.com/preview.mp3' });
      if (u.includes('/tracks/soundcloud%3Atracks%3A123'))
        return Response.json({
          urn: 'soundcloud:tracks:123',
          title: 'Allowed track',
          streamable: true,
          access: 'playable',
          duration: 120000,
        });
      return Response.json({
        collection: [
          { urn: 'soundcloud:tracks:123', title: 'Test', streamable: true, access: 'playable' },
        ],
        next_href: 'https://api.soundcloud.com/tracks?cursor=opaque%2Bcursor',
      });
    };
    await sc.callback('test-code', second.searchParams.get('state')!, 'session-a');
    assert.equal(tokenRequests, 1);
    assert.equal((await sc.scStatus()).connected, true);
    const tracks = await sc.scBrowse('search', 'dj edit');
    assert.equal(tracks.items[0].id, 'soundcloud:tracks:123');
    assert.ok(tracks.next);
    const page = await sc.scBrowse('search', 'dj edit', tracks.next);
    assert.equal(page.items.length, 1);
    await assert.rejects(sc.resolveMp3('soundcloud:tracks:123'), /No supported MP3/);
    global.fetch = async () =>
      Response.json({ urn: 'soundcloud:tracks:123', streamable: true, access: 'preview' });
    await assert.rejects(sc.resolveMp3('123'), /preview-only/);
    await sc.disconnect();
    assert.equal((await sc.scStatus()).connected, false);
  } finally {
    global.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});
test('HLS accepts a complete unencrypted MP3 playlist and refuses snippets, keys, master lists, and private destinations', () => {
  const playlist =
    '#EXTM3U\n#EXTINF:60,\nhttps://cf-media.sndcdn.com/one.mp3\n#EXTINF:60,\nhttps://cf-media.sndcdn.com/two.mp3\n#EXT-X-ENDLIST';
  assert.equal(sc.parseHls(playlist, 'https://api.soundcloud.com/streams/a', 120).length, 2);
  assert.throws(
    () => sc.parseHls(playlist, 'https://api.soundcloud.com/streams/a', 240),
    /snippet/,
  );
  for (const directive of [
    '#EXT-X-KEY:METHOD=AES-128,URI="key"',
    '#EXT-X-MAP:URI="init"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000',
  ])
    assert.throws(
      () => sc.parseHls(playlist + '\n' + directive, 'https://api.soundcloud.com/a', 120),
      /unsupported/,
    );
  assert.throws(
    () =>
      sc.parseHls(
        playlist.replace('https://cf-media.sndcdn.com/one.mp3', 'http://192.168.1.1/private'),
        'https://api.soundcloud.com/a',
        120,
      ),
    /destination/,
  );
  assert.equal(sc.mp3Segment(Uint8Array.from([0x49, 0x44, 0x33])), true);
  assert.equal(sc.mp3Segment(Uint8Array.from([0xff, 0xfb, 0x90])), true);
  assert.equal(sc.mp3Segment(Uint8Array.from([0x47, 0x40, 0x00])), false);
});
test('stream host allowlist rejects credentials, spoofed suffixes and insecure URLs', () => {
  for (const v of [
    'http://cf-media.sndcdn.com/a',
    'https://sndcdn.com.attacker.com/a',
    'https://user:pass@api.soundcloud.com/a',
    'https://127.0.0.1/a',
    'https://cf-media.sndcdn.com:8443/a',
  ])
    assert.equal(sc.streamHost(new URL(v)), false);
  assert.equal(sc.streamHost(new URL('https://cf-media.sndcdn.com/a')), true);
});
