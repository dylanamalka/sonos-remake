# Stream from Mac: network-only SoundCloud playback

## Delivered architecture

```text
SoundCloud's normal Chrome / Safari player on the Mac
  → ScreenCaptureKit positive allowlist of that browser application
  → Float32 48 kHz stereo PCM, clocked with silence keep-alive
  → local FFmpeg → MPEG-1 Layer III MP3, 44.1 kHz stereo, 192 kbps
  → private continuous HTTP radio endpoint on Current's existing port
  → AVTransport.SetAVTransportURI(x-rincon-mp3radio://MAC:PORT/live/GRANT.mp3)
  → Sonos group coordinator → existing synchronized Sonos group
```

**No RCA cable, new hardware, virtual driver, SoundCloud developer credentials, or Sonos firmware/service installation is used.** Only transient playback/group commands go to the existing devices. SoundCloud authentication and track selection remain in the normal browser; no media URL interception, DOM automation, cookie extraction, downloading, decryption, or access-restriction bypass is implemented.

The network path is implemented as Current's primary SoundCloud option, not a terminal-only prototype. The earlier RCA workflow and optional API library remain separate fallback tabs. The previous decision report is historical; it does not govern this network-only implementation.

**Verification boundary:** Linux tests exercised real PCM/MP3 encoding and HTTP audio, a fake native-helper process protocol, and simulated Sonos SOAP/room state. This environment has no macOS SDK, real Mac recording permissions, or access to the user's nine speakers. The native helper has not been compiled/run here. No particular S1 device, actual SoundCloud browser capture, audible playback, or receiver delay has been certified. There is no observed S1 failure to conceal and no claimed hardware success.

## Exact Mac update and setup

Stop the existing Current process with Ctrl-C. In the existing repository checkout:

```bash
git pull --ff-only
npm ci
brew install ffmpeg
npm run capture:build
npm run build
npm start
```

If Apple Command Line Tools are missing, run `xcode-select --install`, finish the macOS installation, then rerun `npm run capture:build`. macOS 13 or newer and a macOS SDK supporting ScreenCaptureKit audio are required. Existing Node 22+ and Git prerequisites remain. Rebuild the helper after source updates: Current checks a hash of the Swift and Objective-C source before launching it. There is no downloaded capture binary, paid hosting, privileged installation, virtual driver, or background recording daemon.

Do not overwrite `.env`, `.local/settings.json`, or other existing preferences. A new `.local/network-stream.json` stores only browser, destinations, HTTP mode, and buffer preferences. Re-pair the browser after a server restart using the existing terminal code. Native binaries/build products stay under ignored `.local/mac-capture/`.

1. Open **SoundCloud → Stream from Mac** in Current.
2. Choose Chrome (default) or Safari and the destination rooms. Existing groups are initially selected where appropriate. A multi-room selection creates one Sonos-coordinated group; selected rooms may leave prior groups. Volume/mute are preserved.
3. Click **Stream from Mac**. The selected browser is opened to the official SoundCloud website on the Mac. Sign in normally if necessary.
4. On the Mac, grant **Screen Recording** or **Screen & System Audio Recording** permission to **Current Audio Capture** or the launcher/terminal identified by macOS. Wording/attribution varies by release. This is explicit public-API consent. The app does not change TCC, use private permission APIs, or request microphone access. If macOS requires restarting the launcher, restart Current and choose Reconnect.
5. Play a track normally in that browser. All tabs/audio associated with the selected browser application may be captured; use an otherwise-idle browser. This is not per-tab or per-profile isolation. Other applications are excluded using a positive application filter, not a snapshot exclusion list.
6. Check capture signal, encoded frames, HTTP readers, and transport status. **“Audio bytes are flowing” is not proof of audible output.** Verify by listening.

The native helper needs an active graphical login/session and a display visible to ScreenCaptureKit. If the headless Mac exposes no display, `DISPLAY_UNAVAILABLE` is reported. First test its existing logged-in or existing Screen Sharing session. No cable/display purchase is prescribed as a workaround, and no headless compatibility is invented. Core Audio process taps would be a separate macOS-14.4+ capture backend if actual SCK evidence warrants it; they do not remove Sonos radio transport constraints.

## LAN address and security

The existing Current HTTP port serves audio; there is no separate Icecast daemon or extra mandatory port. By default Current selects an unambiguous private IPv4 interface matching discovered Sonos addresses (or the configured `SONOS_INTERFACE`). If ambiguous, set the Mac's actual speaker-reachable origin in `.env`:

```dotenv
PUBLIC_BASE_URL=http://192.168.1.50:3000
```

