import { privateIPv4, xml } from './sonos';
export function radioUri(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !privateIPv4(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('The radio gateway must be a private IPv4 HTTP URL reachable by Sonos.');
  // SoCo force_radio replaces the protocol; it does NOT prepend to the full http:// URI.
  return value.replace(/^http:/, 'x-rincon-mp3radio:');
}
export function radioMetadata(value: string, title = 'Current · Stream from Mac') {
  radioUri(value);
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="R:0/0/0" parentID="R:0/0" restricted="true"><dc:title>${xml(title)}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><res protocolInfo="http-get:*:audio/mpeg:*">${xml(value)}</res><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>`;
}
