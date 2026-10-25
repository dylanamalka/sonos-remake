# Current

A local, responsive Sonos controller for iPhone and Mac, built with Next.js, React, and a TypeScript Node server. Designed for older Sonos S1 systems, including Connect and speakers attached to external amplifiers. Devices and room names come from your system, never a hardcoded room list.

**Built and tested with simulated devices in the cloud. Real S1 speakers and an authenticated SoundCloud account have not been tested here.** The implementation is usable locally; hardware behavior, native service availability, and individual SoundCloud tracks need the acceptance checks below.

## Network-only SoundCloud — Stream from Mac

**SoundCloud browser → native ScreenCaptureKit browser-audio capture → local 192 kbps stereo MP3 radio → existing Sonos S1 rooms over the LAN.** No RCA cable, hardware purchase, rewiring, SoundCloud developer credentials, or Sonos installation change is required. This is now the primary SoundCloud tab; the earlier RCA path and API library remain optional fallback tabs.

Stop the running controller, then update from the existing Mac checkout:

```bash
git pull --ff-only
npm ci
brew install ffmpeg
npm run capture:build
npm run build
npm start
```

If the Apple Command Line Tools are missing, run `xcode-select --install` once, finish its installation, then rerun the helper build. Requires macOS 13+ with its SDK; compiled helper products remain local under ignored `.local/mac-capture/`. Existing `.env` and preferences are preserved. Pair again after restart with the same terminal code.

Select **SoundCloud → Stream from Mac**, choose Chrome/Safari and rooms, and click Stream from Mac. Grant macOS Screen Recording / Screen & System Audio Recording permission on the Mac to Current Audio Capture or the identified launcher. Restart Current if macOS requests it, then reconnect. Play SoundCloud normally in the chosen browser. Only that browser application is included, though all its tabs may contribute audio. No SoundCloud cookies, protected media requests, URLs, or credentials are extracted.

The stream uses MP3 at **44.1 kHz, stereo, 192 kbps**, radio-style Sonos URI/DIDL, an expiring private HTTP endpoint on the existing port, and coordinator playback for synchronized groups. A two-second application buffer, silence keep-alive, bounded queues, frame-aligned HTTP reconnect, explicit session reconnect and process cleanup are implemented. Sonos receiver buffering adds unmeasured delay; no real-time latency claim is made. No automatic recording resumes after a restart or source takeover.

Automatic private LAN address selection is used when unambiguous. Otherwise set `PUBLIC_BASE_URL` to the Mac's actual speaker-reachable HTTP origin and allow its existing TCP port in the Mac firewall. No extra server/port or paid cloud infrastructure is required. The normal SoundCloud player retains login, search, track/queue selection, and playback restrictions; Current's iPhone UI controls the destination/session rather than automating the website.

**Implemented and validated with real encoded audio/HTTP clients and simulated devices in Linux. Native ScreenCaptureKit compilation/capture, macOS permission attribution, real S1 decoding/sync, audible delay, and actual Safari behavior remain unverified here.** Encoder readiness/HTTP bytes/PLAYING are not proof of audible hardware playback. The native helper requires an available Mac graphical session/display; specific failures are reported rather than inventing headless success.

Read the [network setup, diagnostics and focused hardware acceptance test](docs/NETWORK-STREAMING.md). Use the included `/capture-test.html` in the captured browser for original test pulses before testing SoundCloud. The earlier [line-in decision report](docs/SOUNDCLOUD-DECISION.md) is historical and superseded for the network-only requirement.

## Run on your Mac

Install Node.js 22 or newer (Node 24 LTS recommended) and Git. FFmpeg is optional for speaker control, but needed to convert your unencrypted local audio files and to run the gateway integration test:

```bash
brew install node ffmpeg
git clone https://github.com/dylanamalka/sonos-remake.git
cd sonos-remake
npm ci
cp .env.example .env
npm run dev
```

Open the app at `http://localhost:3000` on the Mac and enter the pairing code printed in that terminal. The code is generated once, persisted in `.local/pairing.json`, and reused unless you set `PAIRING_CODE`. Keep it private. Browser sessions reset when the server restarts; pair again with the same code.

For normal daily use:

```bash
npm run build
npm start
```

Keep the Mac awake and this process running. No paid cloud hosting, database server, or subscription is required for Sonos control. Developer access is required only for the optional API library, not Stream from Mac or the retained line-in path.

### iPhone

Use the same home Wi-Fi. Find the Mac’s Wi-Fi IP in **System Settings → Wi-Fi → Details → TCP/IP** (or `ipconfig getifaddr en0`, if Wi-Fi is `en0`). Open `http://MAC_LAN_IP:3000` in Safari and pair. A DHCP reservation for your Mac is recommended. Do not forward this port to the Internet.

The UI adapts to iPhone; tap the playing track for the full Now Playing screen. The queue is accessible in the top bar. Safari’s Share → Add to Home Screen installs the home-screen entry. Service workers and full PWA/offline behavior require a secure context: localhost on Mac or trusted HTTPS on your LAN. Ordinary LAN HTTP supports the controller in Safari. See [network and HTTPS notes](docs/TROUBLESHOOTING.md).