Replace the example with the Mac's real LAN address and the actual Current port. Restart after changing `.env`. Use HTTP for the S1-facing audio URL: old devices may not trust a private HTTPS certificate. Browser HTTPS via a local proxy can remain separate. Allow inbound TCP on Current's port for Node in the Mac firewall. No router port forwarding, public tunnel, cloud URL, SoundCloud token, or modification of the Sonos installation is needed.

Control endpoints require the existing pairing session and same-origin/Host checks. Audio cannot use browser cookies, so each active session gets a new 256-bit bearer grant. Audio readers must additionally originate from selected, discovered Sonos IPv4 hosts; loopback HTTP readers are allowed only in explicit mock mode. There are at most two concurrent readers to accommodate renderer probing/reconnect, normally only the coordinator. Grants are revoked when capture stops or the server restarts. Never publish a stream URL extracted from a device/state dump. The normal UI/status does not reveal the bearer URL.

Capture does **not** start on application startup, preference restoration, or an automatic background retry. Stop stream kills capture/encoder and closes readers. Main-player stop/pause for this app's radio stream also stops capture; play explicitly reconnects. The corresponding generic room API transport controls manage the same lifecycle. SoundCloud itself remains playing unless paused in its website. A different controller's source/coordinator change ends capture rather than taking over its music. A controller restart leaves the session stopped and the old URL invalid; choose Stream/Reconnect to start again.

## Radio protocol and buffering decisions

- MP3: constant 192 kbps, MPEG-1 Layer III, 44.1 kHz stereo. No bit reservoir, ID3 header, or Xing/file-length header in the live encoder output. HTTP reconnect begins at an actual MP3 frame from the recent ring.
- Radio URI: **replace** `http:` with `x-rincon-mp3radio:`. For example, `http://192.168.1.50:3000/live/...` becomes `x-rincon-mp3radio://192.168.1.50:3000/live/...`, **not** `x-rincon-mp3radio:http://...`.
- Metadata: escaped DIDL-Lite with station title, `object.item.audioItem.audioBroadcast`, an `audio/mpeg` resource, and the conventional Sonos radio descriptor used by SoCo. This descriptor is metadata, not a new TuneIn/SoundCloud account or an external service request.
- Control: set URI and metadata on the selected coordinator, then Play. Group topology is confirmed with bounded retry. No independent unsynchronized HTTP source is sent to each room.
- HTTP: standard HTTP 200 audio response with `audio/mpeg`, private `icy-name`, `icy-br: 192`, `icy-pub: 0`, no file length, no cache, and no seek. It is Icecast-style source delivery, not a full Icecast admin/source-auth server. If a client requests ICY metadata, no `icy-metaint` is advertised, so the stream remains ordinary MP3 frames without interleaved metadata bytes.
- Default: connection-close-delimited HTTP, without chunking. Optional chunked HTTP/1.1 is selectable under advanced transport and applies on reconnect. Both pass software clients/decoding; neither mode is asserted to work on every S1 firmware.
- HEAD works; `Range: bytes=0-` is ignored with 200 (the client starts live). Small zero-offset finite probes (e.g. bytes=0-1) return a bounded snapshot with 206 and an unknown total length, without registering a sustained reader. Nonzero/other ranges get 416 and are counted diagnostically. No fabricated multi-gigabyte Content-Length, WAV placeholder, infinite file seek emulation, or radio queue duration is used.
- PCM: 48 kHz stereo Float32, packets every 20 ms. Partial stdout/sample boundaries are handled. At most 500 ms of pending captured PCM and three readable PCM packets are retained; overflow drops old audio instead of growing delay.
- Silence: when the selected browser is quiet, PCM silence keeps the MP3 clock/HTTP stream continuous. Native readiness/heartbeat are independent of audio level; a silent browser is not falsely diagnosed as permission success with audible content, nor killed after five seconds of silence. Protected/uncapturable content can remain silent; it is not decoded by another route.
- App startup/reconnect buffer: 2 seconds by default, configurable 1–5 seconds. At 192 kbps the default recent ring is about 48 KB. Reader backpressure is bounded at 128 KB per reader before disconnection; at most two readers. OS socket buffers add their own bounded storage.
- Native heartbeat failure, encoder exit, missing HTTP requests, SOAP faults, and playback interruption are distinct failure paths. After 30 seconds without an actual reader consuming audio, a real session stops and reports a connection diagnostic. Mock devices make no physical requests and are explicitly excluded from claiming this handshake.
- Automatic **HTTP reader** reconnects during the same active session use the current ring. Reconnecting the **capture session** is explicit, creates a new grant, and reapplies the selected destinations. Old frames are not archived or replayed across sessions. Mac sleep/permission revocation can end capture; reconnect after fixing the cause.

