# Proxie

A lightweight HTTPS proxy interceptor — like Charles Proxy, but free and fast.

Built with [Tauri v2](https://v2.tauri.app/) + React 19 + MUI 9 + Rust.

## Why Proxie?

- **Charles Proxy** costs $50 and runs on Java (slow)
- **Wireshark** is over-engineered for API debugging
- **HTTP Toolkit** free tier is limited; Electron is heavy
- **Proxie** is free, native (Rust + system WebView), and focused on API interception

## Features

- **HTTPS Interception** — Self-signed CA certificate generation with one-command install for macOS, Windows, and Linux
- **Host Tracking** — Configure which hosts to monitor with wildcard support (`*.example.com`) and ignore paths (`/health`, `/metrics`)
- **Live Connections** — Real-time traffic table with duration bars, status color coding, filtering, and request/response detail drawer
- **Request Interceptor** — Mock responses (HAR format) or reroute requests to different targets, with access to request body/headers for dynamic behavior

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

1. Launch Proxie and go to the **Setup** page
2. Click **Generate CA Certificate**
3. Follow the platform-specific instructions to install it in your system trust store:

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

4. Configure your system or browser to use HTTP proxy at `127.0.0.1:8899`
5. Add host rules on the **Host Rules** page to track specific domains
6. Click the play button to start the proxy
7. Watch live traffic on the **Connections** page

## Pages

| Page | Description |
|------|-------------|
| **Connections** | Live traffic table with duration visualization, filter, and detail drawer |
| **Host Rules** | CRUD for host tracking rules with wildcard and ignore-path support |
| **Interceptor** | Mock responses (HAR format) or reroute requests to different targets |
| **Setup** | Proxy config (port, address) and SSL certificate management |

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
