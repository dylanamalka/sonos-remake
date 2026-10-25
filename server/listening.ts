import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, diagnose } from './store';
import { Sonos } from './sonos';
export type ListeningProfile = { sourceRoomId: string | null; targetRoomIds: string[] };
export type RouteAttempt = {
  phase: 'idle' | 'routing' | 'error';
  message: string;
  changedRooms: string[];
  at: string;
};
export class ListeningError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const defaultProfile: ListeningProfile = { sourceRoomId: null, targetRoomIds: [] };
export const listeningProfile = new Store<ListeningProfile>('listening.json', defaultProfile);
const open = promisify(execFile);
export class Listening {
  private attempt: RouteAttempt = { phase: 'idle', message: '', changedRooms: [], at: '' };
  private browserOpenedAt: string | null = null;
  private openingBrowser = false;
  private stopping = false;
  constructor(
    private sonos: Sonos,
    private openSoundCloud = async () => {
      if (process.platform !== 'darwin')
        throw new ListeningError(
          'Open SoundCloud on the Mac connected to Sonos. This server is not running on macOS.',
          422,
        );
      await open('/usr/bin/open', ['https://soundcloud.com'], { timeout: 5000 });
    },
  ) {}
  async save(profile: ListeningProfile) {
    if (this.attempt.phase === 'routing' || this.stopping)
      throw new ListeningError('Room routing is already in progress.');
    this.validate(profile, false);
    this.attempt = { phase: 'idle', message: '', changedRooms: [], at: '' };
    return listeningProfile.update(() => profile);
  }
  private validate(profile: ListeningProfile, requireOnline: boolean) {
    if (profile.sourceRoomId) {
      const source = this.sonos.room(profile.sourceRoomId);
      if (!source.lineIn)
        throw new ListeningError('Choose a discovered Sonos device with a physical line-in.', 422);
      if (requireOnline && !source.online)
        throw new ListeningError(
          'The selected line-in device is offline. Check power and rediscover.',
        );
      if (requireOnline && source.lineInConnected === false)
        throw new ListeningError(
          'The selected device reports no line-in cable. Connect the Mac output to its RCA inputs, then refresh.',
        );
    }
    if (new Set(profile.targetRoomIds).size !== profile.targetRoomIds.length)
      throw new ListeningError('Choose each destination room once.', 422);
    for (const id of profile.targetRoomIds) {
      const room = this.sonos.room(id);
      if (requireOnline && !room.online)
        throw new ListeningError(
          `${room.name} is offline. Remove it from the selection or reconnect it.`,
        );
    }
    if (requireOnline && (!profile.sourceRoomId || !profile.targetRoomIds.length))
      throw new ListeningError(
        'Choose the connected line-in source and at least one destination room.',
        422,
      );
  }
  async status() {
    const profile = await listeningProfile.read();
    const rooms = [...this.sonos.rooms.values()];
    const source = rooms.find((r) => r.id === profile.sourceRoomId);
    const targets = profile.targetRoomIds.map((id) => rooms.find((r) => r.id === id));
    const uri = source ? `x-rincon-stream:${source.id}` : '';
    const routed = Boolean(
      uri &&
      targets.length &&
      targets.every((r) => {
        if (!r?.online) return false;
        const c = this.sonos.rooms.get(r.coordinator);
        return c && (c.transportUri || c.track?.uri) === uri;
      }),
    );
    const synchronized = Boolean(
      targets.length && targets.every((r) => r?.coordinator === targets[0]?.coordinator),
    );
    let phase = 'needs-setup',
      message =
        'Connect the Mac’s audio output to one Sonos line-in, then choose the source and rooms.';
    if (source && profile.targetRoomIds.length) {
      phase = 'ready';
      message = 'Ready to select the input. Start the music in SoundCloud on the wired Mac.';
      if (!source.online || targets.some((r) => !r?.online)) {
        phase = 'offline';
        message =
          'A configured room is offline or no longer discovered. Reconnect or update your selection.';
      } else if (source.lineInConnected === false) {
        phase = 'no-cable';
        message = 'Sonos reports that the source has no line-in cable connected.';
      } else if (routed && synchronized) {
        const c = this.sonos.coordinator(targets[0]!.id);
        phase = c.state === 'PLAYING' ? 'input-selected' : 'input-paused';
        message =
          c.state === 'PLAYING'
            ? 'Sonos line-in is selected. SoundCloud playback and track controls stay on the Mac. Audible music is not verified by this status.'
            : 'Line-in is selected but the Sonos transport is paused or stopped. Resume to listen.';
      } else if (
        targets.some(
          (r) =>
            r &&
            (this.sonos.coordinator(r.id).transportUri ||
              this.sonos.coordinator(r.id).track?.uri) === uri,
        )
      ) {
        phase = 'route-changed';
        message =
          'Another controller changed the rooms or source. Reconnect to apply your saved selection.';
      }
    }
    if (this.attempt.phase === 'routing' || this.stopping) {
      phase = 'routing';
      message = this.stopping ? 'Stopping the selected Sonos input…' : this.attempt.message;
    } else if (this.attempt.phase === 'error') {
      phase = 'error';
      message = this.attempt.message;
    }
    return {
      method: 'line-in' as const,
      profile,
      phase,
      message,
      sources: rooms
        .filter((r) => r.lineIn)
        .map((r) => ({
          id: r.id,
          name: r.name,
          online: r.online,
          connected: r.lineInConnected ?? null,
        })),
      attempt: this.attempt,
      browserOpenedAt: this.browserOpenedAt,
      canOpenOnMac: this.sonos.mock || process.platform === 'darwin',
      mock: this.sonos.mock,
      audiblePlaybackVerified: false,
      synchronized,
    };
  }
  async openBrowser() {
    if (
      this.openingBrowser ||
      (this.browserOpenedAt && Date.now() - Date.parse(this.browserOpenedAt) < 3000)
    )
      throw new ListeningError(
        'SoundCloud was just opened. Check the Mac before trying again.',
        429,
      );
    this.openingBrowser = true;
    try {
      if (!this.sonos.mock) await this.openSoundCloud();
      this.browserOpenedAt = new Date().toISOString();
      return {
        ok: true,
        simulated: this.sonos.mock,
        message: this.sonos.mock
          ? 'Simulated browser launch; nothing was opened.'
          : 'SoundCloud was opened on the Mac. Sign in and start a track there.',
      };
    } finally {
      this.openingBrowser = false;
    }
  }
  private async confirmed(check: () => boolean, failure: string) {
    for (const delay of [0, 200, 500, 1000, 2000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await this.sonos.refresh();
      if (check()) return;
    }
    throw new ListeningError(failure, 502);
  }
  async connect() {
    if (this.attempt.phase === 'routing' || this.stopping)
      throw new ListeningError('Room routing is already in progress.');
    // Lock before awaiting, so overlapping requests cannot perform competing group mutations.
    this.attempt = {
      phase: 'routing',
      message: 'Checking your saved rooms…',
      changedRooms: [],
      at: new Date().toISOString(),
    };
    try {
      await this.sonos.refresh();
      const profile = await listeningProfile.read();
      this.validate(profile, true);
      const ids = profile.targetRoomIds;
      const anchor = ids[0];
      // Detach only selected coordinators that have unselected followers. Other rooms retain their own group.
      for (const id of ids) {
        const room = this.sonos.room(id);
        if (
          room.coordinator === id &&
          [...this.sonos.rooms.values()].some((r) => r.coordinator === id && !ids.includes(r.id))
        ) {
          this.attempt.message = `Separating ${room.name} from its previous group…`;
          await this.sonos.group(id);
          this.attempt.changedRooms.push(id);
          await this.confirmed(
            () => this.sonos.room(id).coordinator === id,
            'Sonos did not confirm the room leaving its previous group. Retry after the topology settles.',
          );
        }
      }
      // The anchor may itself be a member of an unrelated coordinator's group.
      if (this.sonos.room(anchor).coordinator !== anchor) {
        await this.sonos.group(anchor);
        this.attempt.changedRooms.push(anchor);
        await this.confirmed(
          () => this.sonos.room(anchor).coordinator === anchor,
          'Sonos did not confirm the destination coordinator. Rediscover and retry.',
        );
      }
      for (const id of ids.slice(1)) {
        if (this.sonos.room(id).coordinator !== anchor) {
          this.attempt.message = `Grouping ${this.sonos.room(id).name}…`;
          await this.sonos.group(id, anchor);
          this.attempt.changedRooms.push(id);
        }
      }
      await this.confirmed(
        () => ids.every((id) => this.sonos.room(id).coordinator === anchor),
        'Sonos did not confirm that all selected rooms joined the synchronized group. Reconnect will retry.',
      );
      this.attempt.message = 'Selecting the Sonos line-in…';
      await this.sonos.playUri(anchor, {
        id: 'soundcloud-line-in',
        title: 'SoundCloud · Mac line-in',
        artist: 'Track controls stay in SoundCloud',
        uri: `x-rincon-stream:${profile.sourceRoomId}`,
        metadata: '',
      });
      await this.confirmed(() => {
        const coordinator = this.sonos.room(anchor);
        return (
          (coordinator.transportUri || coordinator.track?.uri) ===
            `x-rincon-stream:${profile.sourceRoomId}` && coordinator.state === 'PLAYING'
        );
      }, 'Sonos accepted the command but did not confirm the line-in transport. Check the source and reconnect.');
      this.attempt = { ...this.attempt, phase: 'idle', message: 'Input selected.' };
      return this.status();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Line-in routing failed.';
      const message = `${detail}${this.attempt.changedRooms.length ? ' Some room groups were already changed. Reconnect will retry your saved selection; unrelated playback is not restored automatically.' : ''}`;
      this.attempt = { ...this.attempt, phase: 'error', message };
      diagnose(
        'SoundCloud line-in',
        'ROUTE_FAILED',
        message,
        'Check the cable, online rooms, and selected source, then choose Reconnect.',
      );
      throw new ListeningError(message, error instanceof ListeningError ? error.status : 502);
    }
  }
  async stop() {
    if (this.attempt.phase === 'routing' || this.stopping)
      throw new ListeningError('Wait for room routing to finish.');
    this.stopping = true;
    try {
      await this.sonos.refresh();
      const profile = await listeningProfile.read();
      const uri = `x-rincon-stream:${profile.sourceRoomId}`;
      const coordinators = new Set<string>();
      for (const id of profile.targetRoomIds) {
        const r = this.sonos.rooms.get(id);
        if (!r) continue;
        const c = this.sonos.coordinator(id);
        if ((c.transportUri || c.track?.uri) === uri) coordinators.add(c.id);
      }
      // Skip groups observed on a different source. Commands on physical devices are not transactional.
      for (const id of coordinators) await this.sonos.control(id, 'stop');
      this.attempt = { phase: 'idle', message: '', changedRooms: [], at: new Date().toISOString() };
      await this.sonos.refresh();
      return {
        ok: true,
        stoppedGroups: coordinators.size,
        message: 'Sonos input stopped. This does not pause the SoundCloud website.',
      };
    } finally {
      this.stopping = false;
    }
  }
}
export type ListeningStatus = Awaited<ReturnType<Listening['status']>>;
