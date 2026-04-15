# Development Guide

## Architecture Overview

Proxie is a Tauri v2 desktop app with two layers:

```
┌──────────────────────────────────────────────────┐
│  Frontend (React + MUI)                          │
│  src/                                            │
│  ├── App.tsx          Router + theme setup        │
│  ├── components/                                 │
│  │   └── Layout.tsx   AppBar, drawer nav, proxy  │
│  │                    start/stop controls         │
│  └── pages/                                      │
│      ├── ConnectionsPage.tsx  Live traffic view   │
│      ├── HostRulesPage.tsx    Host tracking CRUD  │
│      ├── InterceptorPage.tsx  Mock/reroute rules  │
│      └── SetupPage.tsx        Certs + proxy config│
├──────────────────────────────────────────────────┤
│  Tauri IPC (invoke / emit / listen)              │
├──────────────────────────────────────────────────┤
│  Backend (Rust + Tokio)                          │
│  src-tauri/src/                                  │
│  ├── lib.rs       17 Tauri commands + app setup  │
│  ├── proxy.rs     HTTP/HTTPS proxy engine        │
│  ├── cert.rs      CA certificate generation      │
│  ├── state.rs     AppState + persistence + rules │
│  └── types.rs     Shared data types (serde)      │
└──────────────────────────────────────────────────┘
```

## Running Locally

### Prerequisites

