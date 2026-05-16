# proxie — Architecture

## High-Level Overview

proxie is a lightweight HTTPS proxy interceptor — a free, fast alternative to Charles Proxy. It runs as a Tauri v2 desktop app: a React + MUI + TypeScript frontend in a system webview, and a Rust + Tokio backend that implements the actual HTTP/HTTPS man-in-the-middle proxy.

**Runtime model:** single Tauri process. The Rust core owns proxy lifecycle, certificate generation/storage, persisted config, and the in-memory connection log. The webview UI talks to the Rust core exclusively through `#[tauri::command]` IPC handlers (see `src-tauri/src/lib.rs`). There is no separate backend service or network API.

**Main flow:**

1. On first run, the user generates a CA certificate (`generate_cert`) and trusts it on the host OS.
2. The user configures host rules (which hosts to intercept) and intercept rules (request/response modifications) via the React UI.
3. The user calls `start_proxy`, which binds a `tokio::net::TcpListener` on the configured `listen_addr:port` (default `127.0.0.1:8899`) and spawns an accept loop.
4. For each connection, the proxy parses the request, decides MITM vs. tunnel based on host rules, generates a per-host leaf cert signed by the CA when terminating TLS, applies intercept rules, forwards upstream, and emits a `ConnectionLog` event to the frontend via `tauri::Emitter`.
5. The Connections page subscribes to these events and renders the live request/response stream.

## Key Directories

- `src/` — React frontend (TypeScript). Vite-bundled, served at `http://localhost:1420` in dev, bundled into `dist/` for production (referenced by Tauri as `frontendDist: "../dist"`).
  - `src/pages/` — top-level routed views: `SetupPage`, `HostRulesPage`, `ConnectionsPage`, `InterceptorPage`.
  - `src/components/` — shared UI (currently `Layout.tsx`, the app shell).
  - `src/test/` — Vitest setup and helpers.
- `src-tauri/` — Rust Tauri backend (crate `proxie_lib`).
  - `src-tauri/src/` — Rust source: `lib.rs` (Tauri command handlers + `run()` entrypoint), `proxy.rs` (TCP accept loop, MITM, intercept application), `tls.rs` (MITM helpers: `load_ca`, `LeafCertCache`, `build_server_config`, `build_upstream_connector`), `cert.rs` (CA generation + platform install instructions), `state.rs` (`AppState`, persistence, mutexes, shutdown notify, lazy leaf-cert cache), `types.rs` (shared structs: `HostRule`, `InterceptRule`, `ConnectionLog`, `ProxyConfig`, `ProxyStatus`, `CertInfo`), `main.rs` (binary stub that calls `proxie_lib::run`).
  - `src-tauri/tests/` — Rust integration tests.
  - `src-tauri/icons/`, `src-tauri/gen/` — bundle icons and generated Tauri artifacts.
- `.github/workflows/` — CI/CD pipelines (build + release + artifact cleanup).

## Important Files

- `package.json` — frontend deps (React 19, MUI 9, react-router-dom 7, `@tauri-apps/api`), Vite + Vitest scripts, `tauri` CLI shim. Version is the npm-facing version; the user-facing app version lives in `tauri.conf.json`.
- `vite.config.ts` — Vite config (dev server port 1420 to match `devUrl`).
- `tsconfig.json` — TypeScript config for the React frontend.
- `index.html` — Vite entry; mounts `src/main.tsx`.
- `src/main.tsx` — React root; renders `<App />` inside `<React.StrictMode>`.
- `src/App.tsx` — `BrowserRouter` + MUI dark theme + route table.
- `src-tauri/Cargo.toml` — Rust deps: `tauri 2`, `tokio` (full), `hyper` + `hyper-util` + `http-body-util` (HTTP plumbing), `rustls` + `tokio-rustls` + `rustls-pemfile` (TLS), `rcgen` (cert generation), `serde`/`serde_json` (IPC + persistence), `dirs` (config dir), `uuid`, `chrono`, `log` + `env_logger`. Release profile is size-optimized (`opt-level = "s"`, `lto`, `strip`, `panic = "abort"`).
- `src-tauri/tauri.conf.json` — Tauri v2 app config. `productName: "Proxie"`, `identifier: com.synle.proxie`, window 1200x800, bundles for all targets, icons under `icons/`. **`version` here is the authoritative app version consumed by release workflows.**
- `src-tauri/build.rs` — `tauri-build` invocation.
- `src-tauri/src/lib.rs` — registers all Tauri commands and constructs `AppState` in `setup()`. Single source of truth for the IPC surface.
- `src-tauri/src/proxy.rs` — proxy accept loop and per-connection handler (TLS termination, host-rule matching, intercept-rule application, upstream forwarding, event emission).
- `src-tauri/src/state.rs` — `AppState` with `Mutex`-guarded `PersistedState` (proxy config, host rules, intercept rules), in-memory `connections` log, and a `tokio::sync::Notify` shutdown signal. Persistence is JSON written under the OS config dir resolved via `dirs`.
- `src-tauri/src/cert.rs` — root CA generation and per-host leaf cert minting for on-the-fly TLS termination.
- `DEV.md` — developer quickstart (prereqs, dev/build/test commands).

## Build & Release Flow

**Local build:**

- `npm run dev` — Vite dev server only (no Tauri shell).
- `npx tauri dev` — full desktop app with Vite hot-reload and Rust rebuild.
- `npx tauri build` — production build: runs `npm run build` (`tsc && vite build`) per `beforeBuildCommand`, then bundles the Rust binary + webview assets into platform installers under `src-tauri/target/release/bundle/`.
- `npm test` — Vitest (React). `cd src-tauri && cargo test` — Rust tests.

**CI (`.github/workflows/`):**

- `build.yml` — runs on every push to `main` and on PRs. Matrix builds across macOS (aarch64, x86_64), Windows (x86_64), and Linux (x86_64 on `ubuntu-22.04`). Used as the PR gate.
- `release-official.yml` — official releases. Triggered by pushing a `v*` tag or via `workflow_dispatch` with an explicit `tag` input. Builds the same matrix and publishes a GitHub Release. The release tag is taken from the `tag` input (or the pushed tag); it is **not** derived from `github.ref_name`, so dispatching with `--ref main` is safe as long as `--field tag=v<version>` is supplied (per repo policy, the version comes from `tauri.conf.json`).
- `release-beta.yml` — beta channel releases (separate channel, opt-in via skill invocation).
- `cleanup-artifacts.yml`, `cleanup-pr-artifacts.yml`, `cleanup-releases.yml` — housekeeping jobs that prune old workflow artifacts and stale releases.

**Version sources:** `src-tauri/tauri.conf.json` `version` is the user-facing app version and the one release workflows pin tags against. `src-tauri/Cargo.toml` and `package.json` carry independent crate/npm versions and may drift behind the app version.