### Audio gateway configuration (live radio and local files)

In `.env`, set a URL **your speakers can reach**:

```dotenv
PUBLIC_BASE_URL=http://192.168.1.50:3000
```

Use your actual Mac IP, not this example. Restart after configuration changes. The gateway must be reachable from Sonos on TCP 3000; it cannot use `localhost` because that would mean the speaker itself. The Mac and speakers must be on the same LAN for automatic discovery. Allow Node network access in the macOS firewall. Most setups need no router changes.

## Try without speakers

```bash
npm run dev:mock
# Or after npm run build:
npm run start:mock
```

Mock mode has three clearly labeled simulated rooms, queue data, and transport/group/volume state. **It produces no audio.** It never represents your actual device names. Remove `SONOS_MOCK` or set `SONOS_MOCK=0` to use real discovery. The cloud instance can demonstrate this mode, but cannot discover your home network.

## Implemented controls

- Automatic SSDP discovery at startup and an on-demand rescan. Live room names/model information from device descriptions and topology.
- Play, pause, stop (API), next/previous, seek, independent room volume, mute, and group/ungroup.
- Group playback commands go to the actual coordinator. Sonos firmware handles synchronized playback; the app does not send separate audio clocks to speakers.
- Now Playing, track metadata/artwork, responsive dark UI, full mobile player, and per-room volume sliders.
- Read/add/play/remove/clear the group coordinator’s queue; first 200 items displayed.
- Persistent saved favorites, selected room, and preferences. Sonos favorites and service URIs reuse your existing Sonos service configuration. Supported favorite containers are queued before playback. This is not a replacement for the official service-account setup or every service’s catalog browser.
- Compatible HTTP(S) network streams, local audio files, and physical Sonos Connect line-in selection.
- SoundCloud OAuth 2.1 + PKCE, token refresh, search, Likes, playlists, cursor pagination, and per-track eligibility checks.
- Session diagnostics with SOAP fault codes, network failures, and SoundCloud/gateway errors.

## Optional SoundCloud API library: playback limits

“The song is not encoded correctly” does **not** prove the audio file is corrupt. Codec/container mismatch, HLS versus progressive delivery, authorization, signed URL expiry, regional/catalog restrictions, or service-side changes can all matter. We cannot determine the cause for your tracks without testing your devices/account.

Current uses the official API, not scraping or downloaded browser session cookies. The current public specification lists `hls_aac_160_url`, `hls_mp3_128_url`, and `preview_mp3_128_url`. An API stream may be a snippet even when other apps can play the full track. A logged-in browser’s access does not automatically confer full public-API playback rights.

Implemented playback paths:

| Source returned by the authorized API                                              | Behavior                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full progressive MP3, if provided                                                  | Ephemeral authenticated passthrough through the local gateway; no transcoding or disk cache                                                                 |
| Full unencrypted HLS containing plain MP3 segments                                 | Verify finite playlist and full duration, reject encryption/master/byte-range playlists, validate MP3 segments, then relay segments as an MP3 HTTP response |
| Preview, blocked, missing full access, AAC HLS, encrypted HLS, or non-MP3 segments | Refuse playback, record diagnostics, and explain fallback; no conversion or restriction bypass                                                              |

The HLS relay has no byte seeking and may not work with every S1 firmware. Progressive MP3 supports upstream ranges where available. **Neither path is a promise that all SoundCloud tracks play.** SoundCloud access, terms, API approval, region, and rights still apply. No encrypted media is decrypted, no preview is promoted to a full track, and no SoundCloud media is saved or transcoded.

### Connect your account

