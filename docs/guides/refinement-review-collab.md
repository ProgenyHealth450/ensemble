# Refinement Review (Collaborative)

The collaborative refinement flow replaces the terminal-based
AskUserQuestion interview with a browser-based HTML review session.
Reviewers answer structured questions, leave anchor-linked comments
against the document, and complete the session from the UI — the
artifact produced is consumed directly by the Enhancement phase.

## Quick start

```bash
# Local review (reviewer on the same machine)
/ensemble:refine-prd --collab docs/PRD/PRD-2026-019.md
/ensemble:refine-trd --collab docs/TRD/TRD-2026-019-*.md

# Remote review over Cloudflare Quick Tunnel
/ensemble:refine-prd --collab --tunnel=quick docs/PRD/PRD-2026-019.md
```

The first invocation starts a local HTTP server on `127.0.0.1`
(OS-assigned port), auto-opens the browser, and prints:

```
URL: http://127.0.0.1:61375/api/exchange?nonce=...
Token: ec4998e68e52a3e330ebfb988578ea0c368a33dfcbdd6cabc7bc1a27a8561d4d
```

The token is the bearer token for API clients; the URL is the
reviewer-facing share link (token-free — exchange converts it into a
cookie-bound session).

## Auth model

Three layers, intentionally tiered:

1. **Bearer token** (`Authorization: Bearer <token>` or
   `X-Ensemble-Token: <token>`). Durable, server-local. Never appears
   in URLs and is never written to the server's own log sink. The
   bootstrap may print the token once to stdout (`Token: <token>`)
   for manual fallback; treat that stdout line as sensitive. Used by
   API clients (Playwright tests, automation).
2. **Exchange nonce** (`?nonce=<id>` in the share URL). Single-use,
   10-minute TTL, URL-only. The reviewer opens the share URL, the UI
   POSTs to `/api/exchange` with the nonce, the server burns it
   atomically and mints a cookie session.
3. **Cookie session ID** (`review-sid=<sid>`). Per-device, opaque,
   bound to `{ sessionPath, permissions, csrfKey, expiresAt }`.
   Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/`
   (no `Domain=`). The `validateSession(sid, expectedSessionPath)`
   check rejects cross-instance SIDs — a session file moved to a
   different path renders all cookie sessions invalid.

Defense headers on every response:

- `Referrer-Policy: no-referrer` — prevents the URL (which contains
  the nonce) from leaking to third-party origins during navigation.
  This defends the URL, not the cookie; the cookie itself is
  `SameSite=Strict` so it never crosses origin boundaries.

## `--tunnel=quick`

Exposes the local server over a
[Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`*.trycloudflare.com`) so a reviewer on a different network can reach
the share URL without an account, API token, or DNS change.

Requires `cloudflared` on `PATH` (or `CLOUDFLARED_PATH`):

```bash
brew install cloudflared         # macOS
# or for Linux, see the Cloudflare downloads page for the package
# matching your distro and architecture:
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

The bootstrap flow:

1. Start the local HTTP server (`127.0.0.1:<ephemeral>`).
2. Spawn `cloudflared tunnel --url <localUrl>` — non-interactive,
   no auth.
3. Parse the `trycloudflare.com` URL from `cloudflared` stdout.
4. Call `server.setTunnelUrl(tunneledUrl)` which:
   - Strips trailing slashes.
   - Mints a fresh exchange nonce against the tunnel origin.
   - Rewrites `server.publicUrl`, `server.shareNonce`, `server.reviewUrl`.
   - Optionally re-fires the opener against the tunnel URL.
5. Print `Local:`, `Public:`, `URL:` lines.

The tunnel is torn down automatically when the bootstrap exits
(`finally { if (tunnel) await tunnel.stop(); }`). The QuickTunnel
URL is ephemeral — it changes every invocation.

## `--reviewers N`

When more than one stakeholder needs to review the same refinement
session in parallel (typical: a Product Manager invites 3–5
reviewers — security, design, ops, legal — to the same session),
the `--reviewers N` flag fans out a separate share URL per reviewer.
Each URL authenticates to the same underlying session/document, so
all reviewers share the same answer set and the same review URL
they hand off to the next step of the workflow.

