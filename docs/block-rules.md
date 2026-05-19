# Block Rules

Block rules are Pi-hole-style ad/tracker blocking implemented at the proxy layer. Matching requests are **short-circuited** — no upstream socket is opened — and the client gets either a 204 No Content (HTTP / decrypted HTTPS) or a 403 Forbidden (raw CONNECT).

Because the match happens after TLS termination (for HTTPS) or at request-line parse (for HTTP), block rules see the actual host + path. That's strictly more precise than DNS-level blockers, which only see the hostname.

## Order of operations

The proxy evaluates rules in this order on every request: **block → intercept → forward**. A block rule fires before an [intercept rule](interceptor.md) on the same host/path, and before any upstream socket is opened on the CONNECT path.

## Adding a rule

1. Open the **Block Rules** tab.
2. Click **Add Rule** (top right).
3. Fill in the dialog:
   - **Host Pattern** — required. Hostname with optional wildcard (`*.doubleclick.net`, `ads.example.com`).
   - **Path Pattern** — optional. Path pattern with wildcard (`/ads/*`, `/pixel/*`). Leave empty to block every path on the host.
   - **Note** — optional free-text label, shown in the table.
4. Click **Add**.

New rules are enabled by default.

## Pattern syntax

Same wildcard rules as the rest of Proxie:

| Pattern | Effect |
|---------|--------|
| `*.doubleclick.net` (host only) | Every subdomain of doubleclick.net, every path. |
| `tracker.example.com` + `/pixel/*` | Only `/pixel/*` on that exact host; other paths pass through. |
| `cdn.example.com` + `/ads/*` | Non-ad assets pass; ads on the same CDN are blocked. |
| `*` (host) + `/track` | Every host, but only the path `/track`. Use with care. |

Matching is case-insensitive.

## Response codes

| Path through Proxie | Response |
|---------------------|----------|
| Plain HTTP request, or decrypted HTTPS request after MITM | **204 No Content** — empty body. HTTP analogue of Pi-hole's NXDOMAIN: clients treat the resource as "nothing here" rather than as a network error. |
| Raw HTTPS CONNECT (no MITM, e.g. the CA isn't trusted yet) | **403 Forbidden**, tunnel actively refused. No upstream socket is opened. |

The corresponding row in the [Connections](connections.md) tab is flagged with a red `BLOCKED` badge.

## Seed Defaults

The **Seed Defaults** button (top right, next to **Add Rule**) adds a small curated list of well-known ad/tracker hosts as **disabled** rules so you can review and toggle them individually. Proxie never ships an opt-out block list — every rule is opt-in.

The curated seeds today are:

| Host Pattern | Note |
|--------------|------|
| `*.doubleclick.net` | Google ad serving |
| `*.googlesyndication.com` | Google ads |
| `*.googletagmanager.com` | Google Tag Manager (tracking) |
| `*.google-analytics.com` | Google Analytics |
| `*.adsystem.amazon.com` | Amazon ads |
| `*.facebook.net` | Facebook pixel / SDK |
| `*.scorecardresearch.com` | comScore tracking |
| `*.hotjar.com` | Hotjar session recording |

Seed Defaults is idempotent — clicking it again won't create duplicates of seeds you already have.

Proxie deliberately does **not** bundle EasyList or other community block lists; they're large, frequently updated, and licensing-sensitive. If you want comprehensive ad blocking, point Proxie at an upstream DNS blocker, or hand-craft the patterns you care about.

## Managing rules

The table shows every rule:

| Column | Meaning |
|--------|---------|
| **Enabled** | Switch to disable a rule without deleting it. |
| **Host Pattern** | The host glob. |
| **Path Pattern** | The path glob, or `(any path)` when blank. |
| **Note** | Your free-text label. |
| **Actions** | **Edit** (reopens the dialog), **Delete** (with confirmation dialog). |

Delete pops a confirmation modal — block rules can be tricky to recreate from memory, so the safety prompt is intentional.

## When a block rule isn't firing

- The rule is disabled. Check the **Enabled** switch.
- An earlier rule, or a different layer (DNS, hosts file, browser ad-blocker extension), is already eating the request.
- The host pattern doesn't actually match. Wildcards are positional — `*.example.com` does not match `example.com`. Add a second rule for the apex if needed.
- HTTPS without the CA installed: the request reaches Proxie as a raw CONNECT only, so Proxie can match on host but not on path. If you have a path pattern that doesn't include `*`, the rule won't fire — drop the path pattern (or install the CA, see [Setup](setup.md)).
