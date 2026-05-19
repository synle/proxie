# Setup

The Setup tab configures the proxy listener and the CA certificate Proxie uses for HTTPS interception.

## Proxy configuration

The **Proxy Configuration** card has two fields:

- **Listen Address** — default `127.0.0.1`. Keep this on loopback unless you want other machines on your LAN to use this proxy (in which case use `0.0.0.0` and be aware of the security implications — anyone on the LAN can route through your interceptor).
- **Port** — default `39871`. Pick any unused TCP port. Both HTTP and HTTPS share the same port — that's how the OS proxy settings expect it.

Click **Save Configuration** to persist. The change takes effect the next time you toggle the proxy on.

Click the play/stop toggle in the top app bar to actually start or stop the listener.

## Pointing your system at the proxy

You must enable **both HTTP and HTTPS proxy** on your client. Turning on only "Web proxy (HTTP)" silently misses every HTTPS site, which is most modern traffic.

### macOS

System Settings → Network → your interface → Details → Proxies:

- Enable **Web proxy (HTTP)** → `127.0.0.1` port `39871`
- Enable **Secure web proxy (HTTPS)** → `127.0.0.1` port `39871`
- Click **OK** to apply.

### Windows 10 / 11

Settings → Network & Internet → Proxy → Manual proxy setup:

- Toggle **Use a proxy server** ON.
- Address `127.0.0.1`, Port `39871` (one setting covers both schemes).
- Click **Save**.

Per-app override in PowerShell:

```powershell
$env:HTTP_PROXY="http://127.0.0.1:39871"
$env:HTTPS_PROXY="http://127.0.0.1:39871"
```

### Linux

- GNOME: Settings → Network → Network Proxy → Manual → set HTTP and HTTPS proxy to `127.0.0.1:39871`.
- Shell-only:

  ```bash
  export HTTP_PROXY=http://127.0.0.1:39871
  export HTTPS_PROXY=http://127.0.0.1:39871
  ```

### Browsers

- **Chrome / Edge / Brave** on macOS and Windows follow the system proxy. Restart the browser after changing system settings.
- **Firefox** has its own proxy settings — Settings → Network Settings on every platform.

### Verify

```bash
curl -x http://127.0.0.1:39871 https://example.com -v
```

The request should appear on the [Connections](connections.md) tab. If `curl` fails with a TLS error, the CA cert isn't trusted yet — install it (next section).

## SSL certificate

Proxie generates a single locally-stored CA. Every HTTPS site is intercepted with a per-host leaf certificate signed by that CA. The client only needs to trust **the CA**, not the per-site leaves.

### Generate

If no certificate exists, the **SSL Certificate** card shows a **Generate CA Certificate** button. Click it. The card then shows:

- **Created** / **Expires** dates.
- **Certificate** — full filesystem path to the `.crt` file (under your platform's config dir).
- **Fingerprint** — SHA-256 fingerprint of the cert. Use this to verify a trust-store install (`security find-certificate -c ProxieCA -p ...`, `certutil -store ROOT ProxieCA`, etc.).

### Regenerate

The **Regenerate Certificate** button replaces the existing CA. Everything signed by the old CA stops being trusted, so every client that had the old CA installed needs to re-trust the new one. Use this when you suspect the CA key has leaked or when a fresh expiration date is needed.

### Install in the system trust store

The **Install Certificate** card has a tabbed view (macOS / Windows / Linux (Ubuntu)) with a copy-paste-ready snippet for each. The snippets pre-fill the certificate path on disk.

Typical commands:

**macOS:**

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "<cert-path>"
```

**Windows (elevated PowerShell or Admin cmd):**

```bash
certutil -addstore -f "ROOT" "<cert-path>"
```

**Linux (Ubuntu / Debian):**

```bash
sudo cp "<cert-path>" /usr/local/share/ca-certificates/proxie-ca.crt
sudo update-ca-certificates
```

After installing, **fully quit and relaunch your browser** so it picks up the new trust anchor. Firefox uses its own NSS store — install via Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.

## Cert-pinning apps

Some clients pin their server's certificate and reject Proxie's CA even when installed in the system trust store. Known pinners:

- Apple `gateway.icloud.com` (iCloud daemon)
- Apple Push Notification Service (APNs)
- App Store
- Most banking apps

Symptom: the TLS handshake closes with EOF before any data flows. Proxie surfaces this on the [Connections](connections.md) tab as `"MITM error: TLS handshake with client failed (likely certificate pinning — common for iCloud, App Store, banking apps): …"`. This is **expected behaviour** and cannot be fixed from the proxy side — pinning is the entire point of pinning.

For a pinned app, your options are:

1. Use a debug/dev build of the app that disables pinning (some vendors ship one).
2. Patch the app binary to remove the pin (legally fraught and out of scope here).
3. Stop trying to MITM that traffic and exclude the host from your proxy/host rules.

## Troubleshooting

- **"Running" but no connections** — most often the OS proxy isn't actually saved (Windows toggle didn't stick, or macOS HTTPS toggle is off). Re-open the OS proxy panel and confirm both schemes are enabled.
- **Cert errors in browser** — CA not trusted yet, or browser hasn't been restarted. Run the platform install command again and fully quit the browser.
- **Port 39871 in use** — change the port in Proxy Configuration, save, then update the OS proxy to the new port.
- **Chrome on Windows ignores the CA** — Chrome reads the Windows ROOT store. Install with `certutil -addstore "ROOT"` (not the user-store form).
- **`curl` works but the browser doesn't** — browser is bypassing the system proxy. Check the browser's own network settings; Firefox has separate ones.