```bash
# Local review, 3 reviewers on the same network
/ensemble:refine-prd --collab --reviewers 3 docs/PRD/PRD-2026-019.md

# Remote review, 5 reviewers behind a Cloudflare Quick Tunnel
/ensemble:refine-prd --collab --tunnel=quick --reviewers 5 docs/PRD/PRD-2026-019.md
```

Each reviewer redeems their own URL through `/api/exchange`. The
server **mints a fresh exchange nonce per `createShareUrl()` call**
and **burns it atomically on first use**, so a leaked `#k` URL cannot
be replayed by a second reviewer. The `1` default reproduces the
original single-URL behavior: `--reviewers` is strictly additive.

Output format:

```
# N=1 (default; matches pre-fan-out format)
URL: http://127.0.0.1:61375/api/exchange?nonce=<id>

# N=1 with --tunnel=quick
Local: http://127.0.0.1:61375
Public: https://<random>.trycloudflare.com
URL: https://<random>.trycloudflare.com/api/exchange?nonce=<id>

# N=3 with --tunnel=quick
Local: http://127.0.0.1:61375
Public: https://<random>.trycloudflare.com
URL #1: https://<random>.trycloudflare.com/api/exchange?nonce=<id-1>
URL #2: https://<random>.trycloudflare.com/api/exchange?nonce=<id-2>
URL #3: https://<random>.trycloudflare.com/api/exchange?nonce=<id-3>
```

Constraints:

- `N` is an integer in `[1, 50]`. Non-integers, values `< 1`, or
  values `> 50` cause the bootstrap to abort with a clear error
  message rather than silently truncate to `1`.
- Each `createShareUrl()` call writes one nonce to `session.json`
  (bounded by `N`); this is not free, but the cost is per session.
- `--reviewers` is independent of `--tunnel`; both apply, and the
  fan-out URLs all share the same `publicUrl` (local origin when
  no tunnel, tunnel origin when `--tunnel=quick`).
- All reviewers share the same `bearer` token under the hood —
  per-reviewer isolation comes from the **nonce** layer, not from
  per-reviewer tokens. Each reviewer's `review-sid` cookie is
  independently minted from their own nonce.

## `--long-lived`

The companion mode to `--collab` for sessions that run **all day**
(or longer) rather than a single 10-minute exchange. A long-lived
session swaps the **single-use nonce** for a **multi-use invite** and
adds a **username gate** + **presence tracking** so a team can hand
the URL around (chat, email, calendar) and anyone who joins sees
who else is currently inside the doc.

```bash
# Default TTL is 6h; override with --ttl
/ensemble:refine-prd --long-lived docs/PRD/PRD-2026-019.md
/ensemble:refine-prd --long-lived --ttl=8h docs/PRD/PRD-2026-019.md
/ensemble:refine-prd --long-lived --tunnel=quick docs/PRD/PRD-2026-019.md
```

### What changes

| Aspect | `--collab` (default) | `--long-lived` |
|---|---|---|
| Share credential | single-use `nonce` (10 min, burned on first POST) | multi-use `invite` (TTL-bounded, never burned) |
| URL shape | `/api/exchange?nonce=<id>` | `/api/exchange?invite=<id>` |
| Open URL | auto-fires the browser opener post-tunnel if `shouldOpen` is true | same — `open: false` is passed to `startServer` to defer the open past the tunnel, but the bootstrap fires the opener on the tunneled invite URL after step 5 (suppressed by `--no-open` or `CI=true`) |
| Port | explicit `--port` or `DEFAULT_PORT` | `0` (OS-assigned) for safety |
| Tunnel | opt-in via `--tunnel=quick` | implicitly `quick` (any `--tunnel` is forced to `quick`) |
| Auth gate | none beyond the nonce cookie | **username gate** — every reviewer submits a display name before the doc opens |
| Presence | n/a | server-side `Map<sid, { name, count }>`; broadcasts `viewers` event on every SSE connection; multi-tab refcounted |
| TTL | `NONCE_TTL_MS` (10 min) | `--ttl` (default `6h`, minimum `6h`) |
| Mutex | n/a | `--reviewers N` is rejected when `--long-lived` is present |

### Auth flow

