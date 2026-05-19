# Proxie User Guide

Proxie is a lightweight HTTPS proxy interceptor desktop app — think Charles Proxy, but free, native, and focused on API debugging. It runs a local HTTP/HTTPS proxy you can point your system or browser at, captures live traffic, lets you mock or reroute requests, and blocks ad/tracker hosts at the proxy layer.

This guide walks through every feature in the app, one tab at a time.

## Guides

| Page | What it does |
|------|--------------|
| [Connections](connections.md) | Live traffic view — inspect, filter, format, save, and replay requests |
| [Host Rules](host-rules.md) | Choose which hosts are tracked through the proxy |
| [Interceptor](interceptor.md) | Mock responses or reroute requests to a different target |
| [Block Rules](block-rules.md) | Pi-hole-style host/path blocking at the proxy layer |
| [Setup](setup.md) | Proxy address/port, CA certificate generation, and system trust install |

## First-run checklist

1. Open the [Setup](setup.md) page and **Generate CA Certificate**.
2. Install the CA in your OS trust store using the platform-specific snippet on the Setup page.
3. Configure your system or browser proxy to point at `127.0.0.1:39871` (default).
4. Add a [Host Rule](host-rules.md) like `*.example.com` for the domains you want to track.
5. Click the proxy toggle in the top bar to start listening. Traffic shows up live on the [Connections](connections.md) tab.

## Where to ask questions

- Bug reports / feature requests: open an issue on the GitHub repo.
- Tech-stack and architecture details: see `ARCHITECTURE.md` and `DEV.md` at the repo root.
