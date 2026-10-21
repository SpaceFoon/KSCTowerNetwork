# Performance and hot paths

Audience: **operators** sizing a host and **developers** profiling load. This
doc describes **which routes fire often**, how WebSocket reduces browser HTTP
traffic, and **practical ways to measure** the backend. It is not a published
benchmark sheet — numbers are **order-of-magnitude** from code defaults unless
you measure your own fleet.

Pair with:

- [ARCHITECTURE.md → Ports, firewall, live transport](ARCHITECTURE.md#ports-firewall-and-live-transport)
- [SETTINGS_REFERENCE.md](SETTINGS_REFERENCE.md) (plugin `settings.cfg` + backend `.env`)
- [BACKEND.md → Logging](BACKEND.md#logging) (`httpRequestLogSilence.ts`)

---

## 1. What actually hits the server

### KSP plugin (per logged-in pilot)

| Traffic | Default cadence | HTTP path or transport | Notes |
|---|---|---|---|
| Telemetry | **1–5 s** per vessel (`nextTelemetrySeconds` from HTTP JSON; faster near runway / low AGL) | `POST /v1/telemetry/:sessionId` over HTTPS | Authenticated production traffic uses HTTPS. Local development can opt into empty-token UDP. |
| Ghost fleet roster | **`ghostFleetPollSeconds`** (default **2 s**, clamped 1–10 in settings) | `GET /v1/tower/active-aircraft` over HTTPS | Local-development UDP query is optional; it is not an authenticated production path. |
| HullCam | **1–2 fps** per camera when relay on | **HTTP only** — `POST /v1/hullcam/...` | See [BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline). |
| Lobby / session / messages | On demand + UI timers | Various `GET /v1/session/...`, `/lobby/rooms`, etc. | Lower rate than telemetry when not on Tower Desk. |
| Session chat (callouts) | **Rare** — only when `onApproach` and crossing 30/20/10 km KSC distance rings (debounced ~4 s) | `POST /v1/session/:id/messages` from `TowerTelemetryPublisher` | Optional auto-callouts; same auth as ACARS; negligible vs telemetry unless misconfigured. |

### Web Tower Desk (per browser tab)

| Traffic | Typical cadence | Path | Notes |
|---|---|---|---|
| HullCam tiles | **~1 Hz** per visible camera | `GET /v1/hullcam/:sid/:cam/snapshot.jpg` | Bearer `fetch`; 503 LOS is normal. |
| HullCam camera list | **2 s** when live WebSocket disconnected | `GET /v1/hullcam/:sid` | Paused when `useTowerLiveSubscriptions` has a live socket (see `web/src/live/useTowerLiveSubscriptions.ts`). |
| Session / messages / scorecard / checklist | **2–6 s** style polling | Regex-silenced in `httpRequestLogSilence.ts` | Hot for log noise, not always for CPU — responses are mostly JSON from memory/DB. |

### Voice

LiveKit media is **WebRTC to LiveKit Cloud** (or your SFU), **not** through this
Express process. The backend only mints tokens and handles control APIs.

---

## 2. UDP and HTTP fallback (plugin ↔ backend)

The normal authenticated path sends telemetry and live queries over HTTPS.
For local development only, **`useUdpLiveTransport=True`** can send empty-token
datagrams to `liveUdpHost:liveUdpPort` (`127.0.0.1:48788`). The Node process
keeps this optional listener disabled by default and bound to loopback.

- **`liveUdpFallbackHttp=True`** (default): if a local development UDP send
  fails or times out (`liveUdpTimeoutMs`), the plugin retries over HTTP.
- **`liveUdpFallbackHttp=False`**: failures stay on UDP only; useful for
  local debugging. Keep it enabled for normal use.

**Firewall:** do not expose the UDP port publicly. Production clients need the
API's HTTPS endpoint only.

---

## 3. Live WebSocket (browser ↔ backend)

The HTTP server also upgrades **`LIVE_WS_PATH`** (default `/v1/live/ws`) to a
WebSocket (`backend/src/live/wsTransport.ts`). Authenticated clients receive
push snapshots for topics like session record, hullcam meta, and tower
active-aircraft — reducing **some** HTTP polling in the SPA when connected.

Disable with **`LIVE_WS_ENABLED=false`** if you need to rule out WS during
incident response (rare).

---

## 4. Built-in live metrics (mod+)

**`GET /v1/live/metrics`** — requires **`mod`** or higher — returns in-process
counters from `backend/src/live/metrics.ts`, including:

- `udp_packets_in`, `udp_packets_dropped`, `udp_decode_errors`, `udp_auth_errors`, `udp_handler_errors`, `udp_replies_out`
- `live_http_requests` (incremented on selected hot HTTP routes)
- `ws_messages_out`, `ws_subscribers`
- `snapshot_builds` and `snapshot_encode_ms` (avg/max) for cached live snapshots

Use this during load tests instead of guessing from logs alone.

Additionally, every **30 s** at **`LOG_LEVEL=debug`**, `index.ts` logs
`getLiveMetricsSnapshot()` once — useful for long soak tests without hitting
the admin HTTP route.

---

## 5. How to profile (suggested workflow)

1. **Establish baseline** with one pilot + one controller, `GET /v1/live/metrics` before/after.
2. **Scale pilots** (or scripted `plugin_session` JWT + `POST /telemetry`) and watch **CPU**, **RSS**, and **network out** on the API host.
3. For local development, compare the HTTPS path with the optional loopback
   UDP path (`useUdpLiveTransport` / `LIVE_UDP_ENABLED`) on the same scenario.
4. **CPU profiling**: run Node with `--cpu-prof` or attach a profiler during a
   soak; expect time in JSON parse, repository methods, and (if HullCam is
   heavy) `sharp` in the hullcam snapshot path.
5. **DB**: telemetry and chat hit MariaDB — watch slow-query log if you raise
   pilot counts; most hot polls are tuned to avoid N+1 but your data volume
   dominates.

---

## 6. Log silencing (do not mistake for “zero cost”)

`httpRequestLogSilence.ts` skips **pino-http access lines** for routes like
`POST /v1/telemetry/*` and `GET /v1/hullcam/*/snapshot.jpg` so logs stay
readable. Those requests **still consume CPU and sockets** — silence is only
about log volume.