1. The bootstrap calls `startServer({ longLived: true, ttlMs, port: 0, open: false })`. The server returns the local URL **plus** a freshly minted invite, defaulting the `shareUrl`/`reviewUrl` to `/api/exchange?invite=<id>`.
2. The reviewer opens the URL. The server validates the invite (exists, not expired) and returns an HTML form (`renderIdentifyForm`) with a hidden `invite` field and a visible `name` field.
3. The reviewer submits a display name. The server validates the invite again (multi-use), validates the name (≤ 100 chars, non-empty), mints a `review-sid` cookie with `displayName`, and redirects to `/`.
4. Every subsequent request must carry the cookie. Bearer tokens are **rejected** in long-lived mode — the cookie IS the credential.
5. Presence: when the SSE channel opens, the server adds `{ name, connectedAt }` to the `viewers` map (refcounted by `sid` for multi-tab) and broadcasts a `viewers` event. When the last SSE channel for a `sid` closes, the entry is removed and another `viewers` event is broadcast.

### TTL behaviour

The TTL timer starts when `server.listen` resolves. When it fires:

- The server is auto-stopped via `stop()` (idempotent — safe to call manually).
- The `completed` promise resolves with `{ artifactPath, session: null, stopped: true }` so foreground bootstraps can exit cleanly. A `/api/complete` call that lands before the timer fires wins normally — it sets `completedBy`/`completedAt` and resolves first.
- Invites that are sitting in the `invites` map past their `sessionExpiresAt` are removed lazily by `validateInvite(id)` — the next exchange attempt returns `null` and the server replies `401`. The TTL timer itself does not iterate the map; expiry is observed on access.

### Mutex

`--long-lived` and `--reviewers N` are mutually exclusive. The
bootstrap aborts with a clear error if both are present in
`$ARGUMENTS`. Rationale: the invite URL is already multi-use, so
fan-out is a non-feature; the presence layer expects a single
session-bound flow, not per-reviewer keying.

## Session persistence

Sessions are persistent and revision-tracked. Re-launching
`/ensemble:refine-prd --collab` against the same PRD path will:

1. Load the prior session envelope (under
   `~/.config/ensemble/logs/refinement-review/`).
2. If completed, automatically **reopen** the session (clears
   `completedAt`/`completedBy`, bumps revision by 1, verifies the
   document sha256, preserves all user answers/comments/selected
   options).
3. Migrate the question metadata forward — new `options` and
   `recommendedOptionId` are added, prior `answer`/`comments`/
   `selectedOptionId` are preserved.
4. Start a new server (new bearer token, new share URL).
5. Re-fire the opener (or tunnel) with the fresh URL.

To start over completely, delete the session file:

```bash
rm ~/.config/ensemble/logs/refinement-review/prd-2026-019-session.json
```

## Implementation contracts

The collaborative review is implemented in
`packages/core/lib/refinement-review/` and exposed via
`@sunstone-partners/ensemble-core`'s `refinementReview` namespace:

- `refinementReview.session.migrateOrCreate({ sessionPath, kind, sourcePath, questions, reopen })` — load or create+reopen a session, returning `{ session, token }`.
- `refinementReview.session.reopenSession({ sessionPath, expectedRevision })` — dedicated primitive that clears `completedAt`/`completedBy` and bumps revision while enforcing revision + document-integrity checks.
- `refinementReview.server.startServer({ sessionPath, token, uiDir, artifactPath, open })` — start the local HTTP server, returns `{ url, port, reviewUrl, shareNonce, openResult, completed, stop, setTunnelUrl, createShareUrl }`.
- `refinementReview.server.setTunnelUrl(url)` — re-mint share-nonce against a tunnel origin; returns `{ reviewUrl, shareNonce, publicUrl }`.
- `refinementReview.server.createShareUrl()` — mint an additional independent share URL bound to the current `publicUrl`; returns `{ reviewUrl, shareNonce, publicUrl }`. Idempotent: each call yields a fresh nonce, so multi-reviewer fan-out never collides.
- `refinementReview.tunnel.QuickTunnel({ targetUrl })` — Cloudflare QuickTunnel wrapper, returns `{ url, stop }` after `start()`.
- `refinementReview.opener.openUrl(url, opts)` — platform-native browser launcher.

The bootstrap script that orchestrates all of this is generated at
`~/.config/ensemble/logs/refinement-review/bootstrap.js` by the
ensemble product/development commands.
