import { randomBytes, createHash } from 'node:crypto';
import { Store, diagnose } from './store';
import type { Track } from './types';
const API = 'https://api.soundcloud.com';
const TOKEN = 'https://secure.soundcloud.com/oauth/token';
type Tokens = { access_token: string; refresh_token: string; expires_at: number };
const tokens = new Store<Tokens | null>('soundcloud.json', null);
const pending = new Map<string, { verifier: string; session: string; expires: number }>();
let refreshing: Promise<Tokens> | undefined;
export function scConfigured() {
  return Boolean(
    process.env.SOUNDCLOUD_CLIENT_ID &&
    process.env.SOUNDCLOUD_CLIENT_SECRET &&
    process.env.SOUNDCLOUD_REDIRECT_URI,
  );
}
export async function scStatus() {
  const t = await tokens.read();
  return {
    configured: scConfigured(),
    connected: Boolean(t),
    redirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || '',
    gatewayConfigured: Boolean(process.env.PUBLIC_BASE_URL),
  };
}
function credentials() {
  if (!scConfigured())
    throw new Error(
      'Set SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, and SOUNDCLOUD_REDIRECT_URI in .env using an approved SoundCloud developer application.',
    );
  return {
    client_id: process.env.SOUNDCLOUD_CLIENT_ID!,
    client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET!,
  };
}
export function authorize(session: string) {
  const { client_id } = credentials();
  const state = randomBytes(24).toString('hex'),
    verifier = randomBytes(48).toString('base64url');
  for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
  if (pending.size > 100) throw new Error('Too many pending authorizations');
  pending.set(state, { verifier, session, expires: Date.now() + 600_000 });
  const url = new URL('https://secure.soundcloud.com/authorize');
  url.search = new URLSearchParams({
    client_id,
    redirect_uri: process.env.SOUNDCLOUD_REDIRECT_URI!,
    response_type: 'code',
    state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return url.href;
}
async function exchange(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ ...credentials(), ...body }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `SoundCloud authorization failed (${response.status}). Check app credentials and reconnect.`,
    );
  const value = await response.json();
  if (!value.access_token || !value.refresh_token || !Number.isFinite(Number(value.expires_in)))
    throw new Error('Invalid SoundCloud token response');
  const next = {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: Date.now() + Number(value.expires_in) * 1000,
  };
  await tokens.update(() => next);
  return next;
}
export async function callback(code: string, state: string, session: string) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < Date.now() || p.session !== session)
    throw new Error(
      'Invalid or expired OAuth state. Connect SoundCloud again from the same browser.',
    );
  await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: p.verifier,
    redirect_uri: process.env.SOUNDCLOUD_REDIRECT_URI!,
  });
}
async function accessToken() {
  const current = await tokens.read();
  if (!current) throw new Error('Connect SoundCloud in Settings first.');
  if (current.expires_at > Date.now() + 60_000) return current.access_token;
  refreshing ??= exchange({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  }).finally(() => {
    refreshing = undefined;
  });
  return (await refreshing).access_token;
}
export async function scApi(path: string) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `OAuth ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const hint =
      response.status === 401
        ? 'Reconnect SoundCloud; authorization has expired or was revoked.'
        : response.status === 403
          ? 'This account or developer application cannot access the requested content.'
          : response.status === 429
            ? 'SoundCloud rate limit reached. Wait before retrying.'
            : 'The SoundCloud API could not fulfill this request.';
    diagnose(
      'SoundCloud',
      String(response.status),
      hint,
      'Use the SoundCloud app or an authorized line-in source when API access is unavailable.',
    );
    throw new Error(`SoundCloud ${response.status}: ${hint}`);
  }
  return response.json();
}
export function mapTrack(v: any): Track {
  return {
    source: 'soundcloud',
    id: String(v.urn || v.id),
    title: String(v.title || 'Untitled'),
    artist: String(v.user?.username || ''),
    artwork: v.artwork_url || v.user?.avatar_url,
    duration: Number(v.duration || 0) / 1000,
    permalink: v.permalink_url,
    streamable: v.streamable === true,
    access: String(v.access || 'unknown'),
  };
}
export async function scBrowse(kind: string, query = '', cursor = '') {
  const pagination = cursor ? decodeCursor(cursor) : '';
  const endpoint =
    kind === 'likes' ? '/me/likes/tracks' : kind === 'playlists' ? '/me/playlists' : '/tracks';
  const result = await scApi(
    `${endpoint}?limit=40&linked_partitioning=true${pagination}${kind === 'search' ? `&q=${encodeURIComponent(query)}` : ''}`,
  );
  const values = Array.isArray(result) ? result : result.collection || [];
  let next = '';
  if (result.next_href) {
    try {
      const u = new URL(result.next_href);
      if (u.origin === API && u.pathname === endpoint) {
        const p = new URLSearchParams();
        for (const name of ['cursor', 'offset']) {
          const value = u.searchParams.get(name);
          if (value) p.set(name, value);
        }
        next = p.size ? Buffer.from(p.toString()).toString('base64url') : '';
      }
    } catch {}
  }
  return {
    items: values.map((v: any) =>
      kind === 'playlists'
        ? {
            id: String(v.urn || v.id),
            title: String(v.title),
            artist: String(v.user?.username || ''),
            artwork: v.artwork_url,
            count: v.track_count,
            playlist: true,
          }
        : mapTrack(v.track || v),
    ),
    next,
  };
}
export async function playlist(id: string) {
  const result = await scApi(
    `/playlists/${encodeURIComponent(id.startsWith('soundcloud:') ? id : `soundcloud:playlists:${id}`)}`,
  );
  return (result.tracks || []).map(mapTrack);
}
export function streamHost(url: URL) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    (url.hostname === 'api.soundcloud.com' ||
      url.hostname.endsWith('.sndcdn.com') ||
      url.hostname === 'sndcdn.com')
  );
}
export type ResolvedStream = { url: string; track: Track; format: 'progressive' | 'hls-mp3' };
export async function resolveMp3(id: string): Promise<ResolvedStream> {
  const urn = id.startsWith('soundcloud:') ? id : `soundcloud:tracks:${id}`;
  const raw = await scApi(`/tracks/${encodeURIComponent(urn)}?access=playable,preview,blocked`),
    track = mapTrack(raw);
  if (!track.streamable || track.access !== 'playable')
    throw new Error(
      'This track is blocked, preview-only, or unavailable for full API streaming. Use SoundCloud directly or line-in.',
    );
  const streams = await scApi(`/tracks/${encodeURIComponent(track.id)}/streams`);
  // Prefer full progressive MP3 if supplied. Modern responses generally offer HLS instead.
  const candidate = streams.http_mp3_128_url || streams.hls_mp3_128_url;
  if (!candidate) {
    diagnose(
      'SoundCloud',
      'NO_COMPATIBLE_MP3',
      `No full compatible MP3 stream for “${track.title}”`,
      'The API may offer AAC HLS or only previews. Use the existing Sonos service or SoundCloud through physical line-in.',
    );
    throw new Error(
      'No supported MP3 stream was returned. AAC HLS, previews, encrypted, and restricted streams are not converted. Use SoundCloud or line-in.',
    );
  }
  const url = new URL(candidate);
  if (!streamHost(url)) throw new Error('SoundCloud returned an unsupported media host.');
  return { url: url.href, track, format: streams.http_mp3_128_url ? 'progressive' : 'hls-mp3' };
}
function decodeCursor(cursor: string) {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error('Invalid pagination cursor');
  const params = new URLSearchParams(Buffer.from(cursor, 'base64url').toString());
  for (const key of params.keys())
    if (!['cursor', 'offset'].includes(key)) throw new Error('Invalid pagination cursor');
  return `&${params.toString()}`;
}
export function parseHls(body: string, base: string, duration: number): string[] {
  if (body.length > 1_000_000 || !body.trim().startsWith('#EXTM3U'))
    throw new Error('Invalid HLS playlist');
  if (/#EXT-X-(KEY|SESSION-KEY|BYTERANGE|MAP|STREAM-INF)/i.test(body))
    throw new Error('Encrypted, master, or non-MP3 HLS is unsupported; use line-in.');
  if (!body.includes('#EXT-X-ENDLIST'))
    throw new Error('Only finite, complete MP3 playlists are supported.');
  const total = [...body.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  if (!duration || total < duration - Math.max(2, duration * 0.02))
    throw new Error(
      'The API returned a snippet, not a verified full track. Use the official SoundCloud app or line-in.',
    );
  const segments = body
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => v && !v.startsWith('#'))
    .map((v) => new URL(v, base));
  if (!segments.length || segments.length > 2000 || segments.some((u) => !streamHost(u)))
    throw new Error('Unsupported HLS segment destination');
  return segments.map((u) => u.href);
}
export async function hlsSegments(source: ResolvedStream, signal?: AbortSignal) {
  const response = await fetchMedia(source.url, undefined, 'GET', signal, true);
  return parseHls(await response.text(), response.url || source.url, source.track.duration || 0);
}
export function mp3Segment(data: Uint8Array) {
  return (
    (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) ||
    (data[0] === 0xff &&
      (data[1] & 0xe0) === 0xe0 &&
      (data[1] & 0x06) !== 0 &&
      (data[2] & 0xc0) !== 0xc0)
  );
}
export async function fetchMedia(
  value: string,
  range?: string,
  method = 'GET',
  signal?: AbortSignal,
  playlist = false,
): Promise<Response> {
  let url = new URL(value);
  for (let hop = 0; hop < 5; hop++) {
    if (!streamHost(url)) throw new Error('Untrusted stream redirect blocked');
    const headers: Record<string, string> = {};
    if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
    if (url.hostname === 'api.soundcloud.com')
      headers.Authorization = `OAuth ${await accessToken()}`;
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      method,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Invalid stream redirect');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `SoundCloud audio request failed (${response.status}). The stream may have expired or playback may be restricted.`,
      );
    }
    const type = response.headers.get('content-type') || '';
    if (!playlist && !/audio\/(mpeg|mp3)|application\/octet-stream/i.test(type)) {
      await response.body?.cancel();
      throw new Error('SoundCloud did not return an MP3 audio stream');
    }
    return response;
  }
  throw new Error('Too many stream redirects');
}
export async function disconnect() {
  await tokens.update(() => null);
}
