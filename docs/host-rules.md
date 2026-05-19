# Host Rules

Host rules decide which hosts are **tracked** by the proxy. Tracked traffic shows up on the [Connections](connections.md) tab and is eligible for [interceptor](interceptor.md) and [block](block-rules.md) rules. Hosts that don't match any enabled host rule still pass through the proxy — they're simply not recorded.

This separation keeps the Connections view focused: most users only care about a handful of API hosts even when their entire OS is routed through Proxie.

## Adding a rule

1. Open the **Host Rules** tab.
2. Click **Add Rule** (top right).
3. Fill in the dialog:
   - **Host Pattern** — required. The hostname to match, with optional wildcard.
   - **Ignore Paths** (one per line) — optional. Requests on matching paths are skipped even if the host matches.
4. Click **Add**.

New rules are enabled by default.

## Host pattern syntax

| Pattern | Matches |
|---------|---------|
| `api.example.com` | Exactly `api.example.com`. |
| `*.example.com` | Every subdomain — `api.example.com`, `auth.example.com`, `a.b.example.com`. **Does not** match the apex `example.com` itself; add a separate rule if you need that. |
| `example.com` | Exactly the apex. |

Matching is case-insensitive. Port numbers are stripped before matching.

## Ignore paths

Ignore paths are noise filters scoped to a single rule. Each entry is a path pattern; the same wildcard syntax as the [Interceptor](interceptor.md) applies:

- `/health` — exact match.
- `/metrics/*` — anything under `/metrics/`.
- `/api/v*` — any version segment after `/api/v`.

Useful for silencing constantly-polled health-check or metrics endpoints. Paste one per line in the dialog.

## Managing rules

The table shows every rule with its toggle, pattern, ignore-paths chips, and per-row actions:

- **Toggle** — flip the switch to disable a rule without deleting it. Disabled rules are kept on disk but ignored by the proxy.
- **Edit** (pencil icon) — reopens the dialog with the rule's current values.
- **Delete** (trash icon) — removes the rule. There's no confirmation step; re-adding it is the recovery path.

All edits persist to `~/.config/proxie/config.json` (or the platform equivalent) as soon as you click **Update**.

## When traffic isn't showing up

If `curl -x http://127.0.0.1:39871 https://example.com -v` succeeds but Connections stays empty, the most common cause is "no host rule matches that host." Add `example.com` or `*.example.com`, retry, and the row should appear immediately — proxy traffic is observed via a live event stream, no refresh required.

## Sample rule set

A starter set that's useful for most API debugging:

| Host Pattern | Ignore Paths |
|--------------|--------------|
| `*.example.com` | `/health`, `/metrics` |
| `api.linkedin.com` | _(empty)_ |
| `localhost` | _(empty)_ |
