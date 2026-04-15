# Proxie

A lightweight HTTPS proxy interceptor — like Charles Proxy, but free and fast.

Built with [Tauri v2](https://v2.tauri.app/) + React + MUI.

## Features

- **HTTPS Interception** — Self-signed CA certificate generation with one-click install instructions for macOS, Windows, and Linux
- **Host Tracking** — Configure which hosts to monitor with wildcard support (`*.example.com`)
- **Live Connections** — Real-time traffic view with duration visualization, filtering, and request/response detail inspection
- **Request Interceptor** — Define custom routing rules: reroute requests or return hardcoded responses with HAR-format support

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npx tauri dev

# Run tests
npm test                          # Frontend tests
cd src-tauri && cargo test        # Rust tests

# Build for production
npx tauri build
```

## Architecture

```
src/                  # React frontend (TypeScript + MUI)
├── pages/
│   ├── SetupPage       # Proxy config + SSL certificate management
│   ├── HostRulesPage   # Host tracking rules (add/edit/delete)
│   └── ConnectionsPage # Live traffic view + detail drawer
src-tauri/            # Rust backend
├── src/
│   ├── lib.rs          # Tauri commands + app setup
│   ├── proxy.rs        # HTTP/HTTPS proxy engine
│   ├── cert.rs         # CA certificate generation (rcgen)
│   ├── state.rs        # App state management + persistence
│   └── types.rs        # Shared data types
```

## Proxy Setup

1. Go to **Setup** page and generate a CA certificate
2. Follow the platform-specific instructions to install it in your system trust store
3. Configure your system/browser to use HTTP proxy at `127.0.0.1:8899`
4. Add host rules on the **Host Rules** page
5. Start the proxy and watch traffic on the **Connections** page
