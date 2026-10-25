import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { Sonos } from './sonos';
import { settings, diagnostics, diagnose } from './store';
import { hostGuard, login, requireAuth, session } from './security';
import * as sc from './soundcloud';
import { audio, grant, localMedia, mediaPath } from './gateway';
const trackSchema = z.object({
  source: z.enum(['local', 'soundcloud']).optional(),
  id: z.string().max(2048),
  title: z.string().max(500),
  artist: z.string().max(500),
  artwork: z.string().max(4096).optional(),
  uri: z.string().max(8192).optional(),
  metadata: z.string().max(32_000).optional(),
  duration: z.number().nonnegative().optional(),
  permalink: z.string().max(4096).optional(),
});
export function playbackUri(value: string) {
  if (
    /^(x-sonosapi-(stream|radio|hls)|x-sonos-spotify|x-sonos-http|x-rincon-cpcontainer):[^\s<>]+$/i.test(
      value,
    )
  )
    return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP(S) audio URL or an existing Sonos favorite.');
  return value;
}
const idSchema = z.string().regex(/^[\w:-]{1,200}$/);
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
export function createApi(sonos = new Sonos()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Current' }));
  app.post('/api/auth', login);
  app.all('/audio/:token', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.sendStatus(405);
      return;
    }
    audio(req, res).catch(next);
  });
  app.use('/api', requireAuth);
  app.get(
    '/api/state',
    wrap(async (_req, res) =>
      res.json({
        rooms: await sonos.refresh(),
        mock: sonos.mock,
        settings: await settings.read(),
        soundcloud: await sc.scStatus(),
      }),
    ),
  );
  app.post(
    '/api/discover',
    wrap(async (_req, res) => res.json({ rooms: await sonos.discover(), mock: sonos.mock })),
  );
  app.post(
    '/api/rooms/:id/control',
    wrap(async (req, res) => {
      const body = z
        .discriminatedUnion('action', [
          z.object({ action: z.enum(['play', 'pause', 'stop', 'next', 'previous']) }),
          z.object({ action: z.literal('volume'), value: z.number().int().min(0).max(100) }),
          z.object({ action: z.literal('mute'), value: z.boolean() }),
          z.object({ action: z.literal('seek'), value: z.number().int().min(0).max(86399) }),
        ])
        .parse(req.body);
      await sonos.control(
        idSchema.parse(req.params.id),
        body.action,
        'value' in body ? body.value : undefined,
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/rooms/:id/group',
    wrap(async (req, res) => {
      const body = z.object({ coordinator: idSchema.nullable() }).parse(req.body);
      await sonos.group(idSchema.parse(req.params.id), body.coordinator || undefined);
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/rooms/:id/queue',
    wrap(async (req, res) =>
      res.json({ items: await sonos.browse(idSchema.parse(req.params.id), 'Q:0'), limit: 200 }),
    ),
  );
  app.post(
    '/api/rooms/:id/queue',
    wrap(async (req, res) => {
      const body = z
        .discriminatedUnion('action', [
          z.object({
            action: z.literal('add'),
            track: trackSchema.extend({ uri: z.string().min(1) }),
          }),
          z.object({ action: z.enum(['play', 'remove']), index: z.number().int().min(0).max(199) }),
          z.object({ action: z.literal('clear') }),
        ])
        .parse(req.body);
      if ('track' in body) playbackUri(body.track.uri);
      await sonos.queue(idSchema.parse(req.params.id), body.action, {
        track: 'track' in body ? body.track : undefined,
        index: 'index' in body ? body.index : undefined,
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/rooms/:id/favorites',
    wrap(async (req, res) =>
      res.json({ items: await sonos.browse(idSchema.parse(req.params.id), 'FV:2') }),
    ),
  );
  app.post(
    '/api/rooms/:id/play',
    wrap(async (req, res) => {
      const track = trackSchema.extend({ uri: z.string().min(1) }).parse(req.body);
      playbackUri(track.uri);
      await sonos.playUri(idSchema.parse(req.params.id), track);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/rooms/:id/line-in',
    wrap(async (req, res) => {
      const body = z.object({ source: idSchema }).parse(req.body);
      const source = sonos.room(body.source);
      if (!source.lineIn) throw new Error('This device does not report a line-in source');
      await sonos.playUri(idSchema.parse(req.params.id), {
        id: 'line-in',
        title: `Line-in · ${source.name}`,
        artist: 'External audio input',
        uri: `x-rincon-stream:${source.id}`,
        metadata: '',
      });
      res.json({ ok: true });
    }),
  );
  app.put(
    '/api/settings',
    wrap(async (req, res) => {
      const patch = z
        .object({
          favorites: z.array(trackSchema).max(500).optional(),
          roomOrder: z.array(idSchema).max(100).optional(),
          hiddenRooms: z.array(idSchema).max(100).optional(),
        })
        .parse(req.body);
      res.json(await settings.update((current) => ({ ...current, ...patch })));
    }),
  );
  app.get('/api/diagnostics', (_req, res) =>
    res.json({
      events: diagnostics,
      capabilities: {
        discovery: 'SSDP / UDP 1900',
        control: 'UPnP SOAP / TCP 1400',
        soundcloud: 'Authorized full progressive MP3 only',
        gateway: 'Local HTTP MP3 / 44.1 kHz stereo for converted local files',
        mock: sonos.mock,
      },
    }),
  );
  app.get(
    '/api/soundcloud/connect',
    wrap(async (req, res) => res.redirect(sc.authorize(session(req)!))),
  );
  app.get(
    '/api/soundcloud/callback',
    wrap(async (req, res) => {
      const params = z
        .object({ code: z.string().min(1), state: z.string().min(1) })
        .parse(req.query);
      await sc.callback(params.code, params.state, session(req)!);
      res.redirect('/?connected=1');
    }),
  );
  app.post(
    '/api/soundcloud/disconnect',
    wrap(async (_req, res) => {
      await sc.disconnect();
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/soundcloud/browse',
    wrap(async (req, res) => {
      const query = z
        .object({
          kind: z.enum(['search', 'likes', 'playlists']).default('search'),
          q: z.string().max(300).default(''),
          cursor: z.string().max(2048).default(''),
        })
        .parse(req.query);
      res.json(await sc.scBrowse(query.kind, query.q, query.cursor));
    }),
  );
  app.get(
    '/api/soundcloud/playlists/:id',
    wrap(async (req, res) =>
      res.json({
        items: await sc.playlist(
          z
            .string()
            .regex(/^(soundcloud:playlists:)?\d+$/)
            .parse(req.params.id),
        ),
      }),
    ),
  );
  app.post(
    '/api/soundcloud/play',
    wrap(async (req, res) => {
      const body = z
        .object({
          room: idSchema,
          track: z.string().regex(/^(soundcloud:tracks:)?\d+$/),
          enqueue: z.boolean().default(false),
        })
        .parse(req.body);
      sonos.room(body.room);
      const resolved = await sc.resolveMp3(body.track);
      if (resolved.format === 'hls-mp3') {
        const { hlsSegments } = await import('./soundcloud');
        await hlsSegments(resolved);
      }
      const { track } = resolved;
      const uri = grant('soundcloud', body.track);
      if (body.enqueue) await sonos.queue(body.room, 'add', { track: { ...track, uri } });
      else await sonos.playUri(body.room, { ...track, uri });
      res.json({
        ok: true,
        method:
          resolved.format === 'progressive'
            ? 'Full MP3 passthrough'
            : 'Full unencrypted MP3 HLS segment relay',
        testedOnHardware: false,
      });
    }),
  );
  app.get(
    '/api/media',
    wrap(async (_req, res) => res.json({ items: await localMedia() })),
  );
  app.post(
    '/api/media/play',
    wrap(async (req, res) => {
      const body = z
        .object({ room: idSchema, file: z.string().max(255), enqueue: z.boolean().default(false) })
        .parse(req.body);
      sonos.room(body.room);
      await mediaPath(body.file);
      const track = {
        source: 'local' as const,
        id: body.file,
        title: body.file.replace(/\.[^.]+$/, ''),
        artist: 'Local library',
        uri: grant('local', body.file),
      };
      if (body.enqueue) await sonos.queue(body.room, 'add', { track });
      else await sonos.playUri(body.room, track);
      res.json({ ok: true });
    }),
  );
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof z.ZodError || err instanceof TypeError || err instanceof SyntaxError
        ? 400
        : 502;
    const message =
      err instanceof z.ZodError
        ? 'Invalid request. Check the supplied fields and values.'
        : String(err.message || 'Request failed').replace(/https?:\/\/\S+/g, '[URL omitted]');
    diagnose(
      'Controller',
      String(status),
      `${req.method} ${req.path.split('/').slice(0, 3).join('/')}: ${message}`,
      'Review configuration and the troubleshooting guide.',
    );
    if (!res.headersSent) res.status(status).json({ error: message });
  });
  return { app, sonos };
}
