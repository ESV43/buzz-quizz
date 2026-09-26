# Buzz Arena v2 — Quiz Buzzer for 8–20 Teams

Broadcast-grade buzzer system. One laptop hosts, up to twenty phones/tablets buzz in,
results ranked by latency-compensated time, plus a PIN-locked companion remote.

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

## Deploy (Vercel — static only, NOT for the timing server)

Push this folder to the repo connected to Vercel and redeploy — no extra config.
Join links and the QR resolve automatically:

1. `PUBLIC_URL` env var, if set (e.g. `https://buzz-theta-ashy.vercel.app`)
2. otherwise the public `Host` header (works on Vercel with zero config)
3. otherwise the host's LAN addresses (local-network play)

So on `https://buzz-theta-ashy.vercel.app/host.html`, the QR encodes
`https://buzz-theta-ashy.vercel.app/play.html?room=XXXXX`. On a laptop it shows
`http://<lan-ip>:3000/play.html?room=XXXXX` as before.

To force a URL regardless of host, set in Vercel → Project → Settings →
Environment Variables: `PUBLIC_URL = https://buzz-theta-ashy.vercel.app`.

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
