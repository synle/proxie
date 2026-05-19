# Connections

The Connections tab is the live traffic view — every HTTP request and decrypted HTTPS request that flows through Proxie appears here in real time.

## How traffic is captured

- Start the proxy from the toggle in the top app bar.
- Point your client (browser, `curl`, OS proxy) at `127.0.0.1:39871` (the default; configurable on the [Setup](setup.md) page).
- HTTP requests are captured as-is. HTTPS requests are decrypted via the locally-installed CA cert (see [Setup](setup.md)) before being logged.
- Only hosts that match an enabled rule on the [Host Rules](host-rules.md) page are tracked. Other hosts still pass through the proxy unchanged — they're just not recorded.

The list is in-memory only and capped at **10,000 entries**. Once full, oldest rows are evicted. Use the broom icon at the top right to clear the table manually.

## Columns

| Column | What it shows |
|--------|---------------|
| **Method** | HTTP verb (`GET`, `POST`, …). Rows served by an intercept rule get a purple `INTERCEPTED` badge; rows short-circuited by a block rule get a red `BLOCKED` badge. |
| **URL** | Full request URL. Truncated with ellipsis when long; the detail drawer shows the unabbreviated value. |
| **Status** | HTTP status code, colour-coded (`green 2xx`, `amber 3xx`, `red 4xx/5xx`). Empty while the response is still pending. |
| **Duration** | Wall-clock time from request start to response end. Rendered as a coloured bar (`green < 200 ms`, `amber < 1 s`, `red ≥ 1 s`) plus a numeric value. |
| **Size** | Response body size in B / KB / MB. |
| **Time** | Local wall-clock timestamp of the request. |

The table auto-scrolls to the bottom as new connections arrive so you always see the newest traffic.

## Filtering

Two filter layers stack on top of each other — a global search and per-column filters.

### Global search

The text field above the table is a contains-match against the URL, host, method, and status of every row. Type `example.com`, `POST`, `404`, or any substring.

### Per-column filters

A second header row inside the table holds dedicated controls for each column:

- **Method** — multi-select. Pick any combination of `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `CONNECT`. Leave empty to allow any.
- **URL contains** — substring match (case-insensitive). Also exposes a `reset filters` button when any column filter is active.
- **Status** — multi-select bucket filter: `1xx`, `2xx`, `3xx`, `4xx`, `5xx`.
- **Duration** — operator (`≥` / `≤`) + numeric value in milliseconds. Rows with no duration yet are filtered out when this is set.
- **Size** — operator (`≥` / `≤`) + numeric value in bytes against the response size.
- **Time window** — dropdown: `Any`, `Last 5 min`, `Last 15 min`, `Last 1 h`, `Last 6 h`, `Last 24 h`.

Filters compose with AND — a row must satisfy every active filter.

## Detail drawer

Click any row to open a 520-px detail drawer on the right. It shows:

- **General** — Intercepted yes/no, Blocked yes/no, URL, Host, Duration, Request Size, Response Size, Content-Type, Timestamp. The Intercepted/Blocked rows are highlighted when set.
- **Request Headers** — every key/value pair sent by the client.
- **Response Headers** — every key/value pair returned by the server (or the intercept rule).
- **Request Body** — see the body section below.
- **Response Body** — see the body section below.
- **Generate code** — see the codegen section below.

Click outside the drawer or hit `Esc` to close.

## Body preview

Both Request Body and Response Body cards behave the same way:

- **Text bodies** (`application/json`, `text/*`, XML, JS, CSS, …) render in a `<pre>` block.
- **Binary bodies** are stored by the Rust backend as `data:<mime>;base64,<payload>` URIs and rendered with the matching HTML element:
  - `image/*` → `<img>`
  - `video/*` → `<video controls>`
  - `audio/*` → `<audio controls>`
  - `application/pdf` → `<iframe>`
  - Anything else binary → a placeholder reading `Binary content — <mime> (<size>). Use "Save" to download.`

### Format

The **Format** button pretty-prints the body in place. Supported content types:

- JSON — `JSON.parse` + 2-space indent.
- XML / HTML — naive tag-by-tag re-indent.
- CSS / JavaScript — brace-depth re-indent.

If a formatter isn't available for the body's MIME type, or formatting fails, you get a toast and the body is left unchanged. Formatted output is per-row — switching to another connection resets the view.

### Save

The **Save** button triggers a browser download via `Blob` + `URL.createObjectURL`. Works inside the Tauri webview just like a regular browser. The filename is inferred from the URL path plus the body kind (`request` / `response`) and a MIME-derived extension.

## Generate code

Below the body cards is a code-generation dropdown that emits an equivalent request snippet so you can replay the captured call outside Proxie:

- **curl** — line-continued `curl -X METHOD 'url' -H 'header: value' --data-raw '…'`.
- **python (requests)** — `requests.request(method, url, headers=…, data=…)`.
- **node (fetch)** — `await fetch(url, { method, headers, body })`.

Binary request bodies are replaced with `<binary body — see request in Proxie>` placeholders so a paste-and-go terminal command isn't full of base64 noise. The copy icon next to the dropdown puts the snippet on your clipboard and shows a toast.

## Header controls

- **Refresh** (circular-arrow icon) — re-loads the in-memory list from the backend. Useful if you suspect the live event stream missed an entry.
- **Clear all** (broom icon) — wipes the in-memory log.
