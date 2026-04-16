# Proxie — Claude Code Context

## What is this project?

Proxie is a lightweight HTTPS proxy interceptor desktop app (like Charles Proxy, but free and fast). Built with Tauri v2 (Rust) + React 18 + MUI 7.

## Tech stack

- **Frontend:** React 18, TypeScript, MUI 7, Vite 6, React Router 7
- **Backend:** Rust, Tauri v2, Tokio, Hyper, rcgen (cert generation)
- **Tests:** Vitest + React Testing Library (frontend), cargo test (Rust)
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

## Project layout

```
src/                           # React frontend
  App.tsx                      # Routes + MUI theme
  components/Layout.tsx        # Shell: AppBar, nav drawer, proxy toggle
  pages/ConnectionsPage.tsx    # Live traffic view + detail drawer
  pages/HostRulesPage.tsx      # Host tracking CRUD
  pages/InterceptorPage.tsx    # Mock/reroute rule CRUD
  pages/SetupPage.tsx          # Proxy config + SSL cert management
  test/setup.ts                # Vitest setup with Tauri mocks

src-tauri/src/                 # Rust backend
  lib.rs                       # 17 Tauri commands + app setup
  proxy.rs                     # HTTP/HTTPS proxy engine
  cert.rs                      # CA cert generation + install instructions
  state.rs                     # AppState, persistence, rule matching
  types.rs                     # All data types (CertInfo, HostRule, InterceptRule, ConnectionLog, etc.)
```

## Key conventions

- All frontend-backend IPC uses Tauri `invoke()` commands
- Tauri commands are defined in `lib.rs`, delegating to `state.rs`/`proxy.rs`/`cert.rs`
- State is persisted to `~/.config/proxie/config.json` on every CRUD operation
- Connections are in-memory only (max 10,000)
- Intercept rules use HAR 1.2-inspired format for mock responses
- `host_matches()` supports `*.example.com` wildcards
- `path_matches()` supports `/api/*` and `/api/v*` wildcards
- New fields on `PersistedState` must use `#[serde(default)]` for backward compatibility

## Testing

- Frontend tests mock all Tauri APIs in `src/test/setup.ts`
- Rust tests are inline `#[cfg(test)]` modules in each file
- CI runs both test suites on all 4 platforms before building
- Always run `npm test` and `cargo test` before committing

## Build pipeline

- CI config: `.github/workflows/build.yml`
- Follows the same pattern as the `display-dj` project
- 4-platform matrix: macOS ARM, macOS Intel, Windows, Linux
- PR builds post artifact download links as comments

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
