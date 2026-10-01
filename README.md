# QSI Buzz — Quiz Buzzer for 8–20 Teams

Broadcast-grade buzzer system. Up to twenty phones/tablets buzz in,
results ranked by latency-compensated time, plus a PIN-locked companion remote.

## LAN mode — P2P, no install (use this on event day)

The host tab becomes the referee directly over Wi-Fi (WebRTC — Mini Militia
style). Everyone loads the site once, then every buzz travels straight to the
host tab on the local network. There are no IP addresses to type and nothing
in the QR but a room code, so broken-link problems (`169.254`, `localhost`
in a QR) cannot happen.

1. Host laptop connects to a Wi-Fi network (venue router or a phone hotspot —
   that network becomes the event network) → **Host → LAN mode → Create room**.
2. Contestants join that same Wi-Fi and scan the host QR — or open
   **Contestant → LAN room** and enter the code. No addresses, no install.
3. Quizmaster opens **Quizmaster → LAN room**, enters code plus the host PIN.
   Keep the host tab frontmost; the laptop set to never sleep while plugged in.

Requirements: internet once to load the pages + introduce the peers; after
that, buzzes stay LAN-local (~5–20 ms). LAN rooms live in the host tab — a
refresh ends the room, teams simply rejoin the new code. Projector: use the
host's **Present** mode; the OBS overlay pairs with Internet rooms.

## Hosting — read this before event day

This is a persistent Socket.IO timing server: it holds every buzzer socket
open and keeps rooms in memory. That architecture decides where it can run.

- **Vercel (hobby) is the cause of the random disconnects.** Vercel Functions
  cap a socket at ~5 minutes, pin each connection to its own function
  instance, and wipe in-memory rooms on every cold start/scale event. Players
  landing on different instances can't even see the same room. No client
  retry logic can fix that — the server itself disappears underneath them.
- **Use one of the two free paths below.** Both cost nothing.

### Option A — event laptop + tunnel (recommended, zero sleep, lowest latency)

The laptop is the server; a free tunnel gives it a public URL for phones on
mobile data. No account, no card, nothing sleeps mid-quiz:

```bash
npm install
npm start
# new terminal:
cloudflared tunnel --url http://localhost:3000
# open the printed https://…trycloudflare.com/host.html on the projector,
# create the room — QR codes encode the public URL automatically.
```

(`cloudflared` is a single free binary from cloudflare.com. Same-Wi-Fi play
works even without the tunnel, via the LAN URLs printed at startup.)

### Option B — Render free tier (no card, good when the laptop can't host)

1. Push this repo to GitHub.
2. Render Dashboard → New → Blueprint → select the repo (`render.yaml`
   sets plan `free`, start `npm start`, health check `/health`).
3. Open `https://<your-app>.onrender.com/host.html`.

Free services sleep after 15 min without traffic (first load takes ~1 min),
so open the host page 10 min before the event. During the quiz the 10 s
host probe plus player sync traffic keeps it awake.

## LAN mode — P2P, no install (use this on event day)

The host tab becomes the referee directly over Wi-Fi (WebRTC — Mini Militia
style). Everyone loads the site once, then every buzz travels straight to the
host tab on the local network. There are no IP addresses to type and nothing
in the QR but a room code, so broken-link problems (`169.254`, `localhost`
in a QR) cannot happen.

1. Host laptop connects to a Wi-Fi network (venue router or a phone hotspot —
   that network becomes the event network) → **Host → LAN mode → Create room**.
2. Contestants join that same Wi-Fi and scan the host QR — or open
   **Contestant → LAN room** and enter the code. No addresses, no install.
3. Quizmaster opens **Quizmaster → LAN room**, enters code plus the host PIN.
   Keep the host tab frontmost; the laptop set to never sleep while plugged in.

Requirements: internet once to load the pages + introduce the peers; after
that, buzzes stay LAN-local (~5–20 ms). LAN rooms live in the host tab — a
refresh ends the room, teams simply rejoin the new code. Projector: use the
host's **Present** mode; the OBS overlay pairs with Internet rooms.

