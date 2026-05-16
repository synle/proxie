# proxie

A lightweight HTTPS proxy interceptor — like Charles Proxy, but free and fast. Built as a Tauri v2 desktop app with a React + MUI frontend and a Rust + Tokio backend.

## Quick Start

Prerequisites: Node.js 20+, npm 9+, Rust 1.75+ (via [rustup](https://rustup.rs/)). On Linux, install `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `libxdo-dev`, `libssl-dev`.

```bash
# Install dependencies
npm ci || npm install --no-fund --prefer-offline
```

```bash
# Run the Tauri desktop app (frontend hot-reload + Rust rebuild)
npx tauri dev
```

```bash
# Frontend only (Vite dev server at http://localhost:1420)
npm run dev
```

```bash
# Tests
npm test                       # React (Vitest)
cd src-tauri && cargo test     # Rust
```

```bash
# Production build
npx tauri build
```

## Proxy Setup (using the app)

Once the app is running, configure the proxy on the **Setup** page:

1. Set listen address + port (defaults to `127.0.0.1:8899`) and **Save Configuration**.
2. Click **Generate CA Certificate**, then run the platform-specific install command shown on the page. The CA must be trusted by the system or HTTPS interception fails.
3. Point your system / browser at the proxy. **Both HTTP and HTTPS proxies must be enabled** — HTTPS-only sites won't appear if you toggle only the HTTP proxy.
   - macOS: System Settings → Network → interface → Details → Proxies → enable **Web proxy (HTTP)** AND **Secure web proxy (HTTPS)**, both `127.0.0.1:8899`, click **OK**.
   - Windows: Settings → Network & Internet → Proxy → Manual proxy setup → enable **Use a proxy server**, set address `127.0.0.1` port `8899` (one setting covers both protocols), click **Save**.
   - Linux (GNOME): Settings → Network → Network Proxy → Manual → set HTTP and HTTPS to `127.0.0.1:8899`.
   - Shell: `export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899`.
   - Firefox has its own proxy settings on every platform.
4. Flip the proxy switch in the AppBar to **Running** and verify with:
   ```bash
   curl -x http://127.0.0.1:8899 https://example.com -v
   ```
   Traffic should appear on the **Connections** page.

See [README.md](README.md#proxy-setup) for the full setup + troubleshooting guide.
