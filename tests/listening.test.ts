import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const dir = await mkdtemp(path.join(os.tmpdir(), 'current-listen-'));
process.env.SONOS_DATA_DIR = dir;
const { Sonos } = await import('../server/sonos');
const { Listening, listeningProfile } = await import('../server/listening');
const profile = { sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_1', 'MOCK_2'] };
test('saved line-in selection routes a source outside the destination group, preserves volume/mute and survives service restart', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  s.room('MOCK_2').mute = true;
  await service.save(profile);
  assert.deepEqual((await service.status()).profile, profile);
  const result = await service.connect();
  assert.equal(result.phase, 'input-selected');
  assert.equal(result.audiblePlaybackVerified, false);
  assert.equal(s.room('MOCK_2').coordinator, 'MOCK_1');
  assert.equal(s.room('MOCK_1').track?.uri, 'x-rincon-stream:MOCK_0');
  assert.equal(
    s.room('MOCK_0').track?.id,
    'demo-1',
    'source hardware need not play its own line-in',
  );
  assert.equal(s.room('MOCK_2').volume, 18);
  assert.equal(s.room('MOCK_2').mute, true);
  const restarted = new Listening(s);
  assert.deepEqual((await restarted.status()).profile, profile);
  assert.equal((await restarted.status()).phase, 'input-selected');
  await restarted.stop();
  assert.equal(s.room('MOCK_1').state, 'STOPPED');
  assert.equal((await restarted.status()).phase, 'input-paused');
  await restarted.connect();
  assert.equal(s.room('MOCK_1').state, 'PLAYING');
});
test('single-room route splits only the selected room away from unrelated rooms', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  await s.group('MOCK_1', 'MOCK_0');
  await s.group('MOCK_2', 'MOCK_0');
  await service.save({ sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_0'] });
  await service.connect();
  assert.equal(s.room('MOCK_0').coordinator, 'MOCK_0');
  assert.equal(s.room('MOCK_1').coordinator, 'MOCK_1');
  assert.equal(s.room('MOCK_2').coordinator, 'MOCK_1');
  assert.equal(s.room('MOCK_2').track?.id, 'demo-1');
});
test('invalid room, missing cable, and offline source are rejected before changing groups; reconnect recovers', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  await service.save(profile);
  await assert.rejects(service.save({ ...profile, targetRoomIds: ['MISSING'] }), /Room not found/);
  assert.deepEqual(await listeningProfile.read(), profile);
  s.room('MOCK_0').lineInConnected = false;
  await assert.rejects(service.connect(), /no line-in cable/);
  assert.equal(s.room('MOCK_2').coordinator, 'MOCK_2');
  assert.equal((await service.status()).phase, 'error');
  s.room('MOCK_0').lineInConnected = undefined;
  s.room('MOCK_0').online = false;
  await assert.rejects(service.connect(), /offline/);
  s.room('MOCK_0').online = true;
  assert.equal((await service.connect()).phase, 'input-selected');
});
test('partial group failure is explicit, concurrent routing is rejected, and retry releases the lock', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  await service.save({ sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_0', 'MOCK_1', 'MOCK_2'] });
  const group = s.group.bind(s);
  s.group = async (id, target) => {
    if (id === 'MOCK_2') throw new Error('Speaker unreachable');
    return group(id, target);
  };
  const first = service.connect();
  await assert.rejects(service.connect(), /already in progress/);
  await assert.rejects(first, /Some room groups were already changed/);
  assert.equal((await service.status()).phase, 'error');
  s.group = group;
  assert.equal((await service.connect()).phase, 'input-selected');
});
test('stop skips a different source and opening SoundCloud is mocked without spawning a browser', async () => {
  const s = new Sonos(true),
    service = new Listening(s, async () => {
      throw new Error('must not run');
    });
  await service.save(profile);
  await service.connect();
  await s.playUri('MOCK_1', {
    id: 'other',
    title: 'Another source',
    artist: 'Test',
    uri: 'https://example.com/a.mp3',
  });
  assert.equal((await service.stop()).stoppedGroups, 0);
  assert.equal(s.room('MOCK_1').state, 'PLAYING');
  assert.equal((await service.openBrowser()).simulated, true);
  const native = new Sonos(false);
  const unsupported = new Listening(native, async () => {
    throw new Error('OS launch unavailable');
  });
  await assert.rejects(unsupported.openBrowser(), /OS launch unavailable/);
});
test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
test('routing waits for delayed group topology before starting the line-in', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  await service.save({ sourceRoomId: 'MOCK_0', targetRoomIds: ['MOCK_0', 'MOCK_1', 'MOCK_2'] });
  const originalGroup = s.group.bind(s),
    originalPlay = s.playUri.bind(s);
  s.group = async (id, target) => {
    setTimeout(() => void originalGroup(id, target), 70);
  };
  s.playUri = async (id, track) => {
    assert.equal(s.room('MOCK_1').coordinator, 'MOCK_0');
    assert.equal(s.room('MOCK_2').coordinator, 'MOCK_0');
    return originalPlay(id, track);
  };
  assert.equal((await service.connect()).phase, 'input-selected');
});
test('a stop in flight prevents conflicting profile/connect mutations and browser launch is rate limited', async () => {
  const s = new Sonos(true),
    service = new Listening(s);
  await service.save(profile);
  await service.connect();
  const control = s.control.bind(s);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => (finish = resolve));
  s.control = async (id, action, value) => {
    await blocked;
    return control(id, action, value);
  };
  const stopping = service.stop();
  await assert.rejects(service.connect(), /already in progress/);
  await assert.rejects(service.save(profile), /already in progress/);
  finish();
  await stopping;
  assert.equal((await service.connect()).phase, 'input-selected');
  await service.openBrowser();
  await assert.rejects(service.openBrowser(), /just opened/);
});
