# Proxie

A lightweight HTTPS proxy interceptor — like Charles Proxy, but free and fast.

Built with [Tauri v2](https://v2.tauri.app/) + React 19 + MUI 9 + Rust.

## Why Proxie?

- **Charles Proxy** costs $50 and runs on Java (slow)
- **Wireshark** is over-engineered for API debugging
- **HTTP Toolkit** free tier is limited; Electron is heavy
- **Proxie** is free, native (Rust + system WebView), and focused on API interception

## Features

- **HTTPS Interception** — Terminates TLS using per-host leaf certs signed by a locally-generated CA, then decrypts request/response into the live Connections view (Charles-style MITM). One-command install for macOS, Windows, and Linux; falls back to a transparent tunnel if the CA isn't trusted yet.
- **Host Tracking** — Configure which hosts to monitor with wildcard support (`*.example.com`) and ignore paths (`/health`, `/metrics`)
- **Live Connections** — Real-time traffic table with duration bars, status color coding, filtering, and request/response detail drawer
- **Request Interceptor** — Mock responses (HAR format) or reroute requests to different targets, with access to request body/headers for dynamic behavior. As of v0.3.0 intercept rules apply uniformly to HTTP and HTTPS — the MITM path decrypts the request before rule matching, so the same host/path/method patterns match either scheme. Intercepted rows are flagged with a purple `INTERCEPTED` badge in the Connections table.
- **Host Blocking (v0.4.0)** — Pi-hole-style ad/tracker blocking at the proxy layer. Define block rules with wildcard host patterns (`*.doubleclick.net`) and optional path patterns (`/ads/*`). Matching HTTPS CONNECTs are refused with `403 Forbidden` **before any upstream socket is opened**; matching HTTP/decrypted-HTTPS requests get a `204 No Content` (the HTTP-layer NXDOMAIN analogue). Blocked rows show a red `BLOCKED` chip. A "Seed Defaults" button on the Block Rules page adds a small curated list (Google Ads, DoubleClick, Hotjar, etc.) — all disabled by default, opt-in only.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) 1.75+
- Platform dependencies (see [DEV.md](DEV.md) for details)

### Run Locally

```bash
# Install frontend dependencies
npm install

# Start the app in development mode (hot-reload for frontend + Rust rebuild)
npx tauri dev

# Or run just the frontend dev server (no Tauri/Rust)
npm run dev
```

### Run Tests

```bash
# Frontend tests (Vitest + React Testing Library)
npm test

# Rust tests
cd src-tauri && cargo test

# TypeScript type check
npx tsc --noEmit
```

### Build for Production

```bash
npx tauri build
```

Outputs platform-specific installers in `src-tauri/target/release/bundle/`:
- macOS: `.dmg`, `.app`
- Windows: `.exe` (NSIS), `.msi`
- Linux: `.deb`, `.AppImage`, `.rpm`

## Proxy Setup

1. Launch Proxie and go to the **Setup** page.
2. Click **Generate CA Certificate**.
3. Install the CA cert in your system trust store (otherwise HTTPS sites will show cert errors):

   **macOS:**
   ```bash
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "<cert-path>"
   ```

   **Windows (Admin):**
   ```bash
   certutil -addstore -f "ROOT" "<cert-path>"
   ```

   **Linux (Ubuntu):**
   ```bash
   sudo cp "<cert-path>" /usr/local/share/ca-certificates/proxie-ca.crt
   sudo update-ca-certificates
   ```

4. Point your system or browser at the proxy. **You must enable BOTH HTTP and HTTPS** — turning on only "Web proxy (HTTP)" will silently miss every HTTPS site (which is nearly all modern traffic).

   **macOS** (System Settings → Network → your interface → Details → Proxies):
   - Enable **Web proxy (HTTP)** → `127.0.0.1` port `8899`
   - Enable **Secure web proxy (HTTPS)** → `127.0.0.1` port `8899`
   - Click **OK** to apply

   **Windows 10/11** (Settings → Network & Internet → Proxy → Manual proxy setup):
   - Toggle **Use a proxy server** ON
   - Address `127.0.0.1`, Port `8899` (this single setting covers both HTTP and HTTPS)
   - Click **Save**
   - Per-app override (PowerShell): `$env:HTTP_PROXY="http://127.0.0.1:8899"; $env:HTTPS_PROXY="http://127.0.0.1:8899"`

   **Linux:**
   - GNOME: Settings → Network → Network Proxy → Manual → set HTTP and HTTPS proxy to `127.0.0.1:8899`
   - Shell-only: `export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899`

   **Shell (any OS):**
   ```bash
   export HTTP_PROXY=http://127.0.0.1:8899
   export HTTPS_PROXY=http://127.0.0.1:8899
   ```

   **Firefox** uses its own proxy settings — set them in Settings → Network Settings on every platform.

   **Chrome / Edge / Brave** on Windows and macOS use the system proxy by default — restart the browser after changing system settings so it picks up the new config.

