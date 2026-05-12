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
