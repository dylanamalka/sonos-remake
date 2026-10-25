'use client';
import { useEffect, useState } from 'react';
import {
  Radio,
  Play,
  Square,
  RefreshCw,
  Speaker,
  MonitorSpeaker,
  ShieldCheck,
  ChevronDown,
  LoaderCircle,
  Volume2,
} from 'lucide-react';
import type { Room } from '../server/types';
import type { NetworkStreamStatus, StreamProfile } from '../server/network-stream';
async function request(path: string, profile?: StreamProfile) {
  const res = await fetch(`/api/stream/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Stream request failed');
  return data;
}
export default function MacNetworkStream({
  status,
  rooms,
  selectedRoomId,
  onSelectRoom,
  run,
  busy,
}: {
  status?: NetworkStreamStatus;
  rooms: Room[];
  selectedRoomId: string;
  onSelectRoom: (id: string) => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
}) {
  const [browser, setBrowser] = useState<'chrome' | 'safari'>('chrome'),
    [ids, setIds] = useState<string[]>([]),
    [mode, setMode] = useState<'close' | 'chunked'>('close'),
    [buffer, setBuffer] = useState(2),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!status || editing) return;
    setBrowser(status.profile.browser);
    setMode(status.profile.httpMode);
    setBuffer(status.profile.bufferSeconds);
    const selected = rooms.find((r) => r.id === selectedRoomId);
    setIds(
      status.profile.roomIds.length
        ? status.profile.roomIds
        : rooms.filter((r) => selected && r.coordinator === selected.coordinator).map((r) => r.id),
    );
  }, [status, rooms, selectedRoomId, editing]);
  const profile: StreamProfile = { browser, roomIds: ids, httpMode: mode, bufferSeconds: buffer };
  const starting = ['preparing', 'permission', 'encoding', 'routing', 'stopping'].includes(
    status?.phase || '',
  );
  const active = Boolean(status?.active);
  const launch = (reconnect: boolean) =>
    run(async () => {
      const result = await request(reconnect ? 'reconnect' : 'start', profile);
      setEditing(false);
      if (result.profile.roomIds[0]) onSelectRoom(result.profile.roomIds[0]);
    }, 'Starting the private Mac stream. Watch capture and connection status below.');
  const labels: Record<string, string> = {
    idle: 'Ready when you are',
    preparing: 'Preparing the Mac',
    permission: 'Check recording permission on the Mac',
    encoding: 'Encoding and filling the audio buffer',
    routing: 'Connecting your Sonos group',
    buffering: 'Waiting for the Sonos audio reader',
    streaming: 'Audio bytes are flowing',
    stopping: 'Stopping capture and stream',
    stopped: 'Capture stopped',
    interrupted: 'Playback interrupted',
    failed: 'Stream needs attention',
  };
  return (
    <section
      className="sc-listening network-listening"
      aria-label="Network-only SoundCloud playback"
    >
      <div className="listening-intro">
        <div className="listening-logo">
          <Radio size={34} />
        </div>
        <div>
          <span className="eyebrow orange">BROWSER AUDIO. OVER YOUR EXISTING NETWORK.</span>
          <h2>Stream from Mac</h2>
          <p>
            Play SoundCloud normally in {browser === 'chrome' ? 'Chrome' : 'Safari'}. Current
            captures only that browser’s application audio and sends a private MP3 radio stream to
            your Sonos rooms. No cables, new hardware, or developer keys.
          </p>
        </div>
        <span className="pill">LAN · 192 kbps MP3</span>
      </div>
      {status?.mock && (
        <div className="demo-banner">
          <MonitorSpeaker size={16} />
          Demo uses a synthetic tone and simulated Sonos. No Mac browser is captured; hardware
          playback is unverified.
        </div>
      )}
      <div className={`listening-status phase-${status?.phase}`} role="status">
        <span className={`status-dot ${status?.phase === 'streaming' ? 'online' : ''}`} />
        <div>
          <b>{labels[status?.phase || 'idle']}</b>
          <p>{status?.message || 'Loading stream status…'}</p>
          {status?.code && <small>Diagnostic: {status.code}</small>}
          {active && status?.capture && !status.capture.signalDetected && (
            <p className="signal-note">
              The stream is keeping alive with silence. Start a track in the selected browser;
              protected or unavailable audio is not bypassed.
            </p>
          )}
        </div>
      </div>
      <div className="listening-actions">
        <button
          className="primary orange-button"
          disabled={busy || starting || !ids.length || (!status?.mock && !status?.nativePlatform)}
          onClick={() =>
            void launch(
              active || ['failed', 'interrupted', 'stopped'].includes(status?.phase || ''),
            )
          }
        >
          {starting ? (
            <LoaderCircle className="spin" size={17} />
          ) : active ? (
            <RefreshCw size={17} />
          ) : (
            <Play size={17} />
          )}{' '}
          {active || ['failed', 'interrupted'].includes(status?.phase || '')
            ? 'Reconnect stream'
            : 'Stream from Mac'}
        </button>
        <button
          className="secondary"
          disabled={busy || (!active && !starting)}
          onClick={() =>
            void run(
              () => request('stop'),
              'Capture, encoder, and private stream stopped. The SoundCloud website is not paused.',
            )
          }
        >
          <Square size={16} />
          Stop stream
        </button>
      </div>
      <div className="stream-readouts">
        <div>
          <small>CAPTURE</small>
          <b>
            {status?.capture?.ready
              ? status.capture.signalDetected
                ? status.mock
                  ? 'Synthetic signal detected'
                  : 'Browser signal detected'
                : 'Ready · browser silent'
              : active
                ? 'Starting…'
                : 'Off'}
          </b>
        </div>
        <div>
          <small>ENCODER</small>
          <b>
            {status?.encoder?.frames
              ? `${status.encoder.frames.toLocaleString()} MP3 frames`
              : '44.1 kHz · stereo'}
          </b>
        </div>
        <div>
          <small>HTTP READERS</small>
          <b>
            {status?.encoder?.clients || 0}
            {status?.mock ? ' · simulated devices' : ''}
          </b>
        </div>
        <div>
          <small>DELAY</small>
          <b>{buffer}s app buffer + Sonos buffering</b>
        </div>
      </div>
      <div className="network-configuration">
        <div className="listening-source">
          <label htmlFor="capture-browser">Browser on the Mac</label>
          <select
            id="capture-browser"
            aria-label="Captured browser"
            disabled={busy || starting}
            value={browser}
            onChange={(e) => {
              setEditing(true);
              setBrowser(e.target.value as 'chrome' | 'safari');
            }}
          >
            <option value="chrome">Google Chrome</option>
            <option value="safari">Safari</option>
          </select>
          <p className="small muted">
            Capture includes all audio from this browser application, not just one tab or profile.
            Use an otherwise-idle browser. SoundCloud login, search, track selection, and queue stay
            on the Mac.
          </p>
          <p className="small muted">
            Current’s iPhone interface controls destinations and the stream session; it does not
            remotely automate the SoundCloud website.
          </p>
        </div>
        <fieldset className="listening-targets">
          <legend>Destination rooms</legend>
          {rooms.map((r) => (
            <label key={r.id}>
              <Speaker size={17} />
              <span>
                {r.name}
                {!r.online && <small>Offline</small>}
              </span>
              <input
                type="checkbox"
                aria-label={`Stream to ${r.name}`}
                checked={ids.includes(r.id)}
                disabled={busy || starting || !r.online}
                onChange={(e) => {
                  setEditing(true);
                  setIds((current) =>
                    e.target.checked ? [...current, r.id] : current.filter((id) => id !== r.id),
                  );
                }}
              />
            </label>
          ))}
          {!rooms.length && <p>Discover your Sonos devices first.</p>}
        </fieldset>
      </div>
      <details className="listening-help">
        <summary>First-time Mac setup & recording permission</summary>
        <p>
          Requires macOS 13+, FFmpeg, and a locally built ScreenCaptureKit helper. Update the
          existing checkout, then run:
        </p>
        <pre>
          <code>brew install ffmpeg{'\n'}npm run capture:build</code>
        </pre>
        <p>
          If Apple Command Line Tools are missing, run <code>xcode-select --install</code> once and
          finish its macOS installation before building. Nothing is installed on the Sonos devices.
        </p>
        <p>
          Click Stream from Mac, then approve Screen Recording / Screen & System Audio Recording on
          the Mac for Current Audio Capture or its terminal launcher. If macOS asks for a restart,
          restart Current and reconnect. Capture begins only after your explicit start, and does not
          resume automatically after a controller restart.
        </p>
        <p>
          Keep the Mac awake, its graphical login session available, and the chosen browser running.
          ScreenCaptureKit may need a display available in that session; a headless-session failure
          is reported explicitly. No virtual driver or private permission API is used. Protected
          content may be silent; no DRM or playback restrictions are bypassed.
        </p>
        <p>
          Speakers need to reach the Mac’s HTTP port. Automatic LAN address selection is used when
          unambiguous; otherwise set <code>PUBLIC_BASE_URL=http://YOUR_MAC_LAN_IP:3000</code> in
          .env. Allow Node in the Mac firewall; keep this port private to your home network.
          Detected gateway: <code>{status?.gatewayOrigin || 'not resolved yet'}</code>.
        </p>
      </details>
      <details className="listening-help">
        <summary>Buffering, reconnection & advanced transport</summary>
        <p>
          Sonos radio buffering adds an unknown receiver delay. This is not AirPlay and no real-time
          latency is promised. Stream status confirms capture/encoding/HTTP/transport observations,
          not audible output. Source changes by another controller stop capture instead of
          automatically taking over playback.
        </p>
        <div className="network-configuration">
          <div className="listening-source">
            <label htmlFor="radio-http-mode">HTTP delivery</label>
            <select
              id="radio-http-mode"
              aria-label="Radio HTTP delivery"
              disabled={busy || starting}
              value={mode}
              onChange={(e) => {
                setEditing(true);
                setMode(e.target.value as 'close' | 'chunked');
              }}
            >
              <option value="close">Connection-close · default</option>
              <option value="chunked">Chunked HTTP/1.1 · compatibility test</option>
            </select>
          </div>
          <div className="listening-source">
            <label htmlFor="radio-buffer">Startup / reconnect prebuffer</label>
            <select
              id="radio-buffer"
              aria-label="Radio buffer"
              disabled={busy || starting}
              value={buffer}
              onChange={(e) => {
                setEditing(true);
                setBuffer(Number(e.target.value));
              }}
            >
              {[1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n} seconds
                </option>
              ))}
            </select>
          </div>
        </div>
        <p>
          Changing these settings applies on the next start/reconnect. A reconnect stops the old
          capture, revokes its URL, and starts a fresh session. HTTP reader reconnects within an
          active session begin at a recent MP3 frame. No seeking, fake file length, or unbounded
          media cache is used.
        </p>
        <p>
          SOAP errors, missing HTTP readers, unsupported ranges, capture/encoder failures, and
          silence are separate observations in status and Diagnostics. Try the alternate HTTP mode
          only when actual S1 behavior warrants it. No successful hardware playback is claimed from
          mock tests.
        </p>
      </details>
      <div className="info-note">
        <ShieldCheck size={18} />
        <p>
          Only the selected browser is captured. No SoundCloud media URLs, cookies, credentials, or
          DRM keys are extracted. Capture is visible in this session and stops with Stop stream or
          controller shutdown.
        </p>
      </div>
    </section>
  );
}
