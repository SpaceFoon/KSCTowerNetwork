# Shift Log / Position Relief Briefing - Plan

> **World scoping:** Positions are `(worldId, airportId, role)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). `positions.json` is per-world; "Tower KSC" disambiguates by world when more than one world ships a KSC. Position-ownership Redis keys carry world+airport; brief snapshot prominently displays both when ambiguous.

## Purpose

Implement controller-to-controller handoff with an auto-generated relief brief: when one controller hands a position to another, the inbound controller sees a modal summarizing active runway, pattern traffic, current ATIS letter, open strips, and outstanding alerts. Inbound clicks **Acknowledge** to complete the handoff; the brief is persisted to the timeline.

This is the manual-first prerequisite for [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 6 (formal handoff mechanics) and a natural follow-on to [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) (you can only hand off a *position*, and a position is a frequency + a strip filter).

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 3.6.

---

## Design intent

- **Position, not user.** A controller occupies a *position* (Tower / Ground / Approach / etc.) defined by `(frequency, stripFilter, runwayScope)`. Handoff transfers ownership of the position; the user identities are bookkeeping.
- **Manual transition with a generated brief.** No "auto handoff at shift change" magic. Outgoing initiates; incoming accepts; both sides see the brief.
- **Brief is a snapshot, not a live view.** Frozen at handoff request time so both sides are looking at the same picture during verbal readback.
- **Everything is logged.** Even rejected or expired handoffs leave a timeline trail.
- **Reuses existing pieces.** Frequencies from [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), runway state from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md), ATIS letter from [ATIS_PLAN.md](ATIS_PLAN.md), alerts from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md), strips from the existing tower-aircraft endpoint.

Cross-references: [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 6 (handoff) + 7 (timeline), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md), [ATIS_PLAN.md](ATIS_PLAN.md), [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md), [IDENTITY_PLAN.md](IDENTITY_PLAN.md) (callsigns appear in the brief).

---

## Non-goals

- No automatic position transfer based on schedule / shift table. Phase later.
- No multi-position consolidation logic (one controller working 2 frequencies). Phase later.
- No voice-side handoff coordination (e.g., auto-rebroadcast "position change"). Optional add-on.
- No write-locks during the brief window (would block emergencies).
- No live-edit of the brief; only the optional outgoing-controller note.

---

## Data model

### Position

Declarative `backend/data/positions.json`:

```jsonc
[
  { "id": "tower-ksc",   "displayName": "KSC Tower",        "frequencyId": "freq-twr-ksc",      "stripFilter": "in-pattern" },
  { "id": "ground-ksc",  "displayName": "KSC Ground",       "frequencyId": "freq-gnd-ksc",      "stripFilter": "taxi" },
  { "id": "approach-ksc","displayName": "KSC Approach",     "frequencyId": "freq-app-ksc",      "stripFilter": "inbound-far" }
]
```

Loaded by a new `backend/src/services/positions.ts`. Frequencies referenced here must exist in [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)'s `frequencies.json`.

### Position ownership (Redis)

Key: `position:{id}:owner` → `{ userId, callsign, sinceMs }` or unset (vacant).

Vacant positions are bookable without handoff. Owned positions require an incoming handoff to change.

### Handoff record (Redis + persisted timeline entry)

```ts
interface HandoffRecord {
  id: string;
  positionId: string;
  fromUserId: string;
  toUserId: string;
  status: "pending" | "acknowledged" | "rejected" | "expired" | "cancelled";
  brief: ReliefBrief;
  outgoingNote?: string;
  createdAtMs: number;
  acknowledgedAtMs?: number;
  expiresAtMs: number;
}
```

Default expiry: 5 min from creation. Tunable per-position.

### ReliefBrief shape

Snapshot taken at handoff creation, embedded in the record so the inbound side sees the same data the outgoing side did even if the world moves on:

```ts
interface ReliefBrief {
  positionId: string;
  positionDisplayName: string;
  frequencyId: string;
  capturedAtMs: number;
  weather: { wind?: string; altimeter?: string; metar?: string };
  atis: { letter?: string; broadcastHash?: string };
  activeRunways: Array<{ id: string; state: string; occupiedBy?: string }>;
  strips: Array<{
    sessionId: string;
    callsign: string;
    squawk?: string;
    state: string;
    notes?: string;
    flagged?: boolean;
  }>;
  alerts: Array<{ id: string; severity: string; source: string; summary: string }>;
  outstandingClearances: Array<{ sessionId: string; clearance: string; issuedAtMs: number }>;
  voiceParticipantsOnFreq: Array<{ userId: string; callsign: string }>;
}
```

Builder lives in `backend/src/services/handoffBrief.ts`.

---

## API

All in [backend/src/routes/api.ts](backend/src/routes/api.ts), all controller-role-gated.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v1/tower/positions` | List positions + current owner. |
| `POST` | `/v1/tower/positions/:id/claim` | Claim a vacant position. 409 if owned. |
| `POST` | `/v1/tower/positions/:id/release` | Owner releases (no incoming). Position becomes vacant. |
| `POST` | `/v1/tower/positions/:id/handoff` | Body: `{ toUserId, note? }`. Creates handoff, snapshots brief, returns record. Owner only. |
| `GET`  | `/v1/tower/handoffs/incoming` | Pending handoffs targeted at the calling user. |
| `GET`  | `/v1/tower/handoffs/:id` | Fetch by id (sender or recipient). |
| `POST` | `/v1/tower/handoffs/:id/ack` | Recipient accepts; ownership transfers; record marked acknowledged. |
| `POST` | `/v1/tower/handoffs/:id/reject` | Recipient rejects with optional reason; ownership unchanged. |
| `POST` | `/v1/tower/handoffs/:id/cancel` | Sender cancels before ack. |

