# Buzz Arena v2 — Quiz Buzzer for 8–20 Teams

Broadcast-grade buzzer system. One laptop hosts, up to twenty phones/tablets buzz in,
results ranked by latency-compensated time, plus a PIN-locked companion remote.

## Deploy (Vercel)

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

`time-sync` · `create-room {maxTeams}` · `host-rejoin {code}` ·
`join-as-player {code, teamName, offset, rtt}` · `update-netstats` ·
`rename-team {name}` · `buzz {clientPressTime, offset, rtt}` ·
`host-control {action: arm|lock|reset|next|clear}` · `kick-team {teamId}` ·
`join-as-companion {code, pin}` → events `room-update`, `buzz-update`,
`control-event`, `kicked`, `security-alert`, `netstats`.

## Notes

- Fairness: 8-sample median clock sync per buzzer; ranking by
  `clientPress + offset`, with RTT/offset shown per team.
- Companion: separate 4-digit PIN, 3 wrong tries → 30 s lockout + host alert,
  restricted to arm / lock / reset / next / clear.
- WakeLock keeps buzzer and remote screens on; multitouch-safe big button
  (one press per team per question).