## Internet mode — room lives on the timing server

Host → **Internet mode** → Create room. The QR holds the server link and
works over mobile data or any Wi-Fi — for when everyone is not on the same
network. Rankings stay delay-compensated. The same 4 lobby options work;
only the host picks the mode before creating.

## Hosted server URL (no laptop needed) — Render free tier

If you never want `localhost`, LAN IPs, or `npm start` on event day, give the
referee a permanent home on Render (free, no card). The app then has one
server URL and everyone — host, contestants, quizmaster, spectator — opens
that URL directly. No laptop acts as a server.

1. Push this repo to GitHub.
2. Render Dashboard → New → Blueprint → select the repo (`render.yaml`
   already sets plan `free`, start `npm start`, health check `/health`).
   No env vars needed: Render provides the public URL itself.
3. Open `https://<your-app>.onrender.com/host.html` → pick **Internet mode**
   → Create room. The QR encodes the same `https://` URL — phones join over
   mobile data or any Wi-Fi.

Trade-off: internet latency (~30–80 ms, jitter-corrected in rankings) instead
of LAN's ~3 ms. For zero delay on event day, still use LAN mode below.
Free Render services sleep after 15 min idle — open the host page 10 min
early to wake it; quiz traffic keeps it awake.

## Deploy (Vercel — pages only, NOT the timing server)

Vercel serves the pages fine but cannot run the referee: its workers sleep,
forget rooms, and can't hold 20 live buzzer connections. So a Vercel URL
alone can never be the server URL — the timing server must be the laptop
(LAN below) or Render (above). `PUBLIC_URL` forces the links regardless of
host (e.g. `PUBLIC_URL = https://<your-app>.onrender.com`); otherwise the
server uses Render's own URL, then the public `Host` header, then LAN.

## Run locally

```bash
npm install
npm start
# host:    http://localhost:3000/host.html
# players: http://<lan-ip>:3000/play.html?room=XXXXX  (shown on host screen)
```

## Protocol (unchanged from v2 server)

`time-sync` · `create-room {maxTeams, wantedCode?}` · `host-rejoin {code}` ·
`join-as-player {code, teamName, teamId?, offset, rtt}` · `update-netstats` ·
`focus-status {away}` · `rename-team {name}` · `buzz {clientPressTime, offset, rtt}` ·
`host-control {action: arm|lock|reset|next|clear|present|overlay}` · `kick-team {teamId}` ·
`join-as-companion {code, pin}` · `join-as-spectator {code}` (read-only OBS overlay) → events `room-update` (teams carry
`connected` + `away`), `buzz-update`, `control-event`, `kicked`,
`security-alert`, `focus-alert {teamId, teamName, away}`, `netstats`.

Sessions survive reconnects: players reattach by `teamId` (no duplicates,
own buzz restored), host/companion silently reclaim authority on `connect`.
Focus state never gates buzzing — it only flags the team for host/companion.

## Notes

- Persistence: rooms auto-save to `rooms.json` (~0.5s after any change) and
  restore on restart — host reclaims via Reclaim, teams reattach by saved
  `teamId` with their buzz intact. In-flight 3-2-1 restores as locked; re-arm.
- Fairness: 8-sample median clock sync per buzzer; ranking by
  `clientPress + offset`, with RTT/offset shown per team.
- Companion: separate 4-digit PIN, 3 wrong tries → 30 s lockout + host alert,
  restricted to arm / lock / reset / next / clear / present / overlay (projector flip + OBS overlay toggle).
- Slides overlay: open `/overlay.html?room=XXXXX` as an OBS Browser Source
  (transparent lower-third spectator, read-only). Host deck (`Overlay on/off`,
  key `O`) and the companion remote (`Overlay: on/off`) flip it per slide —
  show it on quiz slides, hide it on the rest. Params: `style=lower-third|
  topbar|center`, `top=3` (1–8 rows), `hideIdle=1` (hide when locked + empty),
  `startHidden=1` (wait for the host to show it).
- WakeLock keeps buzzer and remote screens on; multitouch-safe big button
  (one press per team per question).
