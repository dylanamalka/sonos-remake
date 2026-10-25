# Diagnostics and troubleshooting

Open **Settings → Open diagnostics**. Entries are session-local and include time, source, safe error summary, and next step. Copy the relevant error code and behavior, not `.env`, stream bearer URLs, or token files.

## No rooms discovered

Run Current on your Mac, not in the cloud. Put the Mac and speakers on the same subnet; guest Wi-Fi/client isolation blocks communication. SSDP uses outbound UDP multicast `239.255.255.250:1900` and replies to the Mac’s ephemeral UDP port. SOAP/device descriptions use TCP 1400. Allow the Node process in macOS network/firewall prompts. If using Ethernet and Wi-Fi/VPN, set `SONOS_INTERFACE` to the correct Mac interface’s local IPv4 address. Set it only to an address assigned to that Mac. Do not upgrade S1 devices or reset them to fix discovery.

The app does not bridge multicast across VLANs. A professional installer may need to allow SSDP and TCP communication between the controller and audio-rack VLAN. Rediscover after changing the network. Offline speakers remain visible so failures are not hidden.

## Commands fail / rooms are offline

Check the official S1 app still sees the speakers. Wake the Mac, verify Wi-Fi and power, and rediscover after DHCP changes. UPnP fault 701 generally means the command is not available in the current transport state; 714 points to an invalid/rejected URI, but does not prove which codec failed. Queue browsing, favorite formats, line-in detection, and group changes need real-device verification. Bonded/surround devices and cross-household systems are outside the tested scope. Multiple active controllers can change topology between polls; refresh before retrying.

## Optional SoundCloud API playback fails

1. Check the account is connected, then reconnect if a 401 indicates revoked/expired credentials. A 403 can reflect account/app/track access restrictions; a 429 is a rate limit, so wait. Do not repeatedly retry the same failing request.
2. Confirm the full track plays in the official SoundCloud app in your region. That does not guarantee public-API eligibility.
3. Check access and stream format. The app refuses previews/blocked content, AAC HLS, encrypted HLS, incomplete playlists, non-MP3 segments, and unsupported media hosts. The public API may not return a full playable stream for your remix. It does not substitute the preview or scrape the website.
4. If an eligible MP3 reaches the gateway but Sonos rejects it, test an owned local MP3 through the gateway to isolate networking from SoundCloud delivery. HLS concatenation has no seeking and still needs S1 firmware testing.
5. Prefer the existing Sonos SoundCloud service if it works, or the official SoundCloud app connected physically to a Connect line-in. Source playback stays in SoundCloud. The app cannot grant access to removed, geo-blocked, or otherwise restricted tracks.

SoundCloud progressive MP3 is optional/legacy and absent from the current stream schema. Modern AAC HLS is deliberately not fed into FFmpeg by this app. Supporting more formats requires verifying both content rights and the relevant API terms; do not assume a token authorizes arbitrary copying or transformation.

## Gateway unreachable

Set `PUBLIC_BASE_URL` to the Mac’s stable, speaker-reachable LAN origin. Allow inbound TCP on the chosen port. A localhost address, cloud URL, or a hostname speakers cannot resolve will fail. Old S1 devices may not trust a private HTTPS certificate; prefer a private LAN HTTP origin for gateway audio. Start playback again after restarting the server because previous in-memory grants expire. Queued gateway URLs also need to be re-added after 24 hours. Sonos native service URIs are independent of these grants.

For local-file conversion install FFmpeg (`brew install ffmpeg`) or set `FFMPEG_PATH` to an installed binary. A valid local file is required. Conversion does not support seeking or byte ranges. Direct MP3 files do. Very large groups and concurrent conversions need performance testing on your Mac.

## iPhone / PWA / trusted local HTTPS

Use the Mac’s LAN address, never `localhost` on the iPhone. Pair each browser after a controller restart. Keep the Mac awake; the service is not installed as a launch agent. LAN HTTP works for the app, but full service-worker/PWA functionality requires trusted HTTPS. You may place a trusted local reverse proxy in front of port 3000, using the same host via PUBLIC_BASE_URL host configuration for host validation. The proxy must preserve Host/Origin. Leave the speaker gateway on reachable LAN HTTP; no remote tunnel or public port forwarding is needed. Serve artwork over a trusted origin too if the browser blocks a speaker’s HTTP artwork as mixed content. Controls do not depend on artwork rendering. Certificate installation/proxy setup is not automated here.

## Sources and investigation scope

Reviewed SoundCloud’s public [OpenAPI source](https://github.com/soundcloud/api/blob/master/openapi/api.yaml) and [integration notes](https://github.com/soundcloud/api/blob/master/Agents.md), at commit `33092b81ff8011f1d97441ea6202d176c1cf19c2`, during implementation. These describe OAuth, URNs, and HLS/preview streams. See the [authentication guide](https://developers.soundcloud.com/docs/api/guide#authentication) and [API terms](https://developers.soundcloud.com/docs/api/terms-of-use) when registering your application. Direct developer/support web pages were inaccessible from this cloud machine; the official public Git repository was available.

For Sonos format limits consult [supported audio formats](https://support.sonos.com/en-us/article/supported-audio-formats-for-sonos-music-library) for your model/S1 firmware. This implementation intentionally targets MP3 at 44.1 kHz stereo, and uses 192 kbps for local conversions, rather than claiming support for every S1 codec. Without physical speakers and your SoundCloud credentials, no specific cause or universal fix for your failing tracks has been verified.

## Credential-free Mac line-in

Use the recommended SoundCloud tab's setup and status first. No API variables, PUBLIC_BASE_URL, FFmpeg, ScreenCaptureKit permission, or BlackHole installation are required for the wired route. Connect the Mac output to a Connect/Connect:Amp input, choose the correct wired output in macOS, and start music in the normal SoundCloud browser. Select source and destinations in Current. The source can be excluded from the listening rooms. “Input selected” confirms Sonos transport, not audible music; check Mac volume and Sonos source-level/compression/mute if silent.

If room routing partially fails, Current reports the failure and which steps may already have changed groups. Fix the offline device or cable and use Reconnect. It waits for topology rather than assuming immediate group convergence. It does not loop indefinitely or automatically take over a source another controller selected. Stop does not stop a different source; it also does not pause SoundCloud's website. If another controller subsequently adds rooms to the same group, transport stop affects that whole active group.

The optional software prototype's recording permission is unrelated to wired playback. Do not grant broader permissions or install a virtual driver just to troubleshoot line-in. For the comparative investigation and exact physical/optional prototype steps, see [SoundCloud decision](SOUNDCLOUD-DECISION.md) and [prototype README](../prototypes/mac-audio/README.md).
