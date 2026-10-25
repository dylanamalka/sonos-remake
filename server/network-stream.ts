import type { Request, Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Sonos, privateIPv4 } from './sonos';
import { Store, diagnose } from './store';
import { startCapture, StreamError, type Browser, type CaptureHandle } from './mac-capture';
import { LiveRadio } from './live-radio';
import { radioUri, radioMetadata } from './radio-uri';
import { routeNetworkRooms } from './group-routing';
export type StreamProfile = {
  browser: Browser;
  roomIds: string[];
  httpMode: 'close' | 'chunked';
  bufferSeconds: number;
};
const defaultProfile: StreamProfile = {
  browser: 'chrome',
  roomIds: [],
  httpMode: 'close',
  bufferSeconds: 2,
};
export const streamProfiles = new Store<StreamProfile>('network-stream.json', defaultProfile);
type Phase =
  | 'idle'
  | 'preparing'
  | 'permission'
  | 'encoding'
  | 'routing'
  | 'buffering'
  | 'streaming'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'failed';
type Session = {
  epoch: number;
  profile: StreamProfile;
  radio: LiveRadio;
  capture?: CaptureHandle;
  url: string;
  uri: string;
  coordinator?: string;
  routedAt?: number;
  startedAt: number;
  abort: AbortController;
};
export type StreamDependencies = {
  capture?: (
    browser: Browser,
    mock: boolean,
    onPhase: (phase: string) => void,
    onError: (error: StreamError) => void,
  ) => Promise<CaptureHandle>;
  openBrowser?: (browser: Browser) => Promise<void>;
  connectTimeoutMs?: number;
  pollMs?: number;
};
export function streamBase(sonos: Sonos) {
  let value = process.env.PUBLIC_BASE_URL;
  if (!value) {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal && a.family === 'IPv4' && privateIPv4(a.address))
      .map((a) => a!.address);
    const matched = addresses.filter((ip) =>
      [...sonos.rooms.values()].some(
        (r) => r.host.split('.').slice(0, 3).join('.') === ip.split('.').slice(0, 3).join('.'),
      ),
    );
    const candidates = [
      ...new Set(
        process.env.SONOS_INTERFACE
          ? [process.env.SONOS_INTERFACE]
          : matched.length
            ? matched
            : addresses,
      ),
    ];
    if (candidates.length === 1) value = `http://${candidates[0]}:${process.env.PORT || 3000}`;
    else if (sonos.mock) value = 'http://192.168.1.50:3000';
  }
  if (!value)
    throw new StreamError(
      'GATEWAY_ADDRESS',
      'Set PUBLIC_BASE_URL in .env to the Mac’s private IPv4 HTTP origin, e.g. http://YOUR_MAC_IP:3000. Speakers must reach that address.',
      422,
    );
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !privateIPv4(url.hostname) ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new StreamError(
      'GATEWAY_ADDRESS',
      'Stream from Mac requires a private IPv4 HTTP origin in PUBLIC_BASE_URL (older S1 devices may not trust local HTTPS).',
      422,
    );
  return url.origin;
}
async function nativeCapture(
  browser: Browser,
  mock: boolean,
  onPhase: (phase: string) => void,
  onError: (error: StreamError) => void,
) {
  if (mock) return startCapture(browser, true, undefined, onPhase, onError);
  if (process.platform !== 'darwin')
    throw new StreamError(
      'PLATFORM',
      'Native capture must run on your Mac mini, with macOS 13+. The cloud can test only synthetic audio.',
      422,
    );
  const binary = path.resolve(
    '.local/mac-capture/CurrentCapture.app/Contents/MacOS/CurrentCapture',
  );
  try {
    await access(binary);
    const digest = createHash('sha256')
      .update(
        Buffer.concat(
          await Promise.all(
            [
              'native/mac-audio/capture.swift',
              'native/mac-audio/BrowserFilter.h',
              'native/mac-audio/BrowserFilter.m',
            ].map((file) => readFile(file)),
          ),
        ),
      )
      .digest('hex');
    if ((await readFile('.local/mac-capture/source.sha256', 'utf8')).trim() !== digest)
      throw new Error('stale');
  } catch {
    throw new StreamError(
      'CAPTURE_BUILD',
      'Build or refresh the local native helper first: npm run capture:build. Apple Command Line Tools and the macOS SDK are required; no native binary is downloaded.',
      422,
    );
  }
  return startCapture(browser, false, binary, onPhase, onError);
}
export class NetworkStream {
  private epoch = 0;
  private session?: Session;
  private phase: Phase = 'idle';
  private message =
    'Select a room or group, then Stream from Mac. Capture never starts automatically.';
  private code = '';
  private task?: Promise<void>;
  private monitoring = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private starting = false;
  private lastMetrics: any = null;
  private closing?: Promise<void>;
  private ownedUris = new Set<string>();
  constructor(
    private sonos: Sonos,
    private deps: StreamDependencies = {},
  ) {}
  async status() {
    const profile = await streamProfiles.read(),
      s = this.session;
    const capture = s?.capture?.stats(),
      pcm = s?.capture?.pcm.stats(),
      encoder = s?.radio.stats();
    const signalAge = pcm?.lastSignalAt ? Date.now() - pcm.lastSignalAt : null;
    let gatewayOrigin: string | null = null;
    try {
      gatewayOrigin = s ? new URL(s.url).origin : streamBase(this.sonos);
    } catch {}
    return {
      gatewayOrigin,
      phase: this.phase,
      message: this.message,
      code: this.code,
      profile,
      mock: this.sonos.mock,
      nativePlatform: process.platform === 'darwin',
      active: Boolean(s),
      capture: capture
        ? { ...capture, ...pcm, signalDetected: signalAge !== null && signalAge < 5000 }
        : null,
      encoder: encoder ? { ...encoder, encoderPid: undefined } : this.lastMetrics,
      coordinator: s?.coordinator || null,
      startedAt: s?.startedAt || null,
      audiblePlaybackVerified: false,
      hardwareHttpObserved: !this.sonos.mock && Boolean(encoder?.writtenBytes),
      latency: {
        applicationBufferSeconds: s?.profile.bufferSeconds ?? profile.bufferSeconds,
        receiverDelaySeconds: null,
        description:
          'Receiver buffering and audible end-to-end delay require measurement on your S1 system.',
      },
    };
  }
  private isBusy() {
    return Boolean(
      this.starting || this.closing || this.session || this.phase === 'stopping' || this.task,
    );
  }
  private validate(profile: StreamProfile) {
    if (
      !profile.roomIds.length ||
      profile.roomIds.length > 100 ||
      new Set(profile.roomIds).size !== profile.roomIds.length
    )
      throw new StreamError(
        'ROOM_SELECTION',
        'Select at least one distinct destination room.',
        422,
      );
    for (const id of profile.roomIds) this.sonos.room(id);
  }
  async start(profile: StreamProfile) {
    if (this.disposed) throw new StreamError('SHUTDOWN', 'Controller is shutting down.', 409);
    if (this.isBusy())
      throw new StreamError(
        'SESSION_ACTIVE',
        'A stream is already starting or active. Stop it or choose Reconnect.',
        409,
      );
    this.validate(profile);
    const base = streamBase(this.sonos);
    const requestedAt = this.epoch;
    this.starting = true;
    try {
      await streamProfiles.update(() => profile);
    } finally {
      this.starting = false;
    }
    if (this.epoch !== requestedAt)
      throw new StreamError('CANCELLED', 'Stream start was cancelled.', 409);
    // Recheck after persistence; two browser requests may arrive together.
    if (this.session || this.phase === 'stopping' || this.task)
      throw new StreamError('SESSION_ACTIVE', 'A stream is already starting or active.', 409);
    const epoch = ++this.epoch;
    this.code = '';
    this.phase = 'preparing';
    this.message = 'Opening the selected browser and checking native capture…';
    const radio = new LiveRadio({
      bitrate: 192,
      bufferSeconds: profile.bufferSeconds,
      httpMode: profile.httpMode,
      maxClients: 2,
      onFailure: (message) => void this.fail(epoch, new StreamError('ENCODER_FAILED', message)),
    });
    const url = `${base}/live/${radio.token}.mp3`;
    const session: Session = {
      epoch,
      profile,
      radio,
      url,
      uri: radioUri(url),
      startedAt: Date.now(),
      abort: new AbortController(),
    };
    this.session = session;
    this.ownedUris.add(session.uri);
    this.ownedUris.add(session.url);
    while (this.ownedUris.size > 16) this.ownedUris.delete(this.ownedUris.values().next().value!);
    this.task = this.run(session)
      .catch((error) => this.fail(epoch, error))
      .finally(() => {
        if (this.session?.epoch === epoch || this.epoch === epoch) this.task = undefined;
      });
    return this.status();
  }
  private async run(s: Session) {
    const alive = () => this.session === s && s.epoch === this.epoch && !s.abort.signal.aborted;
    if (!this.sonos.mock) {
      if (process.platform !== 'darwin' && !this.deps.capture)
        throw new StreamError(
          'PLATFORM',
          'Run Current on the Mac mini. Native capture is unavailable on this machine.',
          422,
        );
      if (this.deps.openBrowser) await this.deps.openBrowser(s.profile.browser);
      else
        await promisify(execFile)(
          '/usr/bin/open',
          [
            '-a',
            s.profile.browser === 'chrome' ? 'Google Chrome' : 'Safari',
            'https://soundcloud.com',
          ],
          { timeout: 5000, signal: s.abort.signal },
        ).catch(() => {
          throw new StreamError(
            'BROWSER_LAUNCH',
            'The selected browser could not open. Install/open it on the Mac or choose Safari.',
            422,
          );
        });
    }
    if (!alive()) return;
    this.phase = 'permission';
    this.message =
      'Approve recording on the Mac if prompted. Only the selected browser application is captured.';
    s.capture = await (this.deps.capture || nativeCapture)(
      s.profile.browser,
      this.sonos.mock,
      () => {
        if (alive()) {
          this.phase = 'permission';
          this.message =
            'Grant recording permission on the Mac, then reconnect if macOS requests a restart.';
        }
      },
      (error) => void this.fail(s.epoch, error),
    );
    if (!alive()) {
      await s.capture.stop();
      return;
    }
    await s.capture.ready;
    if (!alive()) return;
    this.phase = 'encoding';
    this.message = 'Encoding continuous stereo MP3 at 192 kbps and filling the startup buffer…';
    await s.radio.start(s.capture.pcm, () => void s.capture?.stop());
    if (!alive()) return;
    this.phase = 'routing';
    this.message = 'Preparing the selected Sonos group…';
    s.coordinator = await routeNetworkRooms(
      this.sonos,
      s.profile.roomIds,
      (message) => {
        if (alive()) this.message = message;
      },
      () => !alive(),
    );
    if (!alive()) return;
    s.routedAt = Date.now();
    await this.sonos.playUri(s.coordinator, {
      id: 'current-live-radio',
      title: 'SoundCloud · Stream from Mac',
      artist: 'Live browser audio · track controls in SoundCloud',
      uri: s.uri,
      metadata: radioMetadata(s.url),
    });
    if (!alive()) {
      await this.stopOwned(s).catch(() => {});
      return;
    }
    s.routedAt = Date.now();
    this.phase = 'buffering';
    this.message = this.sonos.mock
      ? 'Synthetic MP3 is ready; simulated Sonos transport selected. No physical speaker has been tested.'
      : 'Radio transport selected. Waiting for the Sonos coordinator to request audio and fill its buffer…';
    this.timer = setInterval(() => void this.monitor(), this.deps.pollMs || 2000);
    this.timer.unref();
    await this.monitor();
  }
  controlsRoom(id: string) {
    const c = this.sonos.coordinator(id);
    return this.ownedUris.has(c.transportUri || c.track?.uri || '');
  }
  private owns(s: Session, uri?: string) {
    return uri === s.uri || uri === s.url;
  }
  private async monitor() {
    const s = this.session;
    if (!s || !s.routedAt || this.monitoring) return;
    this.monitoring = true;
    try {
      await this.sonos.refresh();
      if (this.session !== s) return;
      const stats = s.radio.stats();
      this.lastMetrics = { ...stats, encoderPid: undefined };
      if (stats.state === 'error') throw new StreamError('ENCODER_FAILED', stats.message);
      const c = this.sonos.rooms.get(s.coordinator!);
      if (!c?.online) {
        this.phase = 'buffering';
        this.message =
          'Sonos is offline. Capture remains active briefly while waiting for its HTTP reconnect.';
      } else if (
        c.coordinator !== c.id ||
        (!this.owns(s, c.transportUri || c.track?.uri) && c.state !== 'TRANSITIONING')
      ) {
        await this.interrupt(
          s,
          'Another controller changed the source or coordinator. Capture stopped; choose Reconnect deliberately.',
        );
        return;
      } else if (c.state === 'PAUSED_PLAYBACK' || c.state === 'STOPPED') {
        await this.interrupt(
          s,
          'Sonos stopped or paused the radio. Capture stopped. Choose Reconnect to start a fresh session.',
        );
        return;
      } else if (stats.clients > 0 && stats.writtenBytes > 0 && c.state === 'PLAYING') {
        this.phase = 'streaming';
        this.message = this.sonos.mock
          ? 'Synthetic MP3 is flowing to a test HTTP client. Sonos transport is simulated; audible playback is unverified.'
          : 'MP3 bytes are flowing to Sonos and transport reports PLAYING. Audible playback and receiver delay are not verified.';
      } else {
        this.phase = 'buffering';
        this.message = this.sonos.mock
          ? 'Encoder ready; simulated Sonos does not make a real HTTP request. No hardware success is claimed.'
          : 'Waiting for the Sonos HTTP reader; receiver may be buffering. Check Mac address, TCP port, and diagnostics.';
      }
      // Mock mode has no real renderer and must not fabricate a reader or fail just for that reason.
      if (!this.sonos.mock) {
        const last = stats.lastWriteAt || s.routedAt;
        if (Date.now() - last > (this.deps.connectTimeoutMs || 30000))
          throw new StreamError(
            stats.requests ? 'SONOS_NO_AUDIO' : 'SONOS_NO_HTTP',
            stats.requests
              ? 'Sonos contacted the stream but no active reader is consuming it. Try the alternate HTTP mode, check UPnP diagnostics, and reconnect.'
              : 'No Sonos HTTP request reached the Mac. Verify PUBLIC_BASE_URL, Wi-Fi/VLAN routing, and the Mac firewall TCP port. An accepted SOAP command does not prove stream compatibility.',
          );
      }
    } catch (error) {
      await this.fail(s.epoch, error);
    } finally {
      this.monitoring = false;
    }
  }
  handleAudio(req: Request, res: Response) {
    const s = this.session;
    if (!s || !s.routedAt || ['stopping', 'failed', 'interrupted'].includes(this.phase)) {
      res.writeHead(410).end('Stream session ended. Reconnect in Current.');
      return;
    }
    const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const hosts = s.profile.roomIds.map((id) => this.sonos.rooms.get(id)?.host);
    if (!(this.sonos.mock && ['127.0.0.1', '::1'].includes(peer)) && !hosts.includes(peer)) {
      res.writeHead(403).end('Only the selected Sonos rooms may read this private stream.');
      return;
    }
    s.radio.handle(req, res);
  }
  private async cleanup(s?: Session) {
    if (!s) {
      await this.closing;
      return;
    }
    clearInterval(this.timer);
    s.abort.abort();
    const cleanup = Promise.allSettled([s.radio.stop(), s.capture?.stop()]).then(() => {
      this.lastMetrics = { ...s.radio.stats(), encoderPid: undefined };
    });
    this.closing = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.closing === cleanup) this.closing = undefined;
    }
  }
  private async stopOwned(s?: Session) {
    if (!s?.coordinator) return;
    await this.sonos.refresh();
    const c = this.sonos.rooms.get(s.coordinator);
    if (c && this.owns(s, c.transportUri || c.track?.uri)) await this.sonos.control(c.id, 'stop');
  }
  private async interrupt(s: Session, message: string) {
    if (this.session !== s) return;
    ++this.epoch;
    this.session = undefined;
    this.phase = 'interrupted';
    this.message = message;
    this.code = 'PLAYBACK_INTERRUPTED';
    this.task = undefined;
    await this.cleanup(s);
    diagnose(
      'Mac stream',
      this.code,
      message,
      'Reconnect explicitly. Other playback is not taken over automatically.',
    );
  }
  private async fail(epoch: number, error: unknown) {
    if (epoch !== this.epoch) return;
    const detail = error instanceof Error ? error.message : 'Streaming failed.';
    const soap = detail.match(/Sonos .+ failed \((\d+)\)/);
    const e =
      error instanceof StreamError
        ? error
        : new StreamError(soap ? `SONOS_UPNP_${soap[1]}` : 'SONOS_OR_STREAM', detail);
    const s = this.session;
    ++this.epoch;
    this.session = undefined;
    this.phase = 'failed';
    this.code = e.code;
    this.message = e.message.replace(
      /(?:x-rincon-mp3radio:|https?:)\/\/\S+/g,
      '[private stream URL]',
    );
    this.task = undefined;
    diagnose(
      'Mac stream',
      this.code,
      this.message,
      'See the network streaming guide and reconnect after resolving the indicated cause.',
    );
    await this.cleanup(s);
    await this.stopOwned(s).catch(() => {});
  }
  async stop(control = true) {
    if (this.phase === 'stopping')
      throw new StreamError('SESSION_ACTIVE', 'A stream is already stopping.', 409);
    const s = this.session;
    const pending = this.task;
    ++this.epoch;
    this.session = undefined;
    this.phase = 'stopping';
    this.message = 'Stopping capture, encoder, and private stream readers…';
    this.task = undefined;
    await this.cleanup(s);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 7000);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    try {
      if (control) await this.stopOwned(s);
    } finally {
      this.phase = 'stopped';
      this.code = '';
      this.message =
        'Capture and encoder stopped. SoundCloud playback in the browser is not paused.';
    }
    return this.status();
  }
  async reconnect(profile?: StreamProfile) {
    await this.stop();
    return this.start(profile || (await streamProfiles.read()));
  }
  async dispose() {
    this.disposed = true;
    await this.stop(false);
  }
}
export type NetworkStreamStatus = Awaited<ReturnType<NetworkStream['status']>>;
