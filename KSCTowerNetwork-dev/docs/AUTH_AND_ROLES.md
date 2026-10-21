# Auth & Roles

Three concepts:

1. **Token type** — what kind of bearer the request carries.
2. **Role** — what the user is allowed to be.
3. **Capability** — fine-grained "may do X" derived from the role.

## Token types

All app-issued tokens are HS256 JWTs signed with `APP_JWT_SECRET`. The
`token_type` claim is the discriminator.

| `token_type` | Issued by | Lifetime | Used by |
|---|---|---|---|
| `tower_web` | `POST /v1/auth/login` | `APP_JWT_EXPIRES_IN_SECONDS` (default 7 days) | Browser tab after login. |
| `plugin_session` | `POST /v1/auth/plugin/exchange` | Long-lived (effectively until revoked) | KSP plugin, persisted in `auth.cfg`. |
| `guest` | `POST /v1/auth/guest` | `APP_JWT_EXPIRES_IN_SECONDS` | Browser-only spectator/co-pilot sessions. IP-bannable. |
| Clerk session | Clerk SDK | Clerk-managed | When `CLERK_SECRET_KEY` / `CLERK_JWT_KEY` set; `requireAuth` falls through to `verifyToken`. |
| dev bearer | Static `DEV_BEARER_SECRET` | n/a | Local dev only. Constant-time compared. |
| dev open | None | n/a | Local dev only when `DEV_OPEN_AUTH=true`. |

`req.auth` after `requireAuth` is always:

```ts
{ userId: string,
  tokenType: "clerk" | "plugin" | "guest",
  email?: string,
  displayName?: string,
  ip: string }
```

(`tower_web` is mapped to `tokenType: "clerk"` for back-compat with older
consumers; the discriminator lives in the JWT itself.)

## Roles

Six roles, ordered:

```
guest  <  pilot  <  controller  <  mod  <  supermod  <  owner
  0        1          2            3        4           5
```

Comparison is **always** through `roleAtLeast(actor, min)` in
`backend/src/services/repository.ts`. Don't string-equality-compare roles
outside that file.

### Per-role description

| Role | Default surface |
|---|---|
| `guest` | Browser-only, IP-bannable. Can only join lobby chat & spectate. No voice publish. No plugin pairing. |
| `pilot` | Logged-in pilot account. Full session lifecycle, telemetry, voice. |
| `controller` | Pilot capabilities + can be assigned to tower seats. Sees `TowerDesk`. |
| `mod` | Controller capabilities + temp ban / mute / IP ban / report queue. |
| `supermod` | Mod capabilities + permanent bans. |
| `owner` | Everything, including grant/revoke roles. |

### Owner immunity

`OWNER_USER_ID` env pins exactly one user as `owner`. They are:

- Always returned as `owner` from `getUserAccess`, regardless of DB row.
- **Cannot be banned, muted, demoted, or have their LiveKit publish
  revoked** — every moderation endpoint short-circuits on
  `isOwnerImmuneId(userId)`.

Don't set this in dev. Don't set it for two users. The env var is
deliberately single-valued.

## Account bans

Role- and capability-gated requests check the current ban state and return
`403 banned`. The live WebSocket transport checks access during live pushes,
caches it for up to one second, and closes banned users with code `4003`. The
optional UDP transport is local-development only, rejects non-empty tokens,
and checks the development user's ban state. The configured owner remains
immune.

## Capabilities

Defined in `backend/src/services/repository.ts`:

```ts
export type Capability =
  | "chat:lobby"
  | "chat:session"
  | "chat:dm"
  | "voice:speak"
  | "plugin:use"
  | "controller:assume"
  | "mod:mute"
  | "mod:ban_temp"
  | "mod:ban_perm"
  | "mod:ban_ip"
  | "owner:grant_role";
```

`capabilitiesFor(role: Role): Set<Capability>` is the single mapping.
**Capabilities are derived, not stored.** To grant one capability without
the role above it, you have to either (a) add a new role, or (b) introduce
a per-user override (currently not supported on purpose).

### Cumulative capability matrix

(Higher roles include lower-role capabilities. Read top to bottom.)

| Capability | guest | pilot | controller | mod | supermod | owner |
|---|---|---|---|---|---|---|
| `chat:lobby`        | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `chat:session`      |   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `chat:dm`           |   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `voice:speak`       |   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `plugin:use`        |   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `controller:assume` |   |   | ✓ | ✓ | ✓ | ✓ |
| `mod:mute`          |   |   |   | ✓ | ✓ | ✓ |
| `mod:ban_temp`      |   |   |   | ✓ | ✓ | ✓ |
| `mod:ban_ip`        |   |   |   | ✓ | ✓ | ✓ |
| `mod:ban_perm`      |   |   |   |   | ✓ | ✓ |
| `owner:grant_role`  |   |   |   |   |   | ✓ |

> Verify against `capabilitiesFor` in `repository.ts` if you suspect drift.

## Mute

Mutes are a **per-user state** (not a capability). Stored in the same
table as bans, distinguished by `kind`. `assertNotMuted(req, res)` is a
helper used by every chat/voice publish endpoint:

```ts
async function assertNotMuted(req, res) {
  const access = await getUserAccess(req.auth.userId);
  if (access.isMuted) { res.status(403).json({ error: "You are muted", reason: "muted" }); return false; }
  return true;
}
```

If you add a new "user-generated content" endpoint, plumb `assertNotMuted`
through it.

## IP ban

`loadIpBan` runs **before every route**, including `/auth/guest`. A banned
IP cannot mint a fresh guest token. The match is exact-string against
`req.ip` (Express trust-proxy aware). To trust `X-Forwarded-For` from a
load balancer, set `app.set('trust proxy', 1)` in `index.ts` (already
done for one hop).

## Adding a new role

1. Add it to the `Role` union in `repository.ts`.
2. Add a rank in `ROLE_RANK` (gap-leave if you want; ordering is what
   matters).
3. Add a row to the `capabilitiesFor` switch.
4. Update the dev-role mapping in `env.ts` if any old `.env.development`
   files reference the legacy name.
5. Update this file's matrix.
6. Update `AGENTS.md` if the new role changes the headline role list.

## Adding a new capability

1. Append to the `Capability` union.
2. Add it to whichever roles should include it in `capabilitiesFor`.
3. Use `requireCapability("your:cap")` on the new route.
4. Update this file's matrix and the [API_REFERENCE.md](API_REFERENCE.md)
   gate column.