SSE stream `GET /v1/tower/handoffs/stream` pushes lifecycle events to the calling user (incoming arrived, status changed). Reuses the SSE plumbing from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) Phase 1 if shipped first, else stand-alone.

### Authorization

- `claim` / `release` / `handoff` / `cancel`: must own the position (or vacant for claim).
- `ack` / `reject`: must be the targeted user.
- `mod` and above can force-release any position via the existing admin path; logged.

### Atomicity

`ack` performs ownership transfer + handoff status update inside a single Redis `MULTI` transaction. If the position has changed owner since the handoff was issued (rare race), the ack returns 409 and the brief is kept as a historical artifact.

---

## Frontend

### TowerDesk position bar

Top of [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) gets a horizontal `PositionBar` strip:

```
[ KSC Tower : BOBCAT 7 (you) ] [ KSC Ground : VACANT ] [ KSC Approach : KIRBY (1h12) ]
            [ HAND OFF... ]              [ CLAIM ]
```

Each chip shows: position name, current owner callsign, time-on-position. Buttons depend on viewer relationship (own / vacant / other).

### HandoffModal (outgoing)

- Pick recipient from a list of online controllers (filtered by `controller` role).
- Optional note textarea (≤500 chars).
- Preview of the brief (read-only).
- **Send handoff** button. Modal stays open showing "Waiting for ack..." with a countdown.
- **Cancel** while pending.

### HandoffModal (incoming)

Auto-pops on the recipient's screen when SSE delivers a new pending handoff:

```
Position relief: KSC Tower from BOBCAT 7

Wind 270/8  Altimeter 29.92  ATIS Charlie
Active runway 09 (cleared)

Strips (3):
- Bobcat 11  in pattern  squawk 1200
- Munflyer 4 inbound 12nm squawk 4521
- Test Wing 2 taxi squawk 1200

Alerts (1):
- WARNING: stuck-mic on Bobcat 11 (acked)

Outstanding clearances (1):
- Munflyer 4: cleared visual 09, report 5-mile final

Outgoing note:
"Heads up - Bobcat 11 doing closed traffic, requested 5 more circuits."

[ Acknowledge & take position ]   [ Reject ]
```

Acknowledge advances ownership immediately; the chip in the position bar updates on both clients within ~500 ms.

### Reject reason picker

Dropdown: `Not ready` / `Wrong recipient` / `Frequency busy` / `Other` + free text.

### Position bar SSE updates

Both sender and recipient see live status updates without polling.

### Outgoing controller post-handoff

After ack, sender's HandoffModal swaps to a "transferred" confirmation, then closes. The sender's strip filter immediately stops showing position-scoped strips; voice tuning *does not* auto-untune the frequency (operator may want to monitor); a small toast prompts "You're no longer on KSC Tower - untune frequency?".

### Plugin surface (optional, Phase 4)

[TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) gets a small `Active controller: KIRBY` line so pilots see who's on the position (already implicit from voice but explicit reduces "who am I talking to" confusion). Updates from the same `positions` endpoint via the existing telemetry response.

---

## Brief content rules

- **Snapshot at request time.** Builder calls each source service once; result is frozen on the record. Re-opens of the brief read the saved snapshot, not live.
- **Strip count cap** at 50; if more, brief shows `... +N more` with the top 50 sorted by recency.
- **Alert filter:** include `unresolved` + `acknowledged within last 30 min`. Resolved-and-old alerts are omitted.
- **Outstanding clearances:** any clearance issued within the last 5 min that hasn't been read back. Initially Phase 3 - until the structured-clearance work in roadmap section 3 lands, this section is empty and the brief shows "(clearance log not yet available)".
- **Outgoing note:** last-mile context; required only if any alert is unresolved or if any strip is flagged. Otherwise optional. UI nudges with a hint, doesn't enforce.

---

## Phasing

### Phase 1 - Position model

