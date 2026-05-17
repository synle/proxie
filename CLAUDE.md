# Proxie — Agent Context

> This file is the single source of truth for both Claude Code and the GitHub
> Copilot CLI. `.github/copilot-instructions.md` is a symlink to this file —
> edit `CLAUDE.md` only.

## What is this project?

Proxie is a lightweight HTTPS proxy interceptor desktop app (like Charles Proxy, but free and fast). Built with Tauri v2 (Rust) + React 19 + MUI 9.

## Tech stack

- **Frontend:** React 19, TypeScript, MUI 9, Vite 6, React Router 7
- **Backend:** Rust, Tauri v2, Tokio, Hyper, rcgen (cert generation), rustls / tokio-rustls, flate2 + brotli (response decompression), base64
- **Tests:** Vitest + React Testing Library (frontend), `cargo test` (Rust)
- **CI:** GitHub Actions on macOS ARM/Intel, Windows, Linux

## How to run

```bash
npm install                    # Install frontend deps
npx tauri dev                  # Full app (frontend + Rust)
npm run dev                    # Frontend only at localhost:1420
npm test                       # Frontend tests
cd src-tauri && cargo test     # Rust tests
npx tsc --noEmit               # TypeScript type check
```

**VSCode debugging:** `.vscode/launch.json` provides three configs — Tauri
Dev (lldb-based, runs Rust + Vite together via the `ui:dev` task in
`.vscode/tasks.json`), Vitest run-all, and Vitest debug-current-file. The
`!.vscode/launch.json` and `!.vscode/tasks.json` un-ignore rules in
`.gitignore` keep these tracked while excluding personal `settings.json`.

## Project layout

```
src/                           # React frontend
  App.tsx                      # Routes + MUI theme
  components/Layout.tsx        # Shell: AppBar, nav drawer, proxy toggle
  pages/ConnectionsPage.tsx    # Live traffic view + detail drawer (filters / preview / format / save / codegen)
  pages/HostRulesPage.tsx      # Host tracking CRUD
  pages/InterceptorPage.tsx    # Mock/reroute rule CRUD
  pages/BlockRulesPage.tsx     # Pi-hole style block rules
  pages/SetupPage.tsx          # Proxy config + SSL cert management
  test/setup.ts                # Vitest setup with Tauri mocks

src-tauri/src/                 # Rust backend
  lib.rs                       # Tauri commands + app setup
  proxy.rs                     # HTTP/HTTPS proxy engine (parse_response decodes chunked / gzip / deflate / br, base64-encodes binary bodies as data: URIs)
  cert.rs                      # CA cert generation + install instructions
  state.rs                     # AppState, persistence, rule matching
  tls.rs                       # MITM helpers: LeafCertCache, ServerConfig builder, native upstream connector
  types.rs                     # All data types (CertInfo, HostRule, InterceptRule, BlockRule, ConnectionLog, etc.)
```

## Key conventions

- All frontend-backend IPC uses Tauri `invoke()` commands
- Tauri commands are defined in `lib.rs`, delegating to `state.rs` / `proxy.rs` / `cert.rs`
- State is persisted to `~/.config/proxie/config.json` on every CRUD operation
- Connections are in-memory only (max 10,000)
- Intercept rules use HAR 1.2-inspired format for mock responses
- `host_matches()` supports `*.example.com` wildcards
- `path_matches()` supports `/api/*` and `/api/v*` wildcards
- New fields on `PersistedState` must use `#[serde(default)]` for backward compatibility
- `ConnectionLog.response_body` is either plain UTF-8 text or a `data:<mime>;base64,...` URI for binary content. The frontend detects the `data:` prefix to render `<img>` / `<video>` / `<audio>` / `<iframe>` instead of a corrupted `<pre>` blob.

## Testing

- Frontend tests mock all Tauri APIs in `src/test/setup.ts`
- Rust tests are inline `#[cfg(test)]` modules in each file
- CI runs both test suites on all 4 platforms before building
- Always run `npm test` and `cargo test` before committing

## Build pipeline

- CI config: `.github/workflows/build.yml`
- 4-platform matrix: macOS ARM, macOS Intel, Windows, Linux
- PR builds post artifact download links as comments

## Rust coverage gate

The `coverage` job in `build.yml` runs `cargo llvm-cov --lib --summary-only` from `src-tauri/` on Linux and fails the build if lines / functions / regions drop below the v0.4.2 floored baseline (lines ≥ 42, functions ≥ 34, regions ≥ 45). HTML reports are uploaded as the `coverage-reports` artifact (14d retention) and the totals are appended to `$GITHUB_STEP_SUMMARY`. Raise these floors when coverage improves; never lower them.

## Connections page UX (v0.4.3+)

- Per-column filters live in the table header: method / status multi-selects, URL substring, duration / size numeric (operator + value), and a "time window" dropdown. The legacy free-text filter still exists as a global URL/host/method/status contains-search above the table.
- Response body cards offer a **Format** button (JSON / HTML / XML / CSS / JS), a **Save** button (browser download via `Blob` + `URL.createObjectURL`, works inside the Tauri webview), and a code-generation dropdown that emits **curl**, **Python `requests`**, or **Node `fetch`** snippets so the request can be replayed from a terminal or test script.
- Binary responses (`image/*`, `video/*`, `audio/*`, `application/pdf`) are stored as `data:` URIs by `parse_response` and rendered with the appropriate HTML media element. Everything else binary shows a "binary content (N bytes)" placeholder with a Save button.

## Known MITM limitations

Some clients pin their server certificates and will reject Proxie's CA even when it's installed in the system trust store. Apple's iCloud daemon (`gateway.icloud.com`), Apple Push Notification Service, the App Store, and most banking apps fall into this bucket — the TLS handshake closes with EOF before any data flows. Proxie surfaces this in the connection log as `"MITM error: TLS handshake with client failed (likely certificate pinning — common for iCloud, App Store, banking apps): ..."`. This is expected and cannot be fixed from the proxy side.

## GitHub Raw File URLs

When fetching raw file content from GitHub repos, always use the `?raw=1` blob URL format:

```
https://github.com/{owner}/{repo}/blob/head/{path}?raw=1
```

Do NOT use:

- `https://api.github.com/repos/{owner}/{repo}/contents/{path}` (GitHub Contents API)
- `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`

## Common tasks

- **Add a new Tauri command:** Define in `lib.rs`, implement in `state.rs`, register in `generate_handler![]`
- **Add a new page:** Create in `src/pages/`, add route in `App.tsx`, add nav item in `Layout.tsx`
- **Add a new persisted field:** Add to `PersistedState` with `#[serde(default)]`, add CRUD methods to `AppState`
- **Add a new data type:** Define in `types.rs` with `Serialize, Deserialize`, add tests

## Git / PR Merge Policy

- Always use **squash and merge** when merging PRs. Never use merge commits or rebase merges. This keeps the git history clean with one commit per PR.
- You may `git merge origin/main` or `git merge origin/master` locally to sync branches, but PR merges must always be squash merges.
