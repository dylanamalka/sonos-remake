# Local architecture

```text
iPhone Safari / Mac browser
        | HTTP + paired session (same origin)
Next.js UI + Express Node process on Mac :3000
        | SSDP multicast :1900 -> device description
        | UPnP SOAP TCP :1400 -> discovered Sonos devices
        | official OAuth/API HTTPS -> SoundCloud
        | expiring MP3 gateway <- Sonos group coordinator
        | local FFmpeg (only unencrypted local files)
        + .local/ atomic JSON settings, pairing code, OAuth tokens, local media
```

SSDP is implemented with Node's UDP socket, since the protocol is small and no external daemon is needed. Discovery only accepts RFC1918/link-local IPv4 HTTP locations on Sonos port 1400, validates Sonos manufacturer/UDN, and resolves group topology. XML is parsed with `fast-xml-parser`; DTD/entity declarations and oversized XML are rejected. Control paths target AVTransport, RenderingControl, ContentDirectory, and ZoneGroupTopology. Requests have bounded timeouts. State polling uses four workers and is coalesced to avoid overlapping network scans. Startup discovers devices; UI polls state every four seconds while visible. There is no GENA event subscription or automatic discovery across VLANs/IPv6.

Playback/queue target the group coordinator; volume and mute target the individual renderer. Source selection sets AVTransport URI, with preserved Sonos favorite metadata where supplied. Service containers are added to the queue then played from the first enqueued track. Grouping uses `x-rincon:UUID`; ungrouping uses `BecomeCoordinatorOfStandaloneGroup`. There is no PCM synchronization layer: Sonos owns synchronization.

SoundCloud uses the official API directly because SoundCloud's public API repository says the older SDKs are not maintained. Tokens and refresh-token rotation are server-side; refresh calls are coalesced. OAuth state has a 10-minute lifetime, PKCE S256, and binding to the initiating paired session. Resource IDs use current `soundcloud:tracks:...` / `soundcloud:playlists:...` URNs. Pagination carries only allowlisted cursor/offset query parameters, never an arbitrary upstream URL. Disconnect clears the local token file; revoke the application in SoundCloud too when needed.

Stream resolution checks explicit `access=playable` and `streamable=true`. Preview URLs are never used. SoundCloud MP3 is not transcoded. A full unencrypted MP3 HLS playlist can be relayed by concatenating verified plain MP3 segments, without retaining media. Unsupported formats fail explicitly. Stream redirects stay on HTTPS `api.soundcloud.com` or `*.sndcdn.com`; OAuth headers are sent only to the API host, never the CDN. Signed stream URLs are resolved when the speaker requests audio, not stored as a long-lived source. HLS snippets are detected against track duration. This is conservative compatibility handling, not proof that a particular account/track/device combination works.

Security assumes a trusted home LAN. Pairing uses random sessions, an HttpOnly SameSite cookie, constant-time code comparison, and rate limiting. Host checks reduce DNS rebinding; origin checks reject cross-origin API calls. The HTTP port must not be exposed publicly. For HTTPS use a trusted local reverse proxy for browser access and leave a LAN HTTP address in PUBLIC_BASE_URL for older speakers. API JSON is not cached. OAuth tokens are stored with restricted file permissions; OS Keychain integration is not implemented. Audio grants expire after 24 hours or a server restart and require no browser cookie. They are intentionally separate from control sessions.

Storage is intentionally single-process JSON, with serialized atomic writes. Run one controller process per storage directory; multi-process clustering is not supported. Favorites and room preferences persist. Queue content and topology live on speakers; mock topology/queue state and diagnostic history live in memory. No automatic firmware changes, account provisioning, music-service credential extraction, or library uploads occur.
