import { Sonos } from './sonos';
import { StreamError } from './mac-capture';
export async function waitForSonos(
  sonos: Sonos,
  check: () => boolean,
  message: string,
  cancelled = () => false,
) {
  for (const delay of [0, 200, 500, 1000, 2000]) {
    if (cancelled()) throw new StreamError('CANCELLED', 'Stream session was cancelled.', 409);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await sonos.refresh();
    if (check()) return;
  }
  throw new StreamError('SONOS_TOPOLOGY', message);
}
export async function routeNetworkRooms(
  sonos: Sonos,
  ids: string[],
  progress: (message: string) => void,
  cancelled = () => false,
) {
  await sonos.refresh();
  for (const id of ids) {
    const room = sonos.room(id);
    if (!room.online)
      throw new StreamError(
        'SONOS_OFFLINE',
        `${room.name} is offline. Reconnect it or change the room selection.`,
      );
  }
  const anchor = ids[0];
  for (const id of ids) {
    if (cancelled()) throw new StreamError('CANCELLED', 'Cancelled', 409);
    const r = sonos.room(id);
    if (
      r.coordinator === id &&
      [...sonos.rooms.values()].some((room) => room.coordinator === id && !ids.includes(room.id))
    ) {
      progress(`Separating ${r.name} from its previous group…`);
      await sonos.group(id);
      await waitForSonos(
        sonos,
        () => sonos.room(id).coordinator === id,
        'A selected room did not leave its previous group.',
        cancelled,
      );
    }
  }
  if (sonos.room(anchor).coordinator !== anchor) {
    await sonos.group(anchor);
    await waitForSonos(
      sonos,
      () => sonos.room(anchor).coordinator === anchor,
      'The destination coordinator did not become independent.',
      cancelled,
    );
  }
  for (const id of ids.slice(1)) {
    if (cancelled()) throw new StreamError('CANCELLED', 'Cancelled', 409);
    if (sonos.room(id).coordinator !== anchor) {
      progress(`Grouping ${sonos.room(id).name}…`);
      await sonos.group(id, anchor);
    }
  }
  await waitForSonos(
    sonos,
    () => ids.every((id) => sonos.room(id).coordinator === anchor),
    'Selected rooms did not confirm their synchronized group.',
    cancelled,
  );
  return anchor;
}
