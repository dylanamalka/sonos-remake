import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';
import type { Favorite, Room, Track } from './types';
import { diagnose } from './store';
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
export function xml(value: unknown): string {
  return String(value ?? '').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}
export function parseXml(value: string): any {
  if (value.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(value))
    throw new Error('Unsafe or oversized XML response');
  return parser.parse(value);
}
const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
export function privateIPv4(host: string): boolean {
  const n = host.split('.').map(Number);
  return (
    n.length === 4 &&
    n.every(
      (x, i) => Number.isInteger(x) && x >= 0 && x <= 255 && String(x) === host.split('.')[i],
    ) &&
    (n[0] === 10 ||
      (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 192 && n[1] === 168) ||
      (n[0] === 169 && n[1] === 254))
  );
}
export function discoveryLocation(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !privateIPv4(url.hostname) ||
    url.port !== '1400' ||
    url.username ||
    url.password
  )
    throw new Error('Invalid speaker location');
  return url;
}
export function seconds(value: string | number): number {
  const parts = String(value).split(':').map(Number);
  return parts.every(Number.isFinite) ? parts.reduce((a, b) => a * 60 + b, 0) : 0;
}
function fromItem(item: any): Track {
  const resource = list<any>(item.res)[0];
  return {
    id: String(item['@_id'] ?? ''),
    title: String(item.title || 'Unknown track'),
    artist: String(item.creator || item.artist || ''),
    artwork: item.albumArtURI ? String(item.albumArtURI) : undefined,
    uri: typeof resource === 'object' ? String(resource['#text'] || '') : String(resource || ''),
    duration: seconds(resource?.['@_duration'] || 0),
  };
}
export function didl(track: Track): string {
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="0" parentID="0" restricted="true"><dc:title>${xml(track.title)}</dc:title><dc:creator>${xml(track.artist)}</dc:creator><upnp:class>object.item.audioItem.musicTrack</upnp:class>${track.artwork ? `<upnp:albumArtURI>${xml(track.artwork)}</upnp:albumArtURI>` : ''}<res protocolInfo="http-get:*:audio/mpeg:*">${xml(track.uri)}</res></item></DIDL-Lite>`;
}
export class Sonos {
  rooms = new Map<string, Room>();
  private queues = new Map<string, Track[]>();
  private refreshTask?: Promise<Room[]>;
  private scanTask?: Promise<Room[]>;
  constructor(public readonly mock = process.env.SONOS_MOCK === '1') {
    if (mock)
      ['Studio', 'Lounge', 'Terrace'].forEach((name, i) => {
        const id = `MOCK_${i}`;
        this.rooms.set(id, {
          id,
          name,
          model: 'Connect · simulated',
          host: 'mock',
          coordinator: id,
          group: id,
          volume: [28, 35, 18][i],
          mute: false,
          state: i ? 'PAUSED_PLAYBACK' : 'PLAYING',
          position: 74,
          duration: 284,
          online: true,
          lineIn: true,
          track: {
            id: 'demo-1',
            title: 'Late night currents',
            artist: 'Demo collection · simulated audio',
            artwork: '/artwork.svg',
            duration: 284,
          },
        });
        this.queues.set(id, [
          {
            id: 'demo-1',
            title: 'Late night currents',
            artist: 'Demo collection',
            artwork: '/artwork.svg',
          },
          {
            id: 'demo-2',
            title: 'A softer kind of light',
            artist: 'Demo collection',
            artwork: '/artwork.svg',
          },
        ]);
      });
  }
  room(id: string) {
    const r = this.rooms.get(id);
    if (!r) throw new Error('Room not found. Run discovery first.');
    return r;
  }
  coordinator(id: string) {
    return this.room(this.room(id).coordinator);
  }
  async soap(
    id: string,
    service: string,
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    const room = this.room(id);
    if (this.mock) throw new Error('SOAP not available in mock mode');
    const section =
      service === 'ContentDirectory'
        ? 'MediaServer'
        : ['ZoneGroupTopology', 'DeviceProperties', 'AudioIn'].includes(service)
          ? ''
          : 'MediaRenderer';
    const path = `${section ? `/${section}` : ''}/${service}/Control`;
    const type = `urn:schemas-upnp-org:service:${service}:1`;
    const response = await fetch(`http://${room.host}:1400${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#${action}"` },
      body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${Object.entries(
        args,
      )
        .map(([k, v]) => `<${k}>${xml(v)}</${k}>`)
        .join('')}</u:${action}></s:Body></s:Envelope>`,
      signal: AbortSignal.timeout(4500),
      redirect: 'error',
    });
    const result = parseXml(await response.text())?.Envelope?.Body;
    if (!response.ok || result?.Fault) {
      const code = result?.Fault?.detail?.UPnPError?.errorCode || response.status;
      diagnose(
        'Sonos',
        String(code),
        `${action} failed on ${room.name}`,
        Number(code) === 714
          ? 'The track format or URI was rejected. Try the MP3 gateway or an authorized line-in source.'
          : 'Check the speaker connection, group coordinator, and source availability.',
      );
      throw new Error(`Sonos ${action} failed (${code})`);
    }
    return result?.[`${action}Response`] || {};
  }
  async discover(): Promise<Room[]> {
    if (this.mock) return [...this.rooms.values()];
    if (this.scanTask) return this.scanTask;
    this.scanTask = this.scan().finally(() => {
      this.scanTask = undefined;
    });
    return this.scanTask;
  }
  private async scan() {
    const locations = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const timer = setTimeout(() => {
        socket.close();
        resolve();
      }, 3500);
      socket.on('error', (err) => {
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
      socket.on('message', (message) => {
        const location = message
          .toString()
          .match(/^location:\s*(.+)$/im)?.[1]
          ?.trim();
        if (location && locations.size < 64) {
          try {
            locations.add(discoveryLocation(location).href);
          } catch {}
        }
      });
      socket.bind(0, () => {
        if (process.env.SONOS_INTERFACE) socket.setMulticastInterface(process.env.SONOS_INTERFACE);
        socket.setMulticastTTL(2);
        const packet = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n',
        );
        socket.send(packet, 1900, '239.255.255.250');
        setTimeout(() => {
          try {
            socket.send(packet, 1900, '239.255.255.250');
          } catch {}
        }, 600).unref();
      });
    });
    for (const location of locations) {
      try {
        const response = await fetch(location, {
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        });
        if (!response.ok) continue;
        const device = parseXml(await response.text())?.root?.device;
        if (!String(device?.manufacturer).includes('Sonos')) continue;
        const id = String(device.UDN).replace(/^uuid:/, '');
        if (!/^RINCON_[\w]+$/.test(id)) continue;
        const previous = this.rooms.get(id);
        this.rooms.set(id, {
          id,
          name: String(device.roomName || device.friendlyName),
          model: String(device.modelName),
          coordinator: id,
          group: id,
          volume: 0,
          mute: false,
          state: 'STOPPED',
          position: 0,
          duration: 0,
          online: true,
          lineIn: /connect|zoneplayer|zp80|zp90|amp|port/i.test(String(device.modelName)),
          ...previous,
          ...{ host: new URL(location).hostname },
        });
      } catch {
        diagnose(
          'Discovery',
          'DESCRIPTION',
          'A speaker description could not be read',
          'Allow this Mac to reach Sonos TCP port 1400.',
        );
      }
    }
    return this.refresh();
  }
  async refresh(): Promise<Room[]> {
    if (this.mock) return [...this.rooms.values()];
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.poll().finally(() => {
      this.refreshTask = undefined;
    });
    return this.refreshTask;
  }
  private async poll() {
    for (const r of this.rooms.values()) {
      try {
        const topology = await this.soap(r.id, 'ZoneGroupTopology', 'GetZoneGroupState');
        const groups = list<any>(parseXml(topology.ZoneGroupState).ZoneGroups?.ZoneGroup);
        for (const g of groups)
          for (const m of list<any>(g.ZoneGroupMember)) {
            const room = this.rooms.get(String(m['@_UUID']));
            if (room) {
              room.coordinator = String(g['@_Coordinator']);
              room.group = String(g['@_ID']);
              room.name = String(m['@_ZoneName'] || room.name);
            }
          }
        break;
      } catch {}
    }
    const pending = [...this.rooms.values()];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        for (let r = pending.pop(); r; r = pending.pop()) {
          try {
            const coordinator = this.rooms.has(r.coordinator) ? r.coordinator : r.id;
            const [transport, position, volume, mute] = await Promise.all([
              this.soap(coordinator, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
              this.soap(coordinator, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
              this.soap(r.id, 'RenderingControl', 'GetVolume', {
                InstanceID: 0,
                Channel: 'Master',
              }),
              this.soap(r.id, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }),
            ]);
            r.state = transport.CurrentTransportState;
            r.position = seconds(position.RelTime);
            r.duration = seconds(position.TrackDuration);
            r.volume = Number(volume.CurrentVolume);
            r.mute = String(mute.CurrentMute) === '1';
            r.online = true;
            const item =
              position.TrackMetaData && position.TrackMetaData !== 'NOT_IMPLEMENTED'
                ? parseXml(position.TrackMetaData)?.['DIDL-Lite']?.item
                : null;
            r.track = item
              ? fromItem(list<any>(item)[0])
              : position.TrackURI
                ? {
                    id: position.TrackURI,
                    uri: position.TrackURI,
                    title: 'Network audio',
                    artist: '',
                  }
                : undefined;
            if (r.track?.artwork?.startsWith('/'))
              r.track.artwork = `http://${r.host}:1400${r.track.artwork}`;
          } catch {
            r.online = false;
          }
        }
      }),
    );
    return [...this.rooms.values()];
  }
  async control(id: string, action: string, value?: number | boolean) {
    const room = this.room(id),
      c = this.coordinator(id);
    if (this.mock) {
      if (action === 'volume') room.volume = Number(value);
      else if (action === 'mute') room.mute = Boolean(value);
      else if (action === 'seek')
        [...this.rooms.values()]
          .filter((r) => r.coordinator === c.id)
          .forEach((r) => (r.position = Number(value)));
      else if (action === 'next' || action === 'previous') {
        const q = this.queues.get(c.id) || [];
        const index = q.findIndex((t) => t.id === c.track?.id);
        const track = q[(index + (action === 'next' ? 1 : -1) + q.length) % q.length];
        [...this.rooms.values()]
          .filter((r) => r.coordinator === c.id)
          .forEach((r) => {
            r.track = track;
            r.position = 0;
          });
      } else
        [...this.rooms.values()]
          .filter((r) => r.coordinator === c.id)
          .forEach(
            (r) =>
              (r.state =
                action === 'play' ? 'PLAYING' : action === 'pause' ? 'PAUSED_PLAYBACK' : 'STOPPED'),
          );
      return;
    }
    if (action === 'volume' || action === 'mute')
      return this.soap(id, 'RenderingControl', action === 'volume' ? 'SetVolume' : 'SetMute', {
        InstanceID: 0,
        Channel: 'Master',
        [action === 'volume' ? 'DesiredVolume' : 'DesiredMute']:
          action === 'volume' ? value : value ? 1 : 0,
      });
    if (action === 'seek')
      return this.soap(c.id, 'AVTransport', 'Seek', {
        InstanceID: 0,
        Unit: 'REL_TIME',
        Target: new Date(Number(value) * 1000).toISOString().slice(11, 19),
      });
    const actions: Record<string, string> = {
      play: 'Play',
      pause: 'Pause',
      stop: 'Stop',
      next: 'Next',
      previous: 'Previous',
    };
    if (!actions[action]) throw new Error('Unknown transport command');
    return this.soap(c.id, 'AVTransport', actions[action], {
      InstanceID: 0,
      ...(action === 'play' ? { Speed: 1 } : {}),
    });
  }
  async group(id: string, target?: string) {
    const room = this.room(id);
    const coordinator = target ? this.coordinator(target) : undefined;
    if (coordinator?.id === id) return;
    if (this.mock) {
      if (room.coordinator === id) {
        const followers = [...this.rooms.values()].filter(
          (r) => r.id !== id && r.coordinator === id,
        );
        const replacement = followers[0];
        if (replacement)
          followers.forEach((r) => {
            r.coordinator = replacement.id;
            r.group = replacement.id;
          });
      }
      room.coordinator = coordinator?.id || id;
      room.group = room.coordinator;
      if (coordinator) {
        room.track = coordinator.track;
        room.state = coordinator.state;
      }
      return;
    }
    if (!coordinator)
      await this.soap(id, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 });
    else
      await this.soap(id, 'AVTransport', 'SetAVTransportURI', {
        InstanceID: 0,
        CurrentURI: `x-rincon:${coordinator.id}`,
        CurrentURIMetaData: '',
      });
  }
  async playUri(id: string, track: Track) {
    const c = this.coordinator(id);
    if (this.mock) {
      [...this.rooms.values()]
        .filter((r) => r.coordinator === c.id)
        .forEach((r) => {
          r.track = track;
          r.state = 'PLAYING';
          r.position = 0;
        });
      return;
    }
    if (track.uri?.startsWith('x-rincon-cpcontainer:')) {
      const added = await this.soap(c.id, 'AVTransport', 'AddURIToQueue', {
        InstanceID: 0,
        EnqueuedURI: track.uri,
        EnqueuedURIMetaData: track.metadata ?? didl(track),
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: 0,
      });
      await this.queue(id, 'play', {
        index: Math.max(0, Number(added.FirstTrackNumberEnqueued || 1) - 1),
      });
      return;
    }
    await this.soap(c.id, 'AVTransport', 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: track.uri,
      CurrentURIMetaData: track.metadata ?? didl(track),
    });
    await this.control(c.id, 'play');
  }
  async browse(id: string, objectId: string): Promise<Track[]> {
    const c = this.coordinator(id);
    if (this.mock)
      return objectId === 'Q:0'
        ? this.queues.get(c.id) || []
        : [
            {
              id: 'favorite-demo',
              title: 'Your Sonos favorites appear here',
              artist: 'Demo station',
              uri: 'https://example.com/demo.mp3',
              artwork: '/artwork.svg',
            },
          ];
    const result = await this.soap(c.id, 'ContentDirectory', 'Browse', {
      ObjectID: objectId,
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: 200,
      SortCriteria: '',
    });
    const doc = parseXml(result.Result)?.['DIDL-Lite'];
    return list<any>(doc?.item).map((item) => ({
      ...fromItem(item),
      metadata: item.resMD || undefined,
    }));
  }
  async queue(id: string, action: string, options: { track?: Track; index?: number } = {}) {
    const c = this.coordinator(id);
    if (this.mock) {
      const q = this.queues.get(c.id) || [];
      if (action === 'add' && options.track) q.push(options.track);
      if (action === 'remove') q.splice(options.index!, 1);
      if (action === 'clear') q.splice(0);
      if (action === 'play' && q[options.index!]) await this.playUri(id, q[options.index!]);
      this.queues.set(c.id, q);
      return;
    }
    if (action === 'add')
      await this.soap(c.id, 'AVTransport', 'AddURIToQueue', {
        InstanceID: 0,
        EnqueuedURI: options.track?.uri,
        EnqueuedURIMetaData: options.track?.metadata ?? didl(options.track!),
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: 0,
      });
    if (action === 'remove')
      await this.soap(c.id, 'AVTransport', 'RemoveTrackFromQueue', {
        InstanceID: 0,
        ObjectID: `Q:0/${options.index! + 1}`,
        UpdateID: 0,
      });
    if (action === 'clear')
      await this.soap(c.id, 'AVTransport', 'RemoveAllTracksFromQueue', { InstanceID: 0 });
    if (action === 'play') {
      await this.soap(c.id, 'AVTransport', 'SetAVTransportURI', {
        InstanceID: 0,
        CurrentURI: `x-rincon-queue:${c.id}#0`,
        CurrentURIMetaData: '',
      });
      await this.soap(c.id, 'AVTransport', 'Seek', {
        InstanceID: 0,
        Unit: 'TRACK_NR',
        Target: options.index! + 1,
      });
      await this.control(c.id, 'play');
    }
  }
}
