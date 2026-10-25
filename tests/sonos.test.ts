import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sonos, xml, parseXml, seconds, discoveryLocation, didl } from '../server/sonos';
import { playbackUri } from '../server/api';
test('SSDP accepts LAN speaker URLs and rejects remote, credential, and metadata URLs', () => {
  assert.equal(
    discoveryLocation('http://192.168.1.24:1400/xml/device_description.xml').hostname,
    '192.168.1.24',
  );
  for (const value of [
    'https://192.168.1.24:1400/x',
    'http://example.com:1400/x',
    'http://127.0.0.1:1400/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://user:pass@192.168.1.2:1400/',
  ])
    assert.throws(() => discoveryLocation(value));
});
test('SOAP escaping, metadata decoding, duration, and unsafe XML rejection', () => {
  assert.equal(xml('<&"\''), '&lt;&amp;&quot;&apos;');
  const track = {
    id: '1',
    title: 'A < B & C',
    artist: 'DJ > X',
    uri: 'http://music.local/a.mp3?a=1&b=2',
  };
  assert.equal(parseXml(didl(track))['DIDL-Lite'].item.title, track.title);
  assert.equal(seconds('01:02:03'), 3723);
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'));
});
test('mock controller routes transport to the coordinator, keeps volume individual, and ungroups', async () => {
  const s = new Sonos(true);
  assert.equal((await s.discover()).length, 3);
  await s.group('MOCK_1', 'MOCK_0');
  await s.control('MOCK_1', 'pause');
  assert.equal(s.room('MOCK_0').state, 'PAUSED_PLAYBACK');
  assert.equal(s.room('MOCK_1').state, 'PAUSED_PLAYBACK');
  await s.control('MOCK_1', 'volume', 65);
  assert.equal(s.room('MOCK_1').volume, 65);
  assert.equal(s.room('MOCK_0').volume, 28);
  await s.control('MOCK_1', 'mute', true);
  assert.equal(s.room('MOCK_1').mute, true);
  await s.playUri('MOCK_1', {
    id: 'track',
    title: 'Authorized audio',
    artist: 'Test',
    uri: 'http://192.168.1.2/a.mp3',
  });
  assert.equal(s.room('MOCK_0').track?.id, 'track');
  assert.equal(s.room('MOCK_1').track?.id, 'track');
  await s.group('MOCK_1');
  await s.control('MOCK_1', 'pause');
  assert.equal(s.room('MOCK_0').state, 'PLAYING');
});
test('mock queue add, play, remove, clear operate on group coordinator', async () => {
  const s = new Sonos(true);
  await s.group('MOCK_1', 'MOCK_0');
  await s.queue('MOCK_1', 'add', {
    track: { id: 'new', title: 'New', artist: 'Test', uri: 'http://test/new.mp3' },
  });
  assert.equal((await s.browse('MOCK_0', 'Q:0')).length, 3);
  await s.queue('MOCK_1', 'play', { index: 2 });
  assert.equal(s.room('MOCK_0').track?.id, 'new');
  await s.queue('MOCK_1', 'remove', { index: 0 });
  assert.equal((await s.browse('MOCK_0', 'Q:0')).length, 2);
  await s.queue('MOCK_1', 'clear');
  assert.equal((await s.browse('MOCK_0', 'Q:0')).length, 0);
});
test('real SOAP uses correct service, escaping, coordinator, and reports UPnP faults', async () => {
  const s = new Sonos(false);
  const r = new Sonos(true).room('MOCK_0');
  s.rooms.set('RINCON_TEST', {
    ...r,
    id: 'RINCON_TEST',
    coordinator: 'RINCON_TEST',
    host: '192.168.1.50',
  });
  const original = global.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"/></s:Body></s:Envelope>',
    );
  };
  try {
    await s.control('RINCON_TEST', 'volume', 27);
    assert.match(calls[0].url, /MediaRenderer\/RenderingControl\/Control$/);
    assert.match(String(calls[0].options.body), /<DesiredVolume>27<\/DesiredVolume>/);
    global.fetch = async () =>
      new Response(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>714</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
        { status: 500 },
      );
    await assert.rejects(s.control('RINCON_TEST', 'play'), /714/);
  } finally {
    global.fetch = original;
  }
});
test('direct playback rejects file, script, and embedded credentials', () => {
  for (const v of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:secret@music.local/a'])
    assert.throws(() => playbackUri(v));
  assert.equal(playbackUri('x-sonosapi-stream:s123?sid=254'), 'x-sonosapi-stream:s123?sid=254');
});
test('polling reads the actual transport URI even when line-in has no track URI or metadata', async () => {
  const s = new Sonos(false),
    fixture = new Sonos(true).room('MOCK_0');
  s.rooms.set('RINCON_TEST', {
    ...fixture,
    id: 'RINCON_TEST',
    host: '192.168.1.50',
    coordinator: 'RINCON_TEST',
    track: undefined,
    lineInConnected: undefined,
  });
  const original = global.fetch;
  global.fetch = async (_input, options) => {
    const body = String(options?.body);
    const action = body.match(/<u:(\w+) /)![1];
    const value: Record<string, string> = {
      GetZoneGroupState: `<ZoneGroupState>${xml('<ZoneGroups><ZoneGroup Coordinator="RINCON_TEST" ID="test:0"><ZoneGroupMember UUID="RINCON_TEST" ZoneName="Rack input" LineInConnected="true" /></ZoneGroup></ZoneGroups>')}</ZoneGroupState>`,
      GetTransportInfo: '<CurrentTransportState>PLAYING</CurrentTransportState>',
      GetPositionInfo:
        '<TrackURI></TrackURI><TrackMetaData></TrackMetaData><TrackDuration>00:00:00</TrackDuration><RelTime>00:00:00</RelTime>',
      GetMediaInfo: '<CurrentURI>x-rincon-stream:RINCON_TEST</CurrentURI>',
      GetVolume: '<CurrentVolume>25</CurrentVolume>',
      GetMute: '<CurrentMute>0</CurrentMute>',
    };
    assert.ok(action in value, `expected SOAP operation ${action}`);
    return new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:test:1">${value[action]}</u:${action}Response></s:Body></s:Envelope>`,
    );
  };
  try {
    const [r] = await s.refresh();
    assert.equal(r.online, true);
    assert.equal(r.lineInConnected, true);
    assert.equal(r.transportUri, 'x-rincon-stream:RINCON_TEST');
    assert.equal(r.track, undefined);
    assert.equal(r.volume, 25);
  } finally {
    global.fetch = original;
  }
});