1. Obtain your own approved application at [SoundCloud applications](https://soundcloud.com/you/apps). Eligibility and developer-access policy are controlled by SoundCloud; an existing listener account alone is not sufficient.
2. Register `http://localhost:3000/api/soundcloud/callback` as an exact redirect URI if SoundCloud permits it for your app.
3. Set these on the Mac in `.env` (never in frontend code):

   ```dotenv
   SOUNDCLOUD_CLIENT_ID=your-app-client-id
   SOUNDCLOUD_CLIENT_SECRET=your-app-client-secret
   SOUNDCLOUD_REDIRECT_URI=http://localhost:3000/api/soundcloud/callback
   ```

4. Restart Current. On the **Mac at localhost**, pair, then choose SoundCloud → Connect. Initiate and finish OAuth in the same browser/origin so the state-bound pairing session is present. If you registered a different redirect origin, use that origin from the start. The connected account is shared with your other paired devices, including iPhone.
5. Set `PUBLIC_BASE_URL`, select a room, search, and play a track. Any refusal appears in the banner and Diagnostics. Never paste keys into chat or commit `.env`/`.local`.

### Retained optional fallback: physical line-in

For content that plays legitimately in the official SoundCloud app but is unavailable through the public API, connect an authorized audio output to a Connect’s stereo RCA input (for example Mac headphone output → 3.5 mm to RCA, or iPhone audio adapter → RCA). Start SoundCloud on that source. In Current select the destination room, choose **Play a source → Physical line-in**, and select the Connect receiving the cable. Group additional rooms for Sonos-managed synchronization.

This uses a real physical input; no cable or audio-input hardware can be provisioned by the cloud. It avoids the failing Sonos service stream-decoder path, but needs physical testing. Configure line-in source level/compression/delay using the official S1 app as needed. Connect is not assumed to support AirPlay. Source playback controls stay in SoundCloud; Current controls the rooms and input selection.

## Troubleshooting the retained RCA input

- Silent rooms: verify SoundCloud plays normally on the wired Mac, its output/volume, RCA inputs rather than outputs, Sonos mute/volume, and line-in source level/compression in the official S1 app. Current does not verify audible energy or change source-level/compression settings automatically.
- Offline/missing source: reconnect power/network and rediscover. Cable presence is shown only when Sonos reports it; “unknown” is not treated as a disconnected cable.
- Partial grouping failure: some selected rooms may already have moved. The status says so; Reconnect reapplies the saved selection after the fault is fixed. It does not pretend to roll back physical devices atomically or restore unrelated playback.
- A different controller changed the source: Current will not silently take it back. Use Reconnect deliberately. Stop skips a different source, so it does not intentionally stop unrelated music selected later.
- No track artwork/next/previous: line-in carries audio, not SoundCloud metadata or queue controls. Use the official player for track selection; skip buttons are disabled for the input in Current. Group timing remains Sonos-managed and needs listening tests.
- Browser does not open: use Current on the actual Mac server and the logged-in graphical session. You can always open SoundCloud manually there. Native capture permissions are not relevant to this wired path.

## Your local audio library

Copy files you own or have permission to stream into `.local/media/`. Library → Local files lists them. MP3 is passed through with byte-range support. Other supported unencrypted files (`wav`, `flac`, `aiff`, `m4a`, `aac`, `ogg`, `opus`) are decoded by local FFmpeg to conservative 44.1 kHz stereo MP3 at 192 kbps, without caching the output. Transcoded files have no byte seeking. Installing FFmpeg does not grant rights to convert third-party streams.

Gateway URLs are random 256-bit bearer grants, valid up to 24 hours and kept in memory. Speakers cannot use browser cookies. URLs stop working after a server restart; restart playback/requeue affected gateway tracks. Keep your LAN trusted. Settings and token files have mode `0600`; the storage directory is created as `0700`. Tokens are plaintext restricted local files, not encrypted Keychain entries. Back them up or delete them with care.

## Development and checks

```bash
npm run typecheck
npm test                 # Node unit/integration tests; requires FFmpeg
npm run build
npx playwright install chromium
npm run test:e2e          # production server, desktop + iPhone-sized Chromium
```

To use an already-installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable. On a minimal Linux CI machine Playwright may require `npx playwright install --with-deps chromium`. Browser tests use their own port (3100), test-only pairing code, and temporary data directory. No real SoundCloud credentials are needed for these tests. Mobile browser tests emulate iPhone dimensions in Chromium, not real Safari.

The automated suite also covers saved line-in profiles, source-outside-group routing, delayed topology confirmation, partial failure/retry, preserving volume/mute, and the experimental synthetic live-radio pipeline. It covers SOAP requests/faults, grouping/coordinator behavior, volume/mute/queue, pairing/origin protections, persistent favorites, local range streaming and FFmpeg conversion, OAuth PKCE/state, URNs, pagination, stream eligibility, and HLS restrictions. Browser checks exercise desktop/mobile pairing, playback, grouping, queue and setup screens. See [architecture](docs/ARCHITECTURE.md) and [diagnostics](docs/TROUBLESHOOTING.md).

### Physical acceptance checklist — still required

- Run locally and confirm all installed devices/room names appear (no assumption about the stated unit count).
- Play/pause, mute, low-volume test, and queue changes in each room. Confirm metadata and artwork on your actual firmware.
- Group two rooms, listen for sync, adjust each room’s volume, and ungroup; then try your full group.
- Play an authorized local MP3 through the gateway; test a converted file if using FFmpeg.
- For the recommended route, sign in normally on the Mac, confirm the wired output, select the line-in, and audibly test a known track and a previously failing remix. Confirm play/stop, mute/volume, group sync, reconnect, and a longer session. No capture or developer keys are needed.
- If using the optional API library, authenticate SoundCloud and try a known working track and a failing remix. Record returned access/format and any SOAP error. Confirm full duration and audible output; do not count only an HTTP success as success.
- Test the actual Connect RCA line-in fallback and source volume. Check iPhone Safari on your home Wi-Fi.

## Project structure

`app/` is the Next.js PWA UI; `server/` is the local Express/Node controller with SSDP, SOAP, OAuth, gateway, and atomic JSON persistence; `tests/` contains unit/integration and Playwright checks. Next is hosted by the custom Node server so API and browser share an origin and pairing cookie. A static export, Vercel serverless deployment, or cloud-only deployment cannot perform LAN SSDP. No telemetry is added. Current is an independent project, unaffiliated with Sonos or SoundCloud.
