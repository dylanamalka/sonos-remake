'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AudioLines,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Disc3,
  ExternalLink,
  Headphones,
  Heart,
  House,
  Library,
  ListMusic,
  LoaderCircle,
  MonitorSpeaker,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Speaker,
  Unplug,
  Volume2,
  VolumeX,
  Waves,
  X,
} from 'lucide-react';
import type { Room, Track, Diagnostic } from '../server/types';
import type { ListeningStatus } from '../server/listening';
import SoundCloudListening from './soundcloud-listening';
type Item = Track & { playlist?: boolean; count?: number };
type State = {
  rooms: Room[];
  mock: boolean;
  listening?: ListeningStatus;
  settings: { favorites: Track[]; roomOrder: string[]; hiddenRooms: string[] };
  soundcloud: {
    configured: boolean;
    connected: boolean;
    redirectUri: string;
    gatewayConfigured: boolean;
  };
};
const clock = (n = 0) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || 'Request failed'), { status: response.status });
  return value;
}
function Cover({ src, className = '' }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div className={`cover ${className}`}>
      {src && !failed ? (
        <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <Disc3 aria-hidden="true" />
      )}
    </div>
  );
}
function Volume({ room, change }: { room: Room; change: (value: number) => void }) {
  const [volume, setVolume] = useState(room.volume);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setVolume(room.volume);
  }, [room.volume]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <input
      aria-label={`${room.name} volume`}
      title={`${volume}%`}
      type="range"
      min="0"
      max="100"
      value={volume}
      style={{ '--range': `${volume}%` } as React.CSSProperties}
      onChange={(e) => {
        const v = Number(e.target.value);
        setVolume(v);
        editing.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          change(v);
          editing.current = false;
        }, 200);
      }}
    />
  );
}
export default function Home() {
  const [state, setState] = useState<State>();
  const [paired, setPaired] = useState<boolean>();
  const [code, setCode] = useState('');
  const [tab, setTab] = useState('home');
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowPlaying, setNowPlaying] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [queue, setQueue] = useState<Track[]>([]);
  const [scKind, setScKind] = useState('search');
  const [scMode, setScMode] = useState('mac');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [playlistTitle, setPlaylistTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<Diagnostic[]>([]);
  const [libraryKind, setLibraryKind] = useState('favorites');
  const [networkUrl, setNetworkUrl] = useState('');
  const [networkTitle, setNetworkTitle] = useState('');
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const s = await api<State>('/state');
      setState(s);
      setPaired(true);
      setRoomId((id) => (s.rooms.some((r) => r.id === id) ? id : s.rooms[0]?.id || ''));
    } catch (e: any) {
      if (e.status === 401) setPaired(false);
      else setError(e.message);
    } finally {
      polling.current = false;
    }
  }, []);
  useEffect(() => {
    setRoomId(localStorage.getItem('current-room') || '');
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    if ('serviceWorker' in navigator && window.isSecureContext)
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (roomId) localStorage.setItem('current-room', roomId);
  }, [roomId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const room = state?.rooms.find((r) => r.id === roomId);
  const lineInSelected = Boolean(
    (room?.transportUri || room?.track?.uri)?.startsWith('x-rincon-stream:'),
  );
  const coordinator = state?.rooms.find((r) => r.id === room?.coordinator) || room;
  const members = state?.rooms.filter((r) => r.coordinator === coordinator?.id) || [];
  const run = useCallback(
    async (fn: () => Promise<unknown>, message = '') => {
      setBusy(true);
      setError('');
      try {
        await fn();
        if (message) setNotice(message);
        await refresh();
      } catch (e: any) {
        setError(e.message);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const control = (action: string, value?: number | boolean) =>
    room && run(() => api(`/rooms/${room.id}/control`, { action, value }));
  const loadQueue = useCallback(async () => {
    if (!roomId) return;
    try {
      const q = await api(`/rooms/${roomId}/queue`);
      setQueue(q.items);
    } catch (e: any) {
      setError(e.message);
    }
  }, [roomId]);
  useEffect(() => {
    if (queueOpen) void loadQueue();
  }, [queueOpen, loadQueue, state?.rooms.find((r) => r.id === roomId)?.track?.id]);
  useEffect(() => {
    if (!paired || (tab !== 'library' && tab !== 'diagnostics')) return;
    let cancelled = false;
    setLoading(true);
    const load =
      tab === 'diagnostics'
        ? api('/diagnostics').then((r) => {
            if (!cancelled) setEvents(r.events);
          })
        : libraryKind === 'favorites'
          ? Promise.resolve().then(() => {
              if (!cancelled) setItems(state?.settings.favorites || []);
            })
          : libraryKind === 'local'
            ? api('/media').then((r) => {
                if (!cancelled) setItems(r.items);
              })
            : roomId
              ? api(`/rooms/${roomId}/favorites`).then((r) => {
                  if (!cancelled) setItems(r.items);
                })
              : Promise.resolve().then(() => setItems([]));
    load
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, libraryKind, roomId, paired, state?.settings.favorites]);
  const browse = useCallback(async (kind: string, search = '', next = '') => {
    setLoading(true);
    setError('');
    setPlaylistTitle('');
    try {
      const r = await api(
        `/soundcloud/browse?kind=${kind}&q=${encodeURIComponent(search)}&cursor=${encodeURIComponent(next)}`,
      );
      setItems((v) => (next ? [...v, ...r.items] : r.items));
      setCursor(r.next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (tab === 'soundcloud') {
      setItems([]);
      setCursor('');
      if (scMode === 'api' && state?.soundcloud.connected && scKind !== 'search')
        void browse(scKind);
    }
  }, [tab, scMode, scKind, state?.soundcloud.connected, browse]);
  const favorite = (track: Track) => {
    if (!state) return;
    const has = state.settings.favorites.some((t) => t.id === track.id);
    void run(
      () =>
        api(
          '/settings',
          {
            favorites: has
              ? state.settings.favorites.filter((t) => t.id !== track.id)
              : [...state.settings.favorites, track],
          },
          'PUT',
        ),
      has ? 'Removed from favorites' : 'Saved to your library',
    );
  };
  const playTrack = (track: Item, enqueue = false) => {
    if (!room) {
      setError('Discover and select a room first.');
      return;
    }
    if (track.playlist) {
      setLoading(true);
      api(`/soundcloud/playlists/${track.id}`)
        .then((r) => {
          setItems(r.items);
          setPlaylistTitle(track.title);
          setCursor('');
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
      return;
    }
    void run(
      async () => {
        if (
          tab === 'soundcloud' ||
          track.source === 'soundcloud' ||
          track.permalink?.includes('soundcloud.com')
        )
          await api('/soundcloud/play', { room: room.id, track: track.id, enqueue });
        else if (track.source === 'local' || (tab === 'library' && libraryKind === 'local'))
          await api('/media/play', { room: room.id, file: track.id, enqueue });
        else if (track.uri)
          await api(
            `/rooms/${room.id}/${enqueue ? 'queue' : 'play'}`,
            enqueue ? { action: 'add', track } : track,
          );
        else throw new Error('This item has no playable source. Open its service to play it.');
        if (queueOpen) await loadQueue();
      },
      enqueue
        ? 'Added to queue'
        : `Playing in ${members.length > 1 ? `${members.length} rooms` : room.name}`,
    );
  };
  const nav = (value: string) => {
    setTab(value);
    setItems([]);
    setError('');
  };
  if (paired === undefined)
    return (
      <div className="boot">
        <AudioLines size={42} />
        <p>Finding your rhythm…</p>
      </div>
    );
  if (!paired)
    return (
      <main className="pair-screen">
        <div className="pair-art">
          <div className="brand">
            <AudioLines /> current<span>LOCAL AUDIO, REIMAGINED</span>
          </div>
          <img src="/artwork.svg" alt="Abstract sunset over layered hills" />
          <div className="pair-copy">
            <span className="eyebrow">YOUR HOME. YOUR MUSIC.</span>
            <h1>
              Good sound.
              <br />
              Everywhere.
            </h1>
            <p>A new home for the system you love.</p>
          </div>
        </div>
        <section className="pair-form">
          <div className="pill">
            <ShieldCheck size={14} /> Private by design
          </div>
          <h2>Welcome to Current.</h2>
          <p>
            Pair this device with the controller running on your Mac. Your music stays on your
            network.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/auth', { code });
                await refresh();
              });
            }}
          >
            <label htmlFor="pair-code">Pairing code</label>
            <input
              id="pair-code"
              autoComplete="current-password"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code from your Mac terminal"
              required
            />
            <button className="primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : 'Connect to your home'}
              <ArrowUpRight size={18} />
            </button>
          </form>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <small>
            Find your code in the terminal where you ran <code>npm run dev</code>. No cloud account
            needed for speaker control.
          </small>
        </section>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Current home">
          <AudioLines size={26} />
          <span>
            current<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-label">YOUR SOUND, EVERYWHERE</div>
        <nav>
          {[
            [House, 'home', 'Listen now'],
            [Cloud, 'soundcloud', 'SoundCloud'],
            [Library, 'library', 'Your library'],
          ].map(([Icon, id, label]: any) => (
            <button key={id} className={tab === id ? 'nav active' : 'nav'} onClick={() => nav(id)}>
              <Icon size={19} />
              {label}
              {id === 'soundcloud' && <span className="tiny-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <span className="sidebar-label">YOUR ROOMS</span>
          <button
            className="icon-button"
            aria-label="Discover rooms"
            title="Discover rooms"
            disabled={busy}
            onClick={() => void run(() => api('/discover', {}), 'Discovery complete')}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="side-rooms">
          {state?.rooms.map((r) => (
            <button
              key={r.id}
              className={`side-room ${r.id === roomId ? 'selected' : ''}`}
              onClick={() => setRoomId(r.id)}
            >
              <Speaker size={16} />
              <span>{r.name}</span>
              {r.state === 'PLAYING' && r.online ? (
                <AudioLines size={14} className="lime" />
              ) : (
                <span className={`status-dot ${r.online ? 'online' : ''}`} />
              )}
            </button>
          ))}
          {!state?.rooms.length && (
            <p className="muted small">No speakers yet. Connect to your home Wi-Fi and discover.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-icon">
              <Waves size={19} />
            </span>
            <div>
              <b>{state?.mock ? 'Demo system' : 'Made for your home'}</b>
              <small>
                {state?.mock ? 'Simulated devices · no audio' : 'Local connection · S1 compatible'}
              </small>
            </div>
          </div>
          <button
            className={`nav ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => nav('settings')}
          >
            <Settings2 size={18} />
            Settings & connections
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Your home</span>
            <ChevronRight size={14} />
            <b>
              {
                (
                  {
                    home: 'Listen now',
                    soundcloud: 'SoundCloud',
                    library: 'Your library',
                    settings: 'Settings',
                    diagnostics: 'Diagnostics',
                  } as any
                )[tab]
              }
            </b>
          </div>
          <div className="top-actions">
            <button
              className="icon-button mobile-queue"
              aria-label="Open queue"
              onClick={() => setQueueOpen(true)}
            >
              <ListMusic size={19} />
            </button>
            <span className="connection">
              <span className="status-dot online" />
              {state?.mock
                ? 'Demo mode'
                : `${state?.rooms.filter((r) => r.online).length || 0} rooms online`}
            </span>
            <button className="avatar" onClick={() => nav('settings')} aria-label="Open settings">
              ♫
            </button>
          </div>
        </header>
        <main className="main">
          {state?.mock && (
            <div className="demo-banner">
              <MonitorSpeaker size={15} />
              <span>Demo mode · simulated rooms and playback. No physical speakers connected.</span>
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {tab === 'home' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A LITTLE LESS NOISE. A LOT MORE MUSIC.</span>
                  <h1>
                    Make yourself at home<span className="lime">.</span>
                  </h1>
                  <p>The right sound, in every room.</p>
                </div>
                <button className="secondary compact" onClick={() => setSourceOpen(true)}>
                  <Plus size={16} />
                  Play a source
                </button>
              </div>
              <section className="hero">
                <div className="hero-copy">
                  <div className="hero-tag">
                    <span className="status-dot" />
                    THE WHOLE HOME, IN HARMONY
                  </div>
                  <h2>
                    One home.
                    <br />
                    Endless possibilities.
                  </h2>
                  <p>
                    From quiet mornings to late nights.
                    <br />
                    Bring your music along.
                  </p>
                  <button className="light-button" onClick={() => setGroupOpen(true)}>
                    <AudioLines size={18} />
                    Find your flow
                    <ArrowUpRight size={16} />
                  </button>
                  <div className="hero-footer">
                    <span className="tiny-line" /> BUILT FOR THE WAY YOU LISTEN
                  </div>
                </div>
                <div className="hero-art">
                  <img src="/artwork.svg" alt="Warm sunset above waves" />
                  <div className="record">
                    <div className="record-label">
                      <AudioLines size={28} />
                    </div>
                  </div>
                  <span className="art-caption">SOUND THAT FEELS LIKE HOME</span>
                </div>
              </section>
              <div className="section-heading">
                <div>
                  <h2>
                    Your rooms <span className="count">{state?.rooms.length || 0}</span>
                  </h2>
                  <p>A different mood. Or the same moment.</p>
                </div>
                <button className="text-button" disabled={busy} onClick={() => setGroupOpen(true)}>
                  <SlidersHorizontal size={15} />
                  Manage groups
                </button>
              </div>
              <section className="room-grid">
                {state?.rooms.map((r, i) => (
                  <article
                    className={`room-card ${roomId === r.id ? 'room-active' : ''}`}
                    key={r.id}
                  >
                    <button className="room-select" onClick={() => setRoomId(r.id)}>
                      <span className={`room-illustration tone-${i % 3}`}>
                        <Speaker size={24} />
                      </span>
                      <span>
                        <b>{r.name}</b>
                        <small>
                          {!r.online
                            ? 'Offline'
                            : r.coordinator !== r.id
                              ? `Grouped with ${state.rooms.find((x) => x.id === r.coordinator)?.name || 'another room'}`
                              : r.state === 'PLAYING'
                                ? 'Playing'
                                : 'Ready to listen'}
                        </small>
                      </span>
                      {r.state === 'PLAYING' ? (
                        <AudioLines size={19} className="lime" />
                      ) : roomId === r.id ? (
                        <span className="selected-ring">
                          <Check size={11} />
                        </span>
                      ) : (
                        <span className="empty-ring" />
                      )}
                    </button>
                    <div className="room-track">
                      <Cover src={r.track?.artwork} />
                      <div>
                        <b>{r.track?.title || 'A little quiet, for now'}</b>
                        <span>{r.track?.artist || r.model}</span>
                      </div>
                      <button
                        className="icon-button"
                        disabled={!r.online || busy}
                        aria-label={`${r.state === 'PLAYING' ? 'Pause' : 'Play'} ${r.name}`}
                        onClick={() =>
                          void run(() =>
                            api(`/rooms/${r.id}/control`, {
                              action: r.state === 'PLAYING' ? 'pause' : 'play',
                            }),
                          )
                        }
                      >
                        {r.state === 'PLAYING' ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    </div>
                    <div className="room-volume">
                      <button
                        className="icon-button"
                        aria-label={`${r.mute ? 'Unmute' : 'Mute'} ${r.name}`}
                        onClick={() =>
                          void run(() =>
                            api(`/rooms/${r.id}/control`, { action: 'mute', value: !r.mute }),
                          )
                        }
                      >
                        {r.mute ? <VolumeX size={15} /> : <Volume2 size={15} />}
                      </button>
                      <Volume
                        room={r}
                        change={(v) =>
                          void run(() =>
                            api(`/rooms/${r.id}/control`, { action: 'volume', value: v }),
                          )
                        }
                      />
                      <span>{r.volume}%</span>
                    </div>
                  </article>
                ))}
                {!state?.rooms.length && (
                  <div className="empty-state wide">
                    <Speaker size={34} />
                    <h3>Let’s find your speakers.</h3>
                    <p>
                      Run this app on your Mac, connected to the same network as your Sonos system.
                    </p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void run(() => api('/discover', {}))}
                    >
                      {busy ? 'Searching…' : 'Discover Sonos devices'}
                    </button>
                  </div>
                )}
              </section>
              <div className="section-heading">
                <div>
                  <h2>A world of sound</h2>
                  <p>Your favorites, all in one place.</p>
                </div>
              </div>
              <section className="source-grid">
                <button className="source-card sc-card" onClick={() => nav('soundcloud')}>
                  <span className="source-logo">
                    <Cloud size={30} />
                  </span>
                  <div>
                    <h3>Go beyond the mainstream.</h3>
                    <p>Fresh finds, deep cuts, and your SoundCloud favorites.</p>
                    <span>
                      Explore SoundCloud
                      <ArrowUpRight size={15} />
                    </span>
                  </div>
                  <span className="source-number">01</span>
                </button>
                <button className="source-card library-card" onClick={() => nav('library')}>
                  <span className="source-logo">
                    <Heart size={26} />
                  </span>
                  <div>
                    <h3>Always in good company.</h3>
                    <p>Your collection. The tracks that feel like you.</p>
                    <span>
                      Open your library
                      <ArrowUpRight size={15} />
                    </span>
                  </div>
                  <span className="source-number">02</span>
                </button>
              </section>
            </>
          )}
          {tab === 'soundcloud' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow orange">INDEPENDENT SOUND. ALL AROUND.</span>
                  <h1>
                    SoundCloud<span className="orange">.</span>
                  </h1>
                  <p>The tracks you love. A new way to listen.</p>
                </div>
                <Cloud size={42} className="orange" />
              </div>
              <div className="tabs" aria-label="SoundCloud playback method">
                <button
                  className={scMode === 'mac' ? 'active' : ''}
                  onClick={() => setScMode('mac')}
                >
                  Listen from Mac · no API keys
                </button>
                <button
                  className={scMode === 'api' ? 'active' : ''}
                  onClick={() => setScMode('api')}
                >
                  API library · optional
                </button>
              </div>
              {scMode === 'mac' ? (
                <SoundCloudListening
                  status={state?.listening}
                  rooms={state?.rooms || []}
                  selectedRoomId={roomId}
                  onSelectRoom={setRoomId}
                  run={run}
                  busy={busy}
                />
              ) : (
                <>
                  {!state?.soundcloud.connected ? (
                    <section className="connect-panel">
                      <div className="connect-icon">
                        <Cloud size={48} />
                      </div>
                      <div>
                        <h2>Your next favorite is out there.</h2>
                        <p>
                          Connect your SoundCloud account to search, browse Likes and playlists, and
                          request compatible authorized MP3 playback on your system.
                        </p>
                        <p className="small muted">
                          Requires an approved SoundCloud developer app. Track availability and API
                          access vary; some tracks need the official app or line-in.
                        </p>
                        {state?.soundcloud.configured ? (
                          <a className="primary orange-button" href="/api/soundcloud/connect">
                            Connect SoundCloud
                            <ArrowUpRight size={17} />
                          </a>
                        ) : (
                          <button className="primary orange-button" onClick={() => nav('settings')}>
                            Set up SoundCloud
                            <ArrowUpRight size={17} />
                          </button>
                        )}
                      </div>
                    </section>
                  ) : (
                    <>
                      <div className="tabs">
                        {['search', 'likes', 'playlists'].map((t) => (
                          <button
                            className={scKind === t ? 'active' : ''}
                            key={t}
                            onClick={() => {
                              setScKind(t);
                              setPlaylistTitle('');
                            }}
                          >
                            {t === 'likes'
                              ? 'Liked tracks'
                              : t.charAt(0).toUpperCase() + t.slice(1)}
                          </button>
                        ))}
                      </div>
                      {scKind === 'search' && (
                        <form
                          className="search"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void browse('search', query);
                          }}
                        >
                          <Search size={20} />
                          <input
                            aria-label="Search SoundCloud"
                            placeholder="Tracks, artists, the remix you can’t stop playing…"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            required
                          />
                          <button className="primary compact" disabled={loading}>
                            Search
                          </button>
                        </form>
                      )}
                      {playlistTitle && (
                        <div className="section-heading">
                          <h2>{playlistTitle}</h2>
                          <button className="text-button" onClick={() => void browse('playlists')}>
                            <ChevronLeft size={16} />
                            All playlists
                          </button>
                        </div>
                      )}
                      <TrackList
                        items={items}
                        loading={loading}
                        play={playTrack}
                        favorite={favorite}
                        favorites={state?.settings.favorites || []}
                      />
                      {cursor && (
                        <button
                          className="secondary"
                          disabled={loading}
                          onClick={() => void browse(scKind, query, cursor)}
                        >
                          Load more
                        </button>
                      )}
                      <div className="info-note">
                        <ShieldCheck size={17} />
                        <p>
                          Authorized full MP3 streams only, including verified unencrypted MP3 HLS.
                          AAC HLS and snippets use a fallback. No scraping or DRM bypass. Playback
                          on your Sonos S1 system requires local testing.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {tab === 'library' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">THE ONES YOU COME BACK TO</span>
                  <h1>
                    Your library<span className="lime">.</span>
                  </h1>
                  <p>A collection that sounds like you.</p>
                </div>
                <button className="secondary compact" onClick={() => setSourceOpen(true)}>
                  <Plus size={16} />
                  Add a source
                </button>
              </div>
              <div className="tabs">
                {[
                  ['favorites', 'Saved favorites'],
                  ['sonos', 'Sonos favorites'],
                  ['local', 'Local files'],
                ].map(([id, title]) => (
                  <button
                    key={id}
                    className={libraryKind === id ? 'active' : ''}
                    onClick={() => setLibraryKind(id)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {libraryKind === 'local' && (
                <div className="info-note">
                  <Music2 size={18} />
                  <p>
                    Copy audio files you own or have permission to stream into{' '}
                    <code>.local/media</code> on your Mac. MP3 plays directly; other unencrypted
                    formats use FFmpeg. Refresh this tab after adding files.
                  </p>
                </div>
              )}
              {libraryKind === 'sonos' && (
                <p className="muted small">
                  Favorites from {room?.name || 'your selected room'}. Configure music services in
                  the official Sonos S1 app.
                </p>
              )}
              <TrackList
                items={items}
                loading={loading}
                play={playTrack}
                favorite={favorite}
                favorites={state?.settings.favorites || []}
              />
            </>
          )}
          {tab === 'settings' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A LITTLE FINE-TUNING</span>
                  <h1>
                    Make it yours<span className="lime">.</span>
                  </h1>
                  <p>Your connections, your preferences.</p>
                </div>
              </div>
              <section className="settings-grid">
                <div className="settings-card">
                  <Speaker />
                  <h2>Your Sonos system</h2>
                  <p>
                    {state?.mock
                      ? 'Mock mode is enabled. Set SONOS_MOCK=0 or remove it to discover your real speakers.'
                      : 'Discovery uses SSDP on your local network. Your Mac and Sonos need to be on the same subnet, with multicast allowed.'}
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(() => api('/discover', {}), 'Discovery complete')}
                  >
                    <RefreshCw size={16} />
                    Discover devices
                  </button>
                </div>
                <div className="settings-card">
                  <Cloud className="orange" />
                  <h2>SoundCloud API · optional</h2>
                  <p>
                    {state?.soundcloud.connected
                      ? 'Your account is connected. Access is limited to tracks available through the authorized API.'
                      : 'Add your approved app credentials to .env on the Mac, then restart the controller.'}
                  </p>
                  <code className="config-code">
                    SOUNDCLOUD_CLIENT_ID
                    <br />
                    SOUNDCLOUD_CLIENT_SECRET
                    <br />
                    SOUNDCLOUD_REDIRECT_URI
                  </code>
                  {state?.soundcloud.connected ? (
                    <button
                      className="secondary"
                      onClick={() =>
                        void run(() => api('/soundcloud/disconnect', {}), 'SoundCloud disconnected')
                      }
                    >
                      <Unplug size={16} />
                      Disconnect
                    </button>
                  ) : state?.soundcloud.configured ? (
                    <a className="primary orange-button" href="/api/soundcloud/connect">
                      Connect account
                      <ArrowUpRight size={16} />
                    </a>
                  ) : (
                    <span className="pill">Credentials needed</span>
                  )}
                </div>
                <div className="settings-card">
                  <Radio />
                  <h2>Audio gateway & line-in</h2>
                  <p>
                    Set <code>PUBLIC_BASE_URL</code> to your Mac’s LAN origin, such as{' '}
                    <code>http://192.168.1.50:3000</code>. Speakers must reach that address.
                  </p>
                  <p>
                    For tracks unavailable through the API, play the official SoundCloud app through
                    a physical audio output connected to a Sonos Connect line-in.
                  </p>
                  <button className="secondary" onClick={() => setSourceOpen(true)}>
                    Choose a source
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className="settings-card">
                  <ShieldCheck />
                  <h2>Local. On purpose.</h2>
                  <p>
                    No paid cloud service is required. Settings and OAuth tokens are stored
                    privately on your Mac. Only paired devices can use the controller API.
                  </p>
                  <p>
                    For iPhone, open your Mac’s LAN address in Safari. Add to Home Screen; use
                    trusted local HTTPS for full PWA support.
                  </p>
                  <button className="secondary" onClick={() => nav('diagnostics')}>
                    Open diagnostics
                    <ChevronRight size={16} />
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === 'diagnostics' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">LET’S GET BACK TO THE MUSIC</span>
                  <h1>
                    Diagnostics<span className="lime">.</span>
                  </h1>
                  <p>Connection and playback events from this session.</p>
                </div>
                <button
                  className="secondary compact"
                  onClick={() =>
                    void run(async () => setEvents((await api('/diagnostics')).events))
                  }
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
              <div className="info-note">
                <Headphones size={20} />
                <p>
                  “Not encoded correctly” can indicate an unsupported codec or container, HLS
                  delivery, an expired URL, unavailable authorization, or a restricted track. This
                  message alone does not identify the cause. Current uses progressive MP3 when the
                  authorized API provides it.
                </p>
              </div>
              {!events.length ? (
                <div className="empty-state">
                  <ShieldCheck size={36} />
                  <h3>No issues recorded.</h3>
                  <p>Playback and connection failures will appear here.</p>
                </div>
              ) : (
                <div className="event-list">
                  {events.map((e, i) => (
                    <article key={`${e.at}-${i}`}>
                      <span className="pill">
                        {e.source} · {e.code}
                      </span>
                      <time>{new Date(e.at).toLocaleTimeString()}</time>
                      <h3>{e.message}</h3>
                      <p>{e.hint}</p>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          <footer className="main-footer">
            <AudioLines size={15} />
            <span>GOOD MUSIC. BETTER TOGETHER.</span>
            <span>Current · Local Sonos controller</span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav">
        {[
          [House, 'home', 'Listen'],
          [Cloud, 'soundcloud', 'SoundCloud'],
          [Library, 'library', 'Library'],
          [Settings2, 'settings', 'Settings'],
        ].map(([Icon, id, title]: any) => (
          <button className={tab === id ? 'active' : ''} key={id} onClick={() => nav(id)}>
            <Icon size={21} />
            {title}
          </button>
        ))}
      </nav>
      <div className="player">
        <div className="player-track">
          <button
            className="player-track-open"
            aria-label="Open Now Playing"
            onClick={() => setNowPlaying(true)}
          >
            <Cover src={room?.track?.artwork} />
            <span>
              <b>{room?.track?.title || 'Your home is ready'}</b>
              <small>{room?.track?.artist || 'Choose a room and something to play'}</small>
            </span>
          </button>
          {room?.track && (
            <button
              className="icon-button favorite-player"
              aria-label="Save current track"
              onClick={() => favorite(room.track!)}
            >
              <Heart
                size={18}
                className={
                  state?.settings.favorites.some((t) => t.id === room.track?.id) ? 'lime' : ''
                }
              />
            </button>
          )}
        </div>
        <div className="transport">
          <div className="transport-buttons">
            <button
              className="icon-button"
              disabled={!room || busy || lineInSelected}
              aria-label="Previous track"
              onClick={() => void control('previous')}
            >
              <SkipBack size={20} fill="currentColor" />
            </button>
            <button
              className="play-button"
              disabled={!room || busy}
              aria-label={room?.state === 'PLAYING' ? 'Pause playback' : 'Start playback'}
              onClick={() => void control(room?.state === 'PLAYING' ? 'pause' : 'play')}
            >
              {room?.state === 'PLAYING' ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              disabled={!room || busy || lineInSelected}
              aria-label="Next track"
              onClick={() => void control('next')}
            >
              <SkipForward size={20} fill="currentColor" />
            </button>
          </div>
          <div className="progress">
            <span>{clock(room?.position)}</span>
            <input
              aria-label="Playback position"
              type="range"
              min="0"
              max={room?.duration || 1}
              value={Math.min(room?.position || 0, room?.duration || 1)}
              disabled={!room?.duration}
              onChange={(e) => void control('seek', Number(e.target.value))}
            />
            <span>{clock(room?.duration)}</span>
          </div>
        </div>
        <div className="player-right">
          <button
            className={`icon-button ${queueOpen ? 'lime' : ''}`}
            aria-label="Open queue"
            onClick={() => setQueueOpen(!queueOpen)}
          >
            <ListMusic size={20} />
          </button>
          <button
            className="room-picker"
            onClick={() => {
              setTab('home');
              document.querySelector('.room-grid')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <Speaker size={17} />
            <span>
              {room?.name || 'Select room'}
              {members.length > 1 ? ` +${members.length - 1}` : ''}
            </span>
            <ChevronDown size={14} />
          </button>
          {room && (
            <div className="player-volume">
              <button
                className="icon-button"
                aria-label={room.mute ? 'Unmute selected room' : 'Mute selected room'}
                onClick={() => void control('mute', !room.mute)}
              >
                {room.mute ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <Volume key={room.id} room={room} change={(v) => void control('volume', v)} />
            </div>
          )}
        </div>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {nowPlaying && (
        <Modal
          title="Now playing"
          subtitle={
            members.length > 1
              ? `${members.length} ROOMS · ${coordinator?.name?.toUpperCase()}`
              : room?.name?.toUpperCase() || 'SELECT A ROOM'
          }
          close={() => setNowPlaying(false)}
        >
          <Cover className="now-playing-cover" src={room?.track?.artwork} />
          <div className="now-playing-title">
            <h2>{room?.track?.title || 'Ready when you are.'}</h2>
            <p>{room?.track?.artist || 'Choose a source to start listening.'}</p>
          </div>
          <div className="progress now-playing-progress">
            <span>{clock(room?.position)}</span>
            <input
              aria-label="Now playing position"
              type="range"
              min="0"
              max={room?.duration || 1}
              value={Math.min(room?.position || 0, room?.duration || 1)}
              disabled={!room?.duration}
              onChange={(e) => void control('seek', Number(e.target.value))}
            />
            <span>{clock(room?.duration)}</span>
          </div>
          <div className="transport-buttons now-playing-transport">
            <button
              className="icon-button"
              disabled={!room || busy || lineInSelected}
              aria-label="Previous in now playing"
              onClick={() => void control('previous')}
            >
              <SkipBack size={24} />
            </button>
            <button
              className="play-button"
              disabled={!room || busy}
              aria-label="Toggle playback in now playing"
              onClick={() => void control(room?.state === 'PLAYING' ? 'pause' : 'play')}
            >
              {room?.state === 'PLAYING' ? (
                <Pause fill="currentColor" />
              ) : (
                <Play fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              disabled={!room || busy || lineInSelected}
              aria-label="Next in now playing"
              onClick={() => void control('next')}
            >
              <SkipForward size={24} />
            </button>
          </div>
          {room && (
            <div className="now-playing-volume">
              <Volume2 size={18} />
              <Volume room={room} change={(v) => void control('volume', v)} />
            </div>
          )}
          <div className="now-playing-actions">
            <button
              className="secondary"
              onClick={() => {
                setNowPlaying(false);
                setGroupOpen(true);
              }}
            >
              <Speaker size={16} />
              Rooms
            </button>
            <button
              className="secondary"
              onClick={() => {
                setNowPlaying(false);
                setQueueOpen(true);
              }}
            >
              <ListMusic size={16} />
              Queue
            </button>
          </div>
          {room?.track?.permalink && (
            <a className="text-button" href={room.track.permalink} target="_blank" rel="noreferrer">
              Open in SoundCloud
              <ExternalLink size={15} />
            </a>
          )}
        </Modal>
      )}
      {queueOpen && (
        <div className="overlay" onClick={() => setQueueOpen(false)}>
          <aside
            className="queue-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Playback queue"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">UP NEXT IN {room?.name?.toUpperCase()}</span>
                <h2>Your queue</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close queue"
                onClick={() => setQueueOpen(false)}
              >
                <X />
              </button>
            </div>
            <p className="muted small">The first 200 tracks in your group coordinator’s queue.</p>
            {queue.length ? (
              <>
                {queue.map((t, i) => (
                  <div className="queue-row" key={`${t.id}-${i}`}>
                    <span>{i + 1}</span>
                    <Cover src={t.artwork} />
                    <button
                      className="queue-title"
                      onClick={() =>
                        void run(async () => {
                          await api(`/rooms/${roomId}/queue`, { action: 'play', index: i });
                          await loadQueue();
                        })
                      }
                    >
                      <b>{t.title}</b>
                      <small>{t.artist}</small>
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${t.title}`}
                      onClick={() =>
                        void run(async () => {
                          await api(`/rooms/${roomId}/queue`, { action: 'remove', index: i });
                          await loadQueue();
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      await api(`/rooms/${roomId}/queue`, { action: 'clear' });
                      await loadQueue();
                    }, 'Queue cleared')
                  }
                >
                  Clear queue
                </button>
              </>
            ) : (
              <div className="empty-state">
                <ListMusic size={32} />
                <h3>Room for something good.</h3>
                <p>Add tracks using the + button in your library or SoundCloud.</p>
              </div>
            )}
          </aside>
        </div>
      )}
      {groupOpen && (
        <Modal
          title="Better together."
          subtitle="GROUP YOUR ROOMS"
          close={() => setGroupOpen(false)}
        >
          <p className="muted">
            Select rooms to play in sync with <b>{coordinator?.name || 'your selected room'}</b>.
            Sonos handles synchronization on the speakers.
          </p>
          {!room && <p>Discover a room first.</p>}
          {state?.rooms.map((r) => (
            <label className="group-row" key={r.id}>
              <Speaker size={20} />
              <span>
                <b>{r.name}</b>
                <small>
                  {r.id === coordinator?.id
                    ? 'Group coordinator'
                    : r.coordinator === coordinator?.id
                      ? 'Playing together'
                      : 'Independent room'}
                </small>
              </span>
              <input
                type="checkbox"
                aria-label={`Group ${r.name}`}
                checked={r.coordinator === coordinator?.id}
                disabled={r.id === coordinator?.id || busy || !coordinator}
                onChange={(e) => {
                  const target = e.target.checked ? coordinator?.id : null;
                  setState((s) =>
                    s
                      ? {
                          ...s,
                          rooms: s.rooms.map((item) =>
                            item.id === r.id
                              ? {
                                  ...item,
                                  coordinator: target || item.id,
                                  group: target || item.id,
                                }
                              : item,
                          ),
                        }
                      : s,
                  );
                  void run(
                    () => api(`/rooms/${r.id}/group`, { coordinator: target }),
                    'Room group updated',
                  );
                }}
              />
            </label>
          ))}
          <button className="primary full" onClick={() => setGroupOpen(false)}>
            Done
            <Check size={17} />
          </button>
        </Modal>
      )}
      {sourceOpen && (
        <Modal
          title="What sounds good?"
          subtitle="PLAY IN YOUR SELECTED ROOM"
          close={() => setSourceOpen(false)}
        >
          <p className="muted small">
            Playing in {room?.name || '— select a room first'}. Only use sources you are authorized
            to stream.
          </p>
          <h3 className="source-title">
            <Radio size={17} />
            Direct network audio
          </h3>
          <form
            className="source-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!room) return;
              void run(async () => {
                await api(`/rooms/${room.id}/play`, {
                  id: networkUrl,
                  title: networkTitle || 'Network audio',
                  artist: 'Direct stream',
                  uri: networkUrl,
                });
                setSourceOpen(false);
              }, 'Network source selected');
            }}
          >
            <label htmlFor="source-url">Audio URL (compatible HTTP MP3 recommended)</label>
            <input
              id="source-url"
              value={networkUrl}
              onChange={(e) => setNetworkUrl(e.target.value)}
              placeholder="http://your-media-server/music.mp3"
              type="url"
              required
            />
            <label htmlFor="source-title">Display name</label>
            <input
              id="source-title"
              value={networkTitle}
              onChange={(e) => setNetworkTitle(e.target.value)}
              placeholder="A favorite station"
            />
            <button className="primary" disabled={!room || busy}>
              Play source
              <Play size={16} />
            </button>
          </form>
          <h3 className="source-title">
            <Unplug size={17} />
            Physical line-in
          </h3>
          <p className="muted small">
            Connect your Mac, phone audio adapter, or an authorized audio source to a Connect’s RCA
            inputs. Select that input below.
          </p>
          <div className="line-in-list">
            {state?.rooms
              .filter((r) => r.lineIn)
              .map((r) => (
                <button
                  className="secondary"
                  key={r.id}
                  disabled={!room || busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/rooms/${roomId}/line-in`, { source: r.id });
                      setSourceOpen(false);
                    }, 'Line-in selected')
                  }
                >
                  <Unplug size={16} />
                  {r.name}
                  <ChevronRight size={15} />
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
function TrackList({
  items,
  loading,
  play,
  favorite,
  favorites,
}: {
  items: Item[];
  loading: boolean;
  play: (t: Item, enqueue?: boolean) => void;
  favorite: (t: Track) => void;
  favorites: Track[];
}) {
  return (
    <div className="track-list">
      {loading && (
        <div className="loading">
          <LoaderCircle size={22} className="spin" />
          Loading your music…
        </div>
      )}
      {!items.length && !loading && (
        <div className="empty-state">
          <Disc3 size={40} />
          <h3>Find your next repeat.</h3>
          <p>Search SoundCloud or add favorites and local files to start your collection.</p>
        </div>
      )}
      {items.length > 0 && (
        <>
          <div className="track-header">
            <span>#</span>
            <span>TITLE / ARTIST</span>
            <span>DURATION</span>
            <span />
          </div>
          {items.map((t, i) => (
            <div className="track-row" key={`${t.id}-${i}`}>
              <button
                className="track-number"
                aria-label={`Play ${t.title}`}
                onClick={() => play(t)}
              >
                <span>{i + 1}</span>
                <Play size={15} />
              </button>
              <button className="track-info" onClick={() => play(t)}>
                <Cover src={t.artwork} />
                <span>
                  <b>{t.title}</b>
                  <small>
                    {t.artist}
                    {t.playlist
                      ? ` · ${t.count || 0} tracks`
                      : t.access && t.access !== 'playable' && t.access !== 'unknown'
                        ? ` · ${t.access}`
                        : ''}
                  </small>
                </span>
              </button>
              <span className="track-duration">
                {t.playlist ? 'Playlist' : t.duration ? clock(t.duration) : '—'}
              </span>
              <div className="track-actions">
                {t.permalink && (
                  <a
                    href={t.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-button"
                    aria-label={`Open ${t.title} on SoundCloud`}
                  >
                    <ExternalLink size={15} />
                  </a>
                )}
                {!t.playlist && (
                  <>
                    <button
                      className={`icon-button ${favorites.some((f) => f.id === t.id) ? 'lime' : ''}`}
                      aria-label={`Favorite ${t.title}`}
                      onClick={() => favorite(t)}
                    >
                      <Heart size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Queue ${t.title}`}
                      onClick={() => play(t, true)}
                    >
                      <Plus size={18} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const els = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),a[href]',
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      before?.focus();
    };
  }, []);
  return (
    <div className="overlay modal-overlay" onClick={close}>
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{subtitle}</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={close}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