**All platforms:**
- Node.js 20+
- Rust 1.75+ (via [rustup](https://rustup.rs/))
- npm 9+

**macOS:** No additional dependencies (WebView is built-in).

**Windows:** WebView2 is pre-installed on Windows 10/11. If missing, Tauri auto-installs it.

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libxdo-dev \
  libssl-dev
```

### Development Commands

```bash
# Install dependencies
npm install

# Start Tauri dev mode (frontend hot-reload + Rust rebuild on save)
npx tauri dev

# Start frontend only (no Rust backend, useful for UI work)
npm run dev          # Vite dev server at http://localhost:1420

# Run frontend tests
npm test             # Single run
npm run test:watch   # Watch mode

# Run Rust tests
cd src-tauri && cargo test

# Type-check TypeScript without emitting
npx tsc --noEmit

# Build production binary
npx tauri build
```

## Project Structure

```
proxy-charles/
├── .github/workflows/
│   └── build.yml              # CI: 4-platform matrix build + tests
├── src/                       # React frontend
│   ├── main.tsx               # Entry: renders <App /> into #root
│   ├── App.tsx                # Router + MUI dark theme
│   ├── App.test.tsx           # Smoke tests
│   ├── vite-env.d.ts          # Vite type declarations
│   ├── components/
│   │   └── Layout.tsx         # Shell: AppBar + sidebar nav + proxy toggle
│   ├── pages/
│   │   ├── ConnectionsPage.tsx  # Live traffic table + detail drawer
│   │   ├── HostRulesPage.tsx    # Host tracking rule CRUD
│   │   ├── InterceptorPage.tsx  # Intercept rule CRUD (mock/reroute)
│   │   └── SetupPage.tsx        # Proxy config + SSL cert management
│   └── test/
│       └── setup.ts           # Vitest setup: Tauri API mocks
├── src-tauri/                 # Rust backend
│   ├── Cargo.toml             # Rust dependencies
│   ├── build.rs               # tauri_build::build()
│   ├── tauri.conf.json        # Tauri config (window, bundle, dev server)
│   ├── icons/                 # App icons (PNG, ICO, ICNS)
│   ├── tests/
│   │   └── smoke.rs           # Crate compilation smoke test
│   └── src/
│       ├── main.rs            # Entry: calls proxie_lib::run()
│       ├── lib.rs             # 17 Tauri commands + app initialization
│       ├── proxy.rs           # TCP proxy engine (HTTP + CONNECT tunnel)
│       ├── cert.rs            # CA cert generation (rcgen) + install instructions
│       ├── state.rs           # AppState, persistence, intercept rule matching
│       └── types.rs           # All shared types with serde derive
├── package.json               # npm scripts + dependencies
├── vite.config.ts             # Vite + Vitest config
├── tsconfig.json              # TypeScript config (strict)
└── .prettierrc                # Code formatting rules
```

## Code Paths

### Request Flow Through the Proxy

```
Client (browser/app)
  │
  │ HTTP request to 127.0.0.1:8899
  ▼
proxy.rs::start_proxy()
  │ TcpListener::bind(), spawns accept loop
  ▼
handle_connection()
  │ Read first 8KB, parse HTTP method + target
  │
  ├─ CONNECT (HTTPS tunnel)
  │  └─ handle_connect_tunnel()
  │     ├─ Check host against HostRules (tracked?)
  │     ├─ Connect to upstream host:port
  │     ├─ Send "200 Connection Established" to client
  │     ├─ Bidirectional byte relay (tokio::io::copy)
  │     ├─ Log ConnectionLog, emit proxy:connection event
  │     └─ (Note: encrypted bytes pass through; no MITM decryption yet)
  │
  └─ GET/POST/etc (plain HTTP)
     └─ handle_http_request()
        ├─ Extract host, path, method, headers, body
        ├─ Check intercept rules: state.find_intercept_rule(host, path, method)
        │
        ├─ [MATCH: Mock] → handle_intercepted_request()
        │  ├─ Build HTTP response from HarResponse (status, headers, body)
        │  ├─ Auto-add Content-Length if missing
        │  ├─ Send mock response to client (never contacts upstream)
        │  └─ Log with intercepted=true
        │
        ├─ [MATCH: Reroute] → handle_intercepted_request()
        │  ├─ Connect to target_url instead of original upstream
        │  ├─ Rewrite request Host header to reroute target
        │  ├─ Forward response from reroute target to client
        │  └─ Log with intercepted=true
        │
        └─ [NO MATCH] → Forward normally
           ├─ Connect to original upstream host:port
           ├─ Forward raw request bytes
           ├─ Read response, send to client
           └─ Log with intercepted=false
```

### Intercept Rule Matching

Rules are checked in order. First match wins.

```
find_intercept_rule(host, path, method):
  for each rule in intercept_rules:
    if !rule.enabled → skip
    if !host_matches(rule.match_host, host) → skip
    if !path_matches(rule.match_path, path) → skip
    if rule.match_method is set AND != method → skip
    return rule    ← first match wins
  return None      ← no interception, forward normally
```

**Host matching** (`proxy.rs::host_matches`):
- `"api.example.com"` → exact match
- `"*.example.com"` → matches `api.example.com`, `www.example.com`, `example.com`

**Path matching** (`state.rs::path_matches`):
- `"/api/users"` → exact match
- `"/api/*"` → matches `/api`, `/api/users`, `/api/users/1`
- `"/api/v*"` → prefix match: `/api/v1`, `/api/v2/users`
- `"*"` → matches everything

### Frontend → Backend Communication

All IPC goes through Tauri's `invoke()` (request/response) and `listen()` (events):

```
Frontend (TypeScript)              Backend (Rust)
──────────────────                 ──────────────
invoke('start_proxy')          →   proxy::start_proxy()
invoke('stop_proxy')           →   state::stop_proxy()
invoke('get_proxy_status')     →   state::get_proxy_status()
invoke('generate_cert')        →   cert::generate_ca()
invoke('get_cert_info')        →   cert::load_cert_info()
invoke('get_proxy_config')     →   state::get_proxy_config()
invoke('update_proxy_config')  →   state::update_proxy_config()
invoke('get_host_rules')       →   state::get_host_rules()
invoke('add_host_rule')        →   state::add_host_rule()
invoke('update_host_rule')     →   state::update_host_rule()
invoke('delete_host_rule')     →   state::delete_host_rule()
invoke('get_intercept_rules')  →   state::get_intercept_rules()
invoke('add_intercept_rule')   →   state::add_intercept_rule()
invoke('update_intercept_rule')→   state::update_intercept_rule()
invoke('delete_intercept_rule')→   state::delete_intercept_rule()
invoke('get_connections')      →   state::get_connections()
invoke('clear_connections')    →   state::clear_connections()

listen('proxy:connection')     ←   emitted on every proxied request
```

### Data Persistence

```
~/.config/proxie/
├── config.json        # ProxyConfig + HostRules + InterceptRules
└── certs/
    ├── proxie-ca.pem     # CA certificate (PEM)
    └── proxie-ca-key.pem # CA private key (PEM)
```

- Config is loaded on startup (`AppState::load_persisted_state()`)
- Config is saved after every CRUD operation (`AppState::save()`)
- Connections are in-memory only (max 10,000, oldest evicted first)
- `intercept_rules` field uses `#[serde(default)]` for backward compatibility with old configs

## Key Data Types

### InterceptRule + HAR Response

```rust
struct InterceptRule {
    id: String,
    name: String,
    enabled: bool,
    match_host: String,      // "*.example.com"
    match_path: String,      // "/api/*"
    match_method: Option<String>,  // "GET" or None (any)
    action: InterceptAction,
}

enum InterceptAction {
    Mock { response: HarResponse },     // Return hardcoded response
    Reroute { target_url: String },     // Forward to different target
}

// HAR 1.2-inspired format (http://www.softwareishard.com/blog/har-12-spec/#response)
struct HarResponse {
    status: u16,                   // 200, 404, 500, etc.
    status_text: String,           // "OK", "Not Found", etc.
    headers: Vec<HarHeader>,       // [{name, value}]
    content: HarContent {
        size: i64,
        mime_type: String,         // "application/json"
        text: Option<String>,      // Response body
    },
}
```

### ConnectionLog

```rust
struct ConnectionLog {
    id: String,
    method: String,                         // "GET", "POST", "CONNECT"
    url: String,                            // Full URL
    host: String,                           // Hostname
    path: String,                           // URL path
    status: Option<u16>,                    // HTTP status code
    duration_ms: Option<u64>,               // Request duration
    request_size: Option<u64>,              // Bytes sent
    response_size: Option<u64>,             // Bytes received
    timestamp: String,                      // ISO 8601
    request_headers: Vec<(String, String)>,
    response_headers: Vec<(String, String)>,
    request_body: Option<String>,
    response_body: Option<String>,
    content_type: Option<String>,
    intercepted: bool,                      // true if mock/reroute applied
}
```

## Testing

### Frontend Tests (Vitest)

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

- Setup in `src/test/setup.ts`: mocks `@tauri-apps/api/core`, `@tauri-apps/api/event`, `@tauri-apps/api/window`
- Environment: jsdom
- Tests: `src/App.test.tsx` — rendering, navigation, proxy status chip

### Rust Tests

```bash
cd src-tauri
cargo test            # All tests (unit + integration)
cargo test --lib      # Unit tests only (used on Windows CI)
```

Test locations:
- `types.rs` — Serialization roundtrips for all types, HAR response defaults
- `proxy.rs` — `host_matches()`, `extract_*()`, `build_mock_response()` (6 tests)
- `state.rs` — `path_matches()`, PersistedState serde, backward compat (7 tests)
- `cert.rs` — Cert directory paths, install instruction content (3 tests)
- `lib.rs` — Type serialization, config defaults (2 tests)
- `tests/smoke.rs` — Crate compilation check (1 test)

**Total: 34 Rust + 3 React = 37 tests**

## CI/CD

GitHub Actions workflow (`.github/workflows/build.yml`) runs on every push to `main` and every PR:

1. **Matrix build** on 4 targets:
   - macOS (Apple Silicon ARM64)
   - macOS (Intel x64)
   - Windows (x64)
   - Linux (x64)
2. **Steps per target:** checkout → Node 20 → Rust stable → platform deps → npm install → `npm test` → `cargo test` → `tauri build` → upload artifacts
3. **PR comments:** Automatically posts download links for each platform's build artifacts
4. **Concurrency:** Newer pushes cancel in-progress builds on the same branch
