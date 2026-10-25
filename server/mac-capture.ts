import { spawn, type ChildProcess } from 'node:child_process';
import { PcmClock } from './pcm-clock';
export type Browser = 'chrome' | 'safari';
export type CaptureHandle = {
  pcm: PcmClock;
  ready: Promise<void>;
  stop: () => Promise<void>;
  stats: () => { ready: boolean; lastHeartbeatAt: number | null; mock: boolean };
};
export class StreamError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}
export const captureErrors: Record<string, string> = {
  CAPTURE_EXECUTABLE:
    'The native helper could not launch. Refresh its local build/signature with npm run capture:build on the Mac.',
  CAPTURE_PROTOCOL:
    'The native helper returned an invalid control stream. Rebuild it from the matching source checkout.',
  CAPTURE_PERMISSION:
    'Grant Screen & System Audio Recording / Screen Recording permission on the Mac to Current Audio Capture or its launcher. Restart Current if macOS requests it, then reconnect.',
  DISPLAY_UNAVAILABLE:
    'ScreenCaptureKit found no display in the Mac login session. Unlock the existing Mac session or use its existing Screen Sharing session, then retry. No headless capture success is claimed.',
  BROWSER_MISSING: 'Open the selected browser on the Mac, then retry Stream from Mac.',
  CAPTURE_FORMAT:
    'ScreenCaptureKit returned an unsupported PCM format. Capture was stopped rather than encoding invalid audio.',
  CAPTURE_STOPPED:
    'macOS ended audio capture. Permission may have changed or the login session/display may be unavailable. Reconnect explicitly after fixing it.',
  CAPTURE_START_FAILED:
    'ScreenCaptureKit could not start. Check macOS recording permission, the selected browser, and the active login session.',
  MACOS_VERSION: 'ScreenCaptureKit audio requires macOS 13 or newer.',
};
export function startCapture(
  browser: Browser,
  mock: boolean,
  binary?: string,
  onPhase?: (phase: string) => void,
  onError?: (error: StreamError) => void,
): CaptureHandle {
  const pcm = new PcmClock(mock);
  let stopTask: Promise<void> | undefined;
  let ready = false,
    lastHeartbeatAt: number | null = null,
    closed = false,
    child: ChildProcess | undefined,
    watch: ReturnType<typeof setInterval> | undefined;
  let resolve!: () => void, reject!: (e: Error) => void;
  const readiness = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  readiness.catch(() => {}); // An early native exit can precede the caller receiving the handle.
  const fail = (code: string) => {
    if (closed) return;
    const error = new StreamError(
      code,
      captureErrors[code] ||
        'Native audio capture stopped unexpectedly. Check recording permission and reconnect.',
    );
    reject(error);
    onError?.(error);
    void stop();
  };
  const stop = () => {
    if (stopTask) return stopTask;
    stopTask = (async () => {
      if (closed) return;
      closed = true;
      clearInterval(watch);
      pcm.stop();
      reject(new StreamError('CANCELLED', 'Capture stopped.'));
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child!.once('close', () => done()));
        child.kill('SIGTERM');
        const force = setTimeout(() => child?.kill('SIGKILL'), 1500);
        force.unref();
        await exited;
        clearTimeout(force);
      }
    })();
    return stopTask;
  };
  if (mock) {
    ready = true;
    lastHeartbeatAt = Date.now();
    pcm.start();
    resolve();
  } else {
    if (!binary)
      throw new StreamError('CAPTURE_BUILD', 'Build the native capture helper before starting.');
    child = spawn(binary, [browser === 'chrome' ? 'com.google.Chrome' : 'com.apple.Safari'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (data: Buffer) => pcm.accept(data));
    child.stdout!.on('error', () => fail('CAPTURE_STOPPED'));
    let pending = '';
    child.stderr!.on('data', (data: Buffer) => {
      pending += data.toString();
      if (pending.length > 8192) {
        fail('CAPTURE_PROTOCOL');
        return;
      }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === 'permission') onPhase?.('permission');
        if (event.event === 'ready') {
          ready = true;
          lastHeartbeatAt = Date.now();
          pcm.start();
          resolve();
        }
        if (event.event === 'heartbeat') lastHeartbeatAt = Date.now();
        if (event.event === 'error')
          fail(typeof event.code === 'string' ? event.code : 'CAPTURE_START_FAILED');
      }
    });
    child.on('error', () => fail('CAPTURE_EXECUTABLE'));
    child.on('close', () => {
      if (!closed) fail('CAPTURE_STOPPED');
    });
    const launched = Date.now();
    watch = setInterval(() => {
      if (!ready && Date.now() - launched > 60000) fail('CAPTURE_PERMISSION');
      else if (ready && lastHeartbeatAt && Date.now() - lastHeartbeatAt > 15000)
        fail('CAPTURE_STOPPED');
    }, 1000);
    watch.unref();
  }
  return { pcm, ready: readiness, stop, stats: () => ({ ready, lastHeartbeatAt, mock }) };
}
