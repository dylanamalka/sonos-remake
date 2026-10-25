'use client';
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Cloud,
  ExternalLink,
  LoaderCircle,
  MonitorSpeaker,
  Play,
  RefreshCw,
  Settings2,
  Speaker,
  Square,
  Unplug,
  Volume2,
} from 'lucide-react';
import type { Room } from '../server/types';
import type { ListeningProfile, ListeningStatus } from '../server/listening';
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`/api/listening${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to update listening source');
  return data;
}
export default function SoundCloudListening({
  status,
  rooms,
  selectedRoomId,
  onSelectRoom,
  run,
  busy,
}: {
  status?: ListeningStatus;
  rooms: Room[];
  selectedRoomId: string;
  onSelectRoom: (id: string) => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
}) {
  const [source, setSource] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [configure, setConfigure] = useState(false);
  // Keep edits local while configuring, but reflect saved profiles after a reload or another controller update.
  useEffect(() => {
    if (configure || !status) return;
    setSource(
      status.profile.sourceRoomId ||
        status.sources.find((s) => s.online && s.connected === true)?.id ||
        (status.sources.length === 1 ? status.sources[0].id : ''),
    );
    setTargets(
      status.profile.targetRoomIds.length
        ? status.profile.targetRoomIds
        : rooms
            .filter(
              (r) => r.coordinator === rooms.find((x) => x.id === selectedRoomId)?.coordinator,
            )
            .map((r) => r.id),
    );
  }, [status, configure, rooms, selectedRoomId]);
  const configured = Boolean(status?.profile.sourceRoomId && status.profile.targetRoomIds.length);
  const profile: ListeningProfile = { sourceRoomId: source || null, targetRoomIds: targets };
  const save = () =>
    run(async () => {
      await request('', profile, 'PUT');
      setConfigure(false);
    }, 'Listening setup saved');
  const connect = () =>
    run(async () => {
      if (!configured || configure) await request('', profile, 'PUT');
      const result = await request('/connect');
      if (result.profile.targetRoomIds[0]) onSelectRoom(result.profile.targetRoomIds[0]);
      setConfigure(false);
    }, 'Sonos input selected. Start your music on the Mac.');
  const pending = busy || status?.phase === 'routing';
  const chosenSource = rooms.find((r) => r.id === status?.profile.sourceRoomId);
  return (
    <section className="sc-listening" aria-label="SoundCloud without API credentials">
      <div className="listening-intro">
        <div className="listening-logo">
          <Cloud size={35} />
        </div>
        <div>
          <span className="eyebrow orange">YOUR ACCOUNT. THE OFFICIAL PLAYER.</span>
          <h2>SoundCloud, through your Mac.</h2>
          <p>
            Play your Likes, playlists, and discoveries on the SoundCloud website. Current sends
            your Mac’s wired audio to the rooms you choose. No developer keys.
          </p>
        </div>
        <span className="pill">Recommended · line-in</span>
      </div>
      <div className={`listening-status phase-${status?.phase || 'needs-setup'}`} role="status">
        <span className={`status-dot ${status?.phase === 'input-selected' ? 'online' : ''}`} />
        <div>
          <b>
            {
              (
                {
                  'needs-setup': 'One cable. Then just listen.',
                  ready: 'Ready to listen',
                  'input-selected': 'Sonos input selected',
                  'input-paused': 'Sonos input paused',
                  offline: 'A room needs attention',
                  'no-cable': 'Check your RCA connection',
                  'route-changed': 'Your room routing changed',
                  error: 'Unable to connect',
                  routing: 'Connecting your rooms…',
                } as Record<string, string>
              )[status?.phase || 'needs-setup']
            }
          </b>
          <p>{status?.message || 'Loading source status…'}</p>
          {status?.mock && (
            <small>
              Simulated routing only. No Mac browser was opened and no audio is captured.
            </small>
          )}
        </div>
      </div>
      <div className="listening-actions">
        <button
          className="primary orange-button"
          disabled={pending || (!configured && (!source || !targets.length))}
          onClick={() => void connect()}
        >
          {pending ? (
            <LoaderCircle size={17} className="spin" />
          ) : status?.phase === 'input-selected' ? (
            <RefreshCw size={17} />
          ) : (
            <Play size={17} />
          )}{' '}
          {status?.phase === 'input-selected' ||
          status?.phase === 'error' ||
          status?.phase === 'route-changed'
            ? 'Reconnect rooms'
            : 'Listen in selected rooms'}
        </button>
        <button
          className="secondary"
          disabled={pending || !status?.canOpenOnMac}
          onClick={() =>
            void run(
              async () => {
                const r = await request('/open');
                if (r.simulated) return;
              },
              status?.mock
                ? 'Simulated browser launch; nothing opened.'
                : 'SoundCloud opened on the Mac. Sign in and start a track.',
            )
          }
        >
          <MonitorSpeaker size={17} />
          Open SoundCloud on Mac
          <ArrowUpRight size={15} />
        </button>
        <button
          className="text-button"
          disabled={pending || !configured}
          onClick={() =>
            void run(
              () => request('/stop'),
              'Sonos input stopped. SoundCloud keeps playing on the Mac.',
            )
          }
        >
          <Square size={14} />
          Stop listening
        </button>
      </div>
      <div className="listening-workflow">
        <div>
          <span>1</span>
          <b>Choose your music</b>
          <p>
            Use SoundCloud on the wired Mac. Sign in normally; track controls and queue stay there.
          </p>
        </div>
        <div>
          <span>2</span>
          <b>Select your rooms</b>
          <p>
            One room or a synchronized group. Existing room volume and mute settings are preserved.
          </p>
        </div>
        <div>
          <span>3</span>
          <b>Keep the Mac playing</b>
          <p>
            Keep it awake and select its wired audio output. Pausing Sonos does not pause the
            website.
          </p>
        </div>
      </div>
      <div className="listening-setup-heading">
        <div>
          <h3>
            <Unplug size={18} /> {configured ? 'Your listening setup' : 'Set up the audio path'}
          </h3>
          <p>
            {configured
              ? `${chosenSource?.name || 'Source unavailable'} line-in → ${status?.profile.targetRoomIds.map((id) => rooms.find((r) => r.id === id)?.name || 'Unavailable room').join(', ')}`
              : 'Use a 3.5 mm stereo-to-two-RCA cable from the Mac mini’s headphone output to one Connect / Connect:Amp’s analog inputs.'}
          </p>
        </div>
        <button
          className="secondary compact"
          disabled={pending}
          onClick={() => setConfigure(!configure)}
        >
          <Settings2 size={16} />
          {configure ? 'Cancel' : 'Change setup'}
        </button>
      </div>
      {(!configured || configure) && (
        <div className="listening-setup">
          <div className="listening-source">
            <label htmlFor="linein-source">Which device has the cable?</label>
            <select
              id="linein-source"
              aria-label="Wired Sonos source"
              disabled={pending}
              value={source}
              onChange={(e) => {
                setConfigure(true);
                setSource(e.target.value);
              }}
            >
              <option value="">Choose a discovered line-in…</option>
              {status?.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!s.online
                    ? ' · offline'
                    : s.connected === false
                      ? ' · no cable reported'
                      : s.connected === true
                        ? ' · cable detected'
                        : ' · cable detection unavailable'}
                </option>
              ))}
            </select>
            <p className="small muted">
              Cable detection, when available, reports a physical connection. It does not verify
              SoundCloud audio. No capture permission or virtual audio driver is needed.
            </p>
            <div className="cable-diagram">
              <MonitorSpeaker size={23} />
              <span>Mac output</span>
              <i />
              <Unplug size={22} />
              <i />
              <Speaker size={23} />
              <span>Sonos RCA input</span>
            </div>
          </div>
          <fieldset className="listening-targets">
            <legend>Where do you want to listen?</legend>
            {rooms.map((r) => (
              <label key={r.id}>
                <Speaker size={17} />
                <span>
                  {r.name}
                  {!r.online && <small>Offline</small>}
                </span>
                <input
                  type="checkbox"
                  aria-label={`Listen in ${r.name}`}
                  disabled={pending || !r.online}
                  checked={targets.includes(r.id)}
                  onChange={(e) => {
                    setConfigure(true);
                    setTargets((ids) =>
                      e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id),
                    );
                  }}
                />
              </label>
            ))}
            {!rooms.length && <p>Discover your speakers first.</p>}
          </fieldset>
          <div className="listening-save">
            <p>
              Applying this selection creates one synchronized Sonos group. Selected rooms may leave
              their existing groups; unselected rooms are not intentionally stopped or added.
            </p>
            <button
              className="secondary"
              disabled={pending || !source || !targets.length}
              onClick={() => void save()}
            >
              <Check size={17} />
              Save setup
            </button>
          </div>
        </div>
      )}
      <details className="listening-help">
        <summary>First-time setup & what this controls</summary>
        <ol>
          <li>
            Connect Mac headphone output to the RCA <b>inputs</b> on one Connect or Connect:Amp. A
            USB audio adapter with a line/headphone output also works if your Mac has no available
            analog output.
          </li>
          <li>
            On the Mac choose that wired output in System Settings → Sound. Play a known working
            track in SoundCloud at a modest volume. Other Mac sounds can also reach this output;
            enable Focus and close unrelated audio apps.
          </li>
          <li>
            Choose the wired Sonos source above, select destination rooms, save, then select Listen.
            The wired source does not need to be a listening destination.
          </li>
          <li>
            If silent, check Mac output volume, Sonos room volume/mute, cable seating, and S1
            line-in source level/compression. Current never raises volume or unmutes rooms
            automatically.
          </li>
        </ol>
        <p>
          “Input selected” confirms Sonos routing, not audible music or access to a track.
          SoundCloud can still enforce account, region, subscription, or content restrictions. No
          media is scraped, downloaded, or decrypted. Current cannot remotely search/control the
          SoundCloud web player from your iPhone; use the Mac’s official player for track selection.
        </p>
        <a href="https://soundcloud.com" target="_blank" rel="noreferrer" className="text-button">
          Open SoundCloud on this device instead
          <ExternalLink size={15} />
        </a>
        <p className="small muted">
          Software-only capture remains an isolated experimental prototype; it is not enabled
          automatically and is not claimed compatible with your S1 firmware.
        </p>
      </details>
    </section>
  );
}
