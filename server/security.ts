import type { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { Store } from './store';
import { privateIPv4 } from './sonos';
const pairing = new Store<{ code?: string }>('pairing.json', {});
const sessions = new Map<string, number>();
const attempts = new Map<string, { count: number; until: number }>();
let code = '';
export async function initPairing() {
  code =
    process.env.PAIRING_CODE ||
    (await pairing.read()).code ||
    randomBytes(12).toString('base64url');
  if (!process.env.PAIRING_CODE) await pairing.update(() => ({ code }));
  return code;
}
export function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function session(req: Request) {
  const value = cookie(req, 'sonos_session');
  if (!value || (sessions.get(value) || 0) < Date.now()) {
    if (value) sessions.delete(value);
    return undefined;
  }
  return value;
}
export function hostGuard(req: Request, res: Response, next: NextFunction) {
  let hostname: string;
  try {
    hostname = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    res.status(400).json({ error: 'Invalid host' });
    return;
  }
  const configured = process.env.PUBLIC_BASE_URL
    ? new URL(process.env.PUBLIC_BASE_URL).hostname
    : '';
  const valid =
    [
      'localhost',
      '127.0.0.1',
      '[::1]',
      os.hostname().toLowerCase(),
      `${os.hostname().toLowerCase()}.local`,
      configured,
    ].includes(hostname.toLowerCase()) || privateIPv4(hostname);
  if (!valid) {
    res.status(403).json({ error: 'Use localhost or the Mac LAN address' });
    return;
  }
  if (
    req.headers.origin &&
    req.headers.origin !== `http://${req.headers.host}` &&
    req.headers.origin !== `https://${req.headers.host}`
  ) {
    res.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
export function login(req: Request, res: Response) {
  const key = req.socket.remoteAddress || 'unknown';
  let attempt = attempts.get(key);
  if (!attempt || attempt.until < Date.now()) {
    attempt = { count: 0, until: Date.now() + 60_000 };
    attempts.set(key, attempt);
  }
  if (++attempt.count > 10) {
    res.status(429).json({ error: 'Too many attempts. Wait one minute.' });
    return;
  }
  const supplied = typeof req.body?.code === 'string' ? req.body.code : '';
  if (
    !code ||
    !timingSafeEqual(
      createHash('sha256').update(code).digest(),
      createHash('sha256').update(supplied).digest(),
    )
  ) {
    res.status(401).json({ error: 'Incorrect pairing code' });
    return;
  }
  const token = randomBytes(32).toString('hex');
  for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
  sessions.set(token, Date.now() + 30 * 86400_000);
  res.cookie('sonos_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 30 * 86400_000,
    path: '/',
  });
  res.json({ ok: true });
}
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!session(req)) {
    res.status(401).json({ error: 'Pair this device using the code in your Mac terminal.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}
export function gatewayBase(): string {
  const value = process.env.PUBLIC_BASE_URL;
  if (!value)
    throw new Error(
      'Set PUBLIC_BASE_URL to this Mac’s LAN URL so speakers can reach the audio gateway.',
    );
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error(
      'PUBLIC_BASE_URL must be a reachable LAN origin, such as http://192.168.1.50:3000',
    );
  return url.origin;
}