The application prebuffer is not total end-to-end delay. Native capture scheduling, encoding, LAN and firmware buffers add delay; the Sonos part is unknown until measured. There is no real-time/AirPlay-like latency claim. Silence and backpressure handling favor reliable clocked delivery over minimal delay.

## Diagnostics: identify the failing stage

| Observation / code                                  | Meaning and next check                                                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM` / `CAPTURE_BUILD`                        | Wrong host or helper absent/stale. Use the Mac and run the build command. Native compiler errors must be checked in its terminal.                                                                                                            |
| `CAPTURE_PERMISSION`                                | Grant the indicated Mac recording permission; restart the launcher if required, then reconnect. A minute-long unresolved permission/start prompt times out rather than recording indefinitely.                                               |
| `BROWSER_LAUNCH` / `BROWSER_MISSING`                | Browser unavailable or could not open in the active Mac login session. Open it normally or choose the installed Safari option.                                                                                                               |
| `DISPLAY_UNAVAILABLE` / `CAPTURE_START_FAILED`      | SCK graphical-session/display/start prerequisite failed. Not a Sonos decoder verdict.                                                                                                                                                        |
| `CAPTURE_FORMAT` / `CAPTURE_STOPPED`                | Native format rejected or capture ended/revoked. No invalid PCM is knowingly sent to Sonos.                                                                                                                                                  |
| Capture ready but no signal                         | The browser may be silent, muted, unavailable for capture, or playing protected audio. Try the original synthetic pulse page in the same browser. No protection is bypassed.                                                                 |
| `ENCODER_FAILED`                                    | FFmpeg absent, stopped, or output stalled. Verify `ffmpeg -version`, installed libmp3lame, and restart.                                                                                                                                      |
| `GATEWAY_ADDRESS`                                   | Private IPv4 origin unresolved or incompatible. Set the actual LAN HTTP origin.                                                                                                                                                              |
| `SONOS_OFFLINE` / `SONOS_TOPOLOGY`                  | Device/group control failure. Rediscover and inspect the already-working network controller. Partial group changes may have occurred; there is no fake atomic rollback.                                                                      |
| `HTTP_READER_REJECTED` / `SONOS_HTTP_REJECTED`      | A private-URL request reached Current from an unselected host and was denied. Check direct LAN addressing or NAT/proxy source-address changes; this is distinguished from no incoming request. The allowlist is not broadened automatically. |
| `SONOS_NO_HTTP`                                     | SOAP may have accepted the source, but no renderer HTTP request reached the Mac. Check address, firewall, VLAN/client isolation, and radio URI support. This is not proof of a codec failure.                                                |
| HEAD/range requests but no reader; `SONOS_NO_AUDIO` | A renderer reached the endpoint but did not sustain audio consumption. Inspect range counts/HTTP mode and UPnP faults; test alternate delivery deliberately.                                                                                 |
| `SONOS_UPNP_714` or another SOAP code               | The actual Sonos request was rejected. 714 can indicate URI rejection, not necessarily a bad codec. Record code, firmware, HTTP observations, and mode.                                                                                      |
| Bytes flowing + PLAYING but silence                 | Still not verified playback. Check browser signal, room mute/volume, then firmware decoder/buffering. Current never unmutes/raises levels automatically.                                                                                     |
| `PLAYBACK_INTERRUPTED`                              | The radio was stopped/paused or another source/coordinator replaced it. Capture ends; explicit reconnect is required.                                                                                                                        |

A negative conclusion about network feasibility must be tied to these actual observations on the Mac/S1 system. This cloud environment has produced no such hardware evidence; it cannot label the network method a hardware failure or a success.

## Tests and measurements actually executed

The suite runs the existing discovery/control/queue/OAuth regressions plus:

- Real synthetic PCM → MP3 at 192 kbps, including independent FFmpeg decoding and both close-delimited/chunked HTTP modes.
- Radio scheme replacement, XML/DIDL escaping/class/resource, SOAP SetAVTransportURI/Play requests, coordinator routing and multi-room state.
- Startup prebuffer, ongoing frames, frame-aligned HTTP reconnect, range rejection, reader limits, slow-reader disconnection, bounded PCM/ring history.
- Native-helper **fixture** protocol: permission denial, readiness/heartbeat/PCM, repeated stop waiting for process exit. This is not ScreenCaptureKit execution.
- Encoder absence, capture cancellation during startup, source replacement, no HTTP reader timeout, SOAP rejection classification, old-URL revocation, endpoint pairing and strict input.
- Desktop and iPhone-sized Chromium flows for starting/stopping/reconnecting the real encoder against mock rooms; legacy RCA/API flows remain covered. No actual Safari execution is claimed.

A fresh 30-second synthetic HTTP run at the new defaults observed: 30.08 seconds elapsed, 1,168 encoded frames, 821,916 received bytes including reconnect prebuffers, two reconnects, 48,274 retained audio bytes, peak parent RSS 88,297,472 bytes, peak encoder RSS 34,000,896 bytes, encoder average CPU reported by `ps` 0.9%, and parent CPU time 398 ms. These are short Linux process measurements, not a long-run Mac benchmark, proof of native capture, or audible end-to-end latency.

Reproduce transport-only measurements with `npm run prototype:benchmark` (or `BENCH_SECONDS=60 npm run prototype:benchmark`). The retained command now exercises the same shared radio implementation as Current. No SoundCloud login is involved in that synthetic test.

## Focused real-hardware acceptance test

1. Start Current on the Mac with `SONOS_MOCK` unset/0; confirm its existing nine discovered rooms and working low-volume playback controls. No speaker reset/update is needed.
2. Build the native helper, choose **one** destination, click Stream from Mac, and grant macOS permission. Verify native ready, increasing MP3 frame count, then an actual Sonos HTTP reader. Record any exact error before retrying.
3. In the captured browser open Current's `/capture-test.html` path. Click Start pulse at low volume. It generates original 80 ms beeps with a flash every four seconds. Confirm audible Sonos output, then compare flash/local pulse against speaker sound with an existing phone recording if useful. The page does not automatically measure latency and visual timing is not sample-accurate. Never play the live HTTP stream back into the captured browser: that can create feedback.
4. Stop the pulse. Play an authorized SoundCloud track in that browser, then a previously failing remix. Listen for full playback and track changes; browser entitlement/capture restrictions still apply. Record macOS, S1 firmware/model, HTTP mode, buffer setting and observed delay.
5. Add a second destination using Reconnect. Verify both rooms audibly, relative sync, independent volume/mute, then test the desired larger group. Do not count mock topology as this result.
6. Pause SoundCloud for at least 60 seconds: the stream should remain clocked with silence. Resume and verify recovery. Stop stream: the Mac recording indicator/encoder/readers should end. Reconnect and confirm a fresh session.
7. Change Sonos to an unrelated source in the official app: Current should stop capture without taking it back. Test server restart and Mac sleep/wake; recapture should require an explicit action. Test a brief network interruption and inspect whether S1 reconnects its reader or needs explicit Reconnect.
8. Listen for at least 30 minutes. If the default delivery fails, record the exact HTTP/SOAP observations, try chunked mode once, and compare. Do not call it accepted until the actual rooms produce stable audio. If capture fails before any stream exists, investigate capture/session permissions separately from Sonos.

## Protocol/source evidence

- [SoCo `play_uri` source](https://github.com/SoCo/SoCo/blob/master/soco/core.py), inspected directly: documents radio-versus-track URI handling, historical Sonos radio behavior, `force_radio` replacing the HTTP scheme, broadcast DIDL station metadata, and coordinator-only playback. It establishes a tested controller pattern, not certification of this installation.
- [Microsoft macOS ScreenCaptureKit bindings](https://github.com/dotnet/macios/blob/main/src/screencapturekit.cs), inspected directly: public `initWithDisplay:includingApplications:exceptingWindows:` selector, capture audio properties, sample rate/channel count. A tiny Objective-C bridge uses this positive allowlist selector explicitly, avoiding ambiguous Swift importer initializer labels. No private capture API is used.
- [Apple ScreenCaptureKit sample mirror](https://github.com/Fidetro/CapturingScreenContentInMacOS) and [Apple documentation](https://developer.apple.com/documentation/screencapturekit): audio output, capture permission, filters, and stream lifecycle. Direct Apple docs were blocked in this cloud; available sample/source evidence was used. Native compile/runtime remains a Mac acceptance requirement.
- [SWYH-RS](https://github.com/dheijl/swyh-rs): renderer buffering, silence/reconnect behavior, format/header differences, and the need to test specific Sonos firmware. Its current-firmware results do not establish S1 compatibility.

Core Audio process taps (macOS 14.4+) and BlackHole were evaluated in the earlier research. They add OS-specific lifecycle/permission or driver setup and do not by themselves solve radio transport. The implemented default is native ScreenCaptureKit plus the tested local MP3 transport; no whole-system/virtual-driver fallback is silently enabled.
