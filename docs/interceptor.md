# Interceptor

Intercept rules let you replace or redirect requests in flight. There are two action kinds:

- **Mock** — return a synthetic response from Proxie without touching the upstream server.
- **Reroute** — forward the request to a different target URL.

Rules apply uniformly to HTTP and decrypted HTTPS — the same host/path/method pattern matches either scheme.

## Adding a rule

1. Open the **Interceptor** tab.
2. Click **Add Rule** (top right).
3. Fill the form:
   - **Rule Name** — required. Free-text label shown in the table.
   - **Host** — required. Same wildcard syntax as [Host Rules](host-rules.md) (`api.example.com`, `*.example.com`).
   - **Path** — required. Path pattern, e.g. `/users/123` or `/api/*` or `/api/v*`.
   - **Method** — optional. Pick one of `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`/`HEAD`, or leave as **Any** to match every verb.
   - **Action** — toggle between **Mock Response** and **Reroute**.
4. Configure the action (see below).
5. Click **Add**.

New rules are enabled by default.

## Rule ordering — first match wins

Rules are evaluated **top-to-bottom** in the order they appear in the table, and the **first** rule whose host + path + method all match takes effect. Subsequent rules on the same request are ignored. There's no inline reorder UI today — to nudge priority, delete-and-readd in the desired order.

Block rules ([Block Rules](block-rules.md)) take effect **before** intercept rules. The full order of operations is `block → intercept → forward`.

## Mock action

A mock response is built in HAR 1.2 shape under the hood and lets you fully synthesize the reply:

- **Status Code** — pick from the dropdown (`200 OK`, `204 No Content`, `301 Moved Permanently`, `401 Unauthorized`, …) or any value if you re-edit afterwards.
- **Content-Type** — defaults to `application/json`. Free-text; whatever you set goes onto the response.
- **Response Body** — the literal body returned to the client. Use a monospaced editor; nothing is escaped or formatted on save.

### Import from HAR

To copy a real captured response into a mock rule:

1. Open the captured row on the [Connections](connections.md) tab, copy the JSON of the response (browser DevTools "Copy as HAR" works, or hand-paste a HAR `response` object).
2. Paste the JSON blob into the **Response Body** field.
3. Click **Import from HAR Response**.

Proxie extracts:

- `status` → Status Code
- `statusText` → status text (filled if blank)
- `headers[].name == "content-type"` → Content-Type
- `content.mimeType` → Content-Type (fallback)
- `content.text` → Response Body (replaces the JSON you pasted)

If the paste isn't valid JSON, or doesn't have `status` + `content` fields, you get an inline error and nothing changes.

## Reroute action

A reroute sends the request to a different URL. Useful for swapping staging vs prod or pointing a mobile app at a local dev server.

- **Target URL** — required. Full URL including scheme, e.g. `https://staging.example.com/api/users`.

Headers, method, and body are forwarded as-is to the new target. The original `Host` header is rewritten to match the target host.

## Managing rules

The table columns:

| Column | Meaning |
|--------|---------|
| **On** | Switch to enable / disable without deleting. |
| **Name** | Your free-text label. |
| **Match** | Chips for method (if set), host, and path. |
| **Action** | Purple `Mock <status>` chip for mock rules, orange `Reroute` chip for reroute rules. |
| **Actions** | **Duplicate** (clone with `" (copy)"` suffix), **Edit**, **Delete**. |

Duplicate is handy when you want one rule per status code or per environment — clone, edit the copy, leave the original.

## Verifying

After saving, request the matching URL. On the [Connections](connections.md) tab, the row should show:

- The configured status code (for mock).
- A purple `INTERCEPTED` badge next to the method.
- Either the mocked response body or the rerouted target's response body.

If a request that should match is going through to the original upstream, check (in order): the rule is enabled, the host/path patterns actually match (wildcards are positional), the method filter isn't excluding it, and no earlier rule is winning the first-match race.