5. Add host rules on the **Host Rules** page to track specific domains.
6. Click the play button to start the proxy.
7. Watch live traffic on the **Connections** page.

### Verify

```bash
curl -x http://127.0.0.1:8899 https://example.com -v
```
The request should appear in the **Connections** page. If `curl` fails with a TLS error, the CA cert isn't trusted yet — re-run the trust command in step 3.

### Troubleshooting

- **"Running" but no connections:**
  - macOS: Secure web proxy (HTTPS) is probably off, or you forgot to click **OK** in the proxy dialog.
  - Windows: the proxy toggle didn't save — re-open Settings and confirm **Use a proxy server** is still on.
  - All platforms: browsers cache connections; visit a fresh tab or restart the browser after changing settings.
- **TLS / cert errors in browser:** CA cert isn't trusted — re-run the platform install command, then fully quit and relaunch the browser. On Windows, run the `certutil` command in an **elevated** PowerShell or Command Prompt.
- **Port 8899 in use:** Change the port on the **Setup** page and update the system proxy to match.
- **Chrome on Windows ignores the CA:** Chrome reads the Windows ROOT store via `certutil -addstore "ROOT"`, but if you installed into the Current User store instead it won't be trusted system-wide — re-run with the `-addstore` form (not `-user`).
- **`curl` works but the browser doesn't:** the browser is bypassing the system proxy (Firefox does this by default; Chrome may have `--proxy-server` flag overrides). Check the browser's own network settings.

## Pages

| Page | Description |
|------|-------------|
| **Connections** | Live traffic table with duration visualization, filter, and detail drawer |
| **Host Rules** | CRUD for host tracking rules with wildcard and ignore-path support |
| **Interceptor** | Mock responses (HAR format) or reroute requests to different targets |
| **Block Rules** | Pi-hole style blocker — short-circuit ad/tracker hosts at the proxy (204/403 + no upstream socket) |
| **Setup** | Proxy config (port, address) and SSL certificate management |

## Block Rules

Block rules turn Proxie into a Charles + Pi-hole hybrid. Unlike DNS-level blockers, block rules see the actual HTTP host + path (after TLS termination for HTTPS), so you can scope blocks more precisely than NXDOMAIN allows.

| Pattern | Effect |
|---------|--------|
| `*.doubleclick.net` (host only) | Blocks every request to any subdomain of doubleclick.net |
| `tracker.example.com` + `/pixel/*` | Blocks only `/pixel/*` on that one host; other paths pass through |
| `cdn.example.com` + `/ads/*` | Lets non-ad assets through while still blocking ads on the same CDN |

**Order of operations in the proxy:** `block → intercept → forward`. A block rule fires before an intercept rule on the same host/path, and before any upstream socket is opened on the CONNECT path.

**Response codes:** HTTP and decrypted HTTPS get **204 No Content** (empty body — the HTTP analogue of Pi-hole's NXDOMAIN, so clients treat the resource as "nothing here" rather than as a network error). Raw CONNECT short-circuits get **403 Forbidden** (the tunnel was actively refused; no upstream socket was opened).

Click **Seed Defaults** on the Block Rules page to add a small curated list of well-known ad/tracker hosts as **disabled** rules — review and toggle individually. Proxie never enables block rules by default and does not ship a third-party block list (EasyList etc. — too large and licensing-sensitive).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri v2 |
| Frontend | React 19, TypeScript, MUI 9, Vite 6 |
| Backend | Rust, Tokio, Hyper |
| TLS | rcgen (cert generation), rustls, tokio-rustls |
| CI/CD | GitHub Actions (macOS, Windows, Linux) |

## License

MIT
