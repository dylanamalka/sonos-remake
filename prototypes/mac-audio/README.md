# Experimental Mac capture / live-radio prototype

**Not the chosen everyday integration.** Current's default SoundCloud tab uses wired Sonos line-in, requires no developer API keys, and does not launch this prototype. This folder exists to test the strongest software-only alternative without disrupting the working controller. Read [the decision and evidence](../../docs/SOUNDCLOUD-DECISION.md).

## Verified transport-only test

On Linux or Mac, with Node and FFmpeg installed:

```bash
npm run prototype:benchmark
# Optional short/long exercise (5–120 seconds):
BENCH_SECONDS=60 npm run prototype:benchmark
```

This generates a synthetic sine wave, encodes it, reads its HTTP stream, reconnects twice, and reports software transport/resource measurements. It does not capture SoundCloud or talk to Sonos.

For manual HTTP testing in a second terminal:

```bash
npm run prototype:bridge -- --synthetic
```

The terminal prints a **private bearer URL**, bound to loopback by default. A HEAD request checks headers; a GET remains live. No disk recording is performed. Stop with Ctrl-C. Random URLs expire at process exit. Do not paste stream URLs in public bug reports.

## Native browser capture — requires your Mac; not compiled here

Prerequisites: macOS 13+, Apple Command Line Tools with the macOS SDK, FFmpeg, and a running Chrome or Safari session. A display/active graphical session may be necessary. No virtual audio driver is required. Building and granting permission are optional and not part of normal line-in setup.

```bash
# If command-line developer tools are not already installed:
xcode-select --install
brew install ffmpeg
npm run prototype:capture:build
npm run prototype:bridge
# To capture Safari instead of Chrome:
npm run prototype:bridge -- --safari
```

The helper is built locally into ignored `.local/bin/current-capture`, with a local ad-hoc code signature. The native Swift source was not compiled on Linux. If your SDK reports an API/compiler issue, keep using the selected line-in path; do not treat a synthetic test as a passed native build.

When macOS requests recording permission, choose only if you want this experiment. Check **System Settings → Privacy & Security → Screen Recording / Screen & System Audio Recording** (wording varies by OS). The permission may be attributed to the terminal/launcher or helper. Restart the launcher after granting it. The prototype does not edit the TCC database, disable security settings, request microphone access, or include any private permission API. Capture permission is broader than SoundCloud: the selected browser application's other audio can also be included. Use a dedicated otherwise-idle browser, do not include private calls, and stop capture when finished. Protected content can produce silence; do not bypass that restriction.

If the helper cannot find the browser/display, permission is denied, or no frames arrive, it fails visibly and ends the stream. Fix the cause and relaunch explicitly. SoundCloud login remains in the official browser. Select/play tracks there; there is no DOM automation or cookie extraction.

## Opt-in LAN/Sonos experiment

Do not enable LAN mode unless you intend to expose this private stream to your speakers on a trusted LAN. In `.env`, `PUBLIC_BASE_URL` must use this Mac's private IPv4 HTTP origin. The normal app stays on its existing port; the prototype uses **3001** by default. Allow that TCP port only on the home LAN.

```bash
npm run prototype:bridge -- --lan
# Compare chunked with default close-delimited HTTP:
PROTOTYPE_HTTP_MODE=chunked npm run prototype:bridge -- --lan
```

Use the printed plain HTTP MP3 URL with Current's **Play a source → Direct network audio**, targeting one group coordinator. Group rooms through the existing controller. Start at low volume. A successful SOAP command or HTTP request is not proof of audible playback. If a particular S1 firmware needs radio-specific URI handling, record its actual error before adding support; this prototype does not blindly force wrappers or fabricate file lengths.

Native-capture permission, browser audio capture, speaker HTTP requests, audible decoding, buffering duration, and long-run sync/reconnect behavior all need actual Mac/S1 tests. Record results for at least 30 minutes, silence, source pause/resume, a network interruption, and Mac sleep/wake before considering this an alternative to line-in. Check that no capture/FFmpeg processes remain after Ctrl-C. No unattended recording or automatic Sonos re-selection is installed.

## Transport boundaries

- Output: MP3, MPEG-1 Layer III, 44.1 kHz stereo, 128 kbps; no bit reservoir for fresh frame starts.
- Input contract: Float32 little-endian, 48 kHz stereo PCM. Wrong native formats are refused rather than misencoded.
- No seek, fake file duration, fabricated Content-Length, DRM bypass, scraped URLs, or media cache.
- About one second of recent frames retained; slow consumers are disconnected at a bounded queue threshold. At most two clients by default; only the group coordinator should normally subscribe.
- Close-delimited HTTP by default, optional chunked delivery. Both pass HTTP/decoder tests, neither has been certified against this S1 hardware.
- Stall/error ends subscribers, terminates the encoder, and stops the capture producer. A fresh process gets a fresh bearer grant.
- Never expose port 3001 through a router/tunnel. Anyone with the live bearer URL on the permitted LAN can hear the captured audio until it ends.