- `positions.json` config, `positions.ts` service, ownership Redis keys.
- `GET /v1/tower/positions`, `claim`, `release`.
- `PositionBar` on TowerDesk with claim/release.

Exit: two controller accounts can claim and release positions; bar updates live across browsers.

### Phase 2 - Brief builder

- `handoffBrief.ts` consumes frequencies + runways + ATIS + alerts + strips and returns a brief.
- Stand-alone `GET /v1/tower/handoffs/preview-brief?positionId=...` for testing.

Exit: hitting the preview endpoint returns a fully-formed brief JSON for any position.

### Phase 3 - Handoff lifecycle

- `handoff` / `ack` / `reject` / `cancel` / `incoming` / SSE stream.
- HandoffModal (outgoing + incoming variants).
- Position bar shows handoff state.

Exit: full handoff round-trip between two controllers; ownership transfers atomically; both sides see the brief.

### Phase 4 - Persistence + plugin surface

- Timeline entry on every handoff lifecycle event (reuses roadmap section 7 plumbing once available; until then writes to a stand-alone `handoff_history` table).
- Plugin "active controller" line on [TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs).
- Force-release for mods.

Exit: handoff history visible from a "shift log" view; plugin shows current controller.

### Phase 5 - Roadmap §6 integration

- Roadmap section 6 builds *on top* of this position model (not parallel) - clearance ownership, strip ownership all key off `position.owner`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Owner goes offline mid-position | Heartbeat from each controller client; if owner heartbeat absent >120 s, position auto-marked `stale` (not vacant) and any other controller can `force-claim` with a one-click "take over" - logged as orphan recovery. |
| Two controllers race-claim a vacant position | Redis `SET NX` on the ownership key; loser sees 409 and bar refreshes. |
| Handoff sent to wrong recipient | Recipient picker shows online controller list with callsigns + position; reject + reason path is fast. |
| Brief grows huge with many strips | 50-strip cap with `+N more`; strips sorted by recency. |
| Brief stale by ack time | Acceptable - that's the point of the snapshot. Inbound calls "live" view (same TowerDesk) immediately after ack. |
| Voice didn't auto-tune to the new position | Out of scope intentionally; toast prompts manual tune. Future automation lives in [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md). |
| Position abandoned during emergency | Mods can force-release; force-release auto-creates an `unowned-during-alert` warning on the alerts feed. |
| Outgoing controller dishonestly omits a flag in the note | Brief auto-pulls flagged strips and unresolved alerts regardless of note - the note can't hide them. |
| Handoff during ATIS letter rotation | Brief captures the letter at snapshot; if it changes mid-ack the inbound sees a small "ATIS rotated to D" toast on accept. |
| Roadmap §6 wants a different shape | Build §6 on this model rather than parallel; if §6 needs new fields, extend `HandoffRecord` instead of forking. |

---

## Test plan

- Vacant claim by single controller succeeds; second controller's claim returns 409; bar updates within 1 s.
- Release by owner returns position to vacant.
- Handoff round-trip: outgoing creates, incoming sees within 1 s, acknowledges, ownership transfers, both bars update.
- Reject: ownership unchanged; outgoing modal closes with rejection reason.
- Cancel by sender before ack works.
- Expiry: handoff older than 5 min auto-marked `expired`; incoming modal removes itself.
- Force-claim after 120 s heartbeat absence, orphan-recovery alert lands.
- Brief includes correct ATIS letter, runway states, alerts, strips at snapshot time.
- 60-strip session: brief shows 50 + "+10 more".
- Two simultaneous handoffs targeting the same recipient queue politely (only one modal visible; the second is in a small "1 more" pill).
- Acknowledge after position changed owner returns 409; old brief still readable from history.

---

## Files touched

**Backend (new)**

- `backend/data/positions.json`.
- `backend/src/services/positions.ts`.
- `backend/src/services/handoff.ts` - lifecycle, Redis ops.
- `backend/src/services/handoffBrief.ts` - snapshot builder.

**Backend (edits)**

- [backend/src/routes/api.ts](backend/src/routes/api.ts) - 9 endpoints + SSE.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - join `position.owner` into tower-aircraft response so plugin can show active controller.
- `backend/src/config/env.ts` - `HANDOFF_EXPIRY_MS`, `POSITION_HEARTBEAT_MS`.

**Web (new)**

- `web/src/components/PositionBar.tsx`.
- `web/src/components/HandoffModal.tsx`.
- `web/src/components/HandoffBriefView.tsx` - shared brief renderer.
- `web/src/hooks/useHandoffStream.ts`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount PositionBar; wire HandoffModal.

**Plugin (edits)**

- [PluginSrc/TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) - "Active controller: <callsign>" line, sourced from telemetry response.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 3.6 to point at this doc.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 6 to reference this as the position-model foundation.
