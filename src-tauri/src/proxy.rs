use crate::state::AppState;
use crate::tls;
use crate::types::{ConnectionLog, InterceptAction, ProxyStatus};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Start the HTTP/HTTPS proxy server.
pub async fn start_proxy(
    app_handle: AppHandle,
    state: Arc<AppState>,
) -> Result<ProxyStatus, Box<dyn std::error::Error>> {
    let config = state.get_proxy_config().await?;
    let addr = format!("{}:{}", config.listen_addr, config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    state
        .set_proxy_running(config.port, &config.listen_addr)
        .await;

    let shutdown = state.shutdown_notify();

    log::info!("Proxy listening on {}", addr);

    let status = state.get_proxy_status().await?;

    // Spawn the accept loop
    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            let state_inner = Arc::clone(&state_clone);
                            let app = app_handle.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, peer_addr, state_inner, app).await {
                                    log::error!("Connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            log::error!("Accept error: {}", e);
                        }
                    }
                }
                _ = shutdown.notified() => {
                    log::info!("Proxy shutting down");
                    break;
                }
            }
        }
    });

    Ok(status)
}

async fn handle_connection(
    mut client_stream: tokio::net::TcpStream,
    peer_addr: std::net::SocketAddr,
    state: Arc<AppState>,
    app_handle: AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = vec![0u8; 8192];
    let n = client_stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }

    let request_data = &buf[..n];
    let request_str = String::from_utf8_lossy(request_data);

    // Parse the first line of the HTTP request
    let first_line = request_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    if parts.len() < 3 {
        return Ok(());
    }

    let method = parts[0].to_string();
    let target = parts[1].to_string();

    let start = std::time::Instant::now();

    if method == "CONNECT" {
        // HTTPS tunnel: MITM if CA available, else blind relay.
        handle_connect_tunnel(client_stream, &target, &state, &app_handle, start).await?;
    } else {
        // Plain HTTP: forward the request (or intercept)
        handle_http_request(
            &mut client_stream,
            &method,
            &target,
            request_data,
            &state,
            &app_handle,
            start,
        )
        .await?;
    }

    let _ = peer_addr; // used for logging in future

    Ok(())
}

/// Handle a CONNECT tunnel from the client.
///
/// When the Proxie CA is available on disk we terminate TLS, read the
/// decrypted HTTP request, optionally apply intercept rules, and forward to
/// the real upstream over a fresh TLS connection — logging the full request
/// and response into the [`ConnectionLog`] stream.
///
/// When the CA is missing we fall back to a transparent byte-relay so the
/// proxy keeps working for users who haven't set up cert trust yet.
///
/// # Arguments
/// * `client_stream` - Owned TCP stream from the client. Owned (not `&mut`)
///   so we can hand it to a [`tokio_rustls::TlsAcceptor`].
/// * `target` - `host:port` string from the CONNECT request line.
/// * `state` - Shared app state (host rules, intercept rules, leaf cache).
/// * `app_handle` - Tauri handle used to emit `proxy:connection` events.
/// * `start` - Instant captured at the start of the request for timing.
///
/// # Errors
/// Returns errors only for unrecoverable I/O failures — TLS handshake
/// failures are caught and logged as warning entries in the connection
/// stream, never bubbled up.
async fn handle_connect_tunnel(
    client_stream: tokio::net::TcpStream,
    target: &str,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let host_port: Vec<&str> = target.split(':').collect();
    let host = host_port.first().copied().unwrap_or("unknown").to_string();
    let port: u16 = host_port.get(1).and_then(|p| p.parse().ok()).unwrap_or(443);

    // Block-rule fast path — runs BEFORE we open an upstream socket or do
    // any TLS handshake. We can't see the inner path at CONNECT time so we
    // synthesize "/", which matches block rules with `path_pattern = None`
    // (host-only blocks). Rules with a non-None path_pattern fall through
    // here and are re-checked after MITM decrypts the inner request.
    if let Some(rule) = state.find_block_rule(&host, "/").await {
        return serve_block_connect(
            client_stream,
            &host,
            target,
            &rule,
            state,
            app_handle,
            start,
        )
        .await;
    }

    // Check if this host is being tracked (purely informational for logs).
    let rules = state.get_host_rules().await.unwrap_or_default();
    let is_tracked = rules
        .iter()
        .any(|r| r.enabled && host_matches(&r.host, &host));

    // Try MITM if the CA is installed; otherwise fall back to blind relay.
    let leaf_cache = state.get_or_init_leaf_cache().await;
    match leaf_cache {
        Some(cache) => {
            mitm_connect(
                client_stream,
                &host,
                port,
                target,
                cache,
                state,
                app_handle,
                start,
                is_tracked,
            )
            .await
        }
        None => {
            blind_tunnel(
                client_stream,
                &host,
                port,
                target,
                state,
                app_handle,
                start,
                is_tracked,
            )
            .await
        }
    }
}

/// Blind CONNECT relay used when the Proxie CA isn't installed.
///
/// Logs a single CONNECT row noting MITM was skipped, then bridges bytes
/// between client and upstream until either side hangs up.
#[allow(clippy::too_many_arguments)]
async fn blind_tunnel(
    mut client_stream: tokio::net::TcpStream,
    host: &str,
    port: u16,
    target: &str,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
    is_tracked: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let upstream_addr = format!("{}:{}", host, port);
    let upstream = tokio::net::TcpStream::connect(&upstream_addr).await?;

    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: "CONNECT".to_string(),
        url: format!("https://{}", target),
        host: host.to_string(),
        path: "/".to_string(),
        status: Some(200),
        duration_ms: Some(duration_ms),
        request_size: None,
        response_size: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers: vec![],
        response_headers: vec![],
        request_body: None,
        response_body: Some(
            "MITM skipped — Proxie CA not installed. Generate and trust the CA in Setup to decrypt this connection."
                .to_string(),
        ),
        content_type: None,
        intercepted: false,
        blocked: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);

    if is_tracked {
        log::info!("Tracked CONNECT (blind) to {}", target);
    }

    let (mut client_read, mut client_write) =
        tokio::io::split(tokio::io::BufReader::new(client_stream));
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);

    let c2u = tokio::io::copy(&mut client_read, &mut upstream_write);
    let u2c = tokio::io::copy(&mut upstream_read, &mut client_write);

    let _ = tokio::try_join!(c2u, u2c);

    Ok(())
}

/// Full HTTPS MITM path — terminate client TLS, parse the decrypted request,
/// optionally apply intercept rules, forward to upstream over a fresh TLS
/// connection, log everything.
#[allow(clippy::too_many_arguments)]
async fn mitm_connect(
    mut client_stream: tokio::net::TcpStream,
    host: &str,
    port: u16,
    target: &str,
    leaf_cache: Arc<crate::tls::LeafCertCache>,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
    is_tracked: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Tell the client the tunnel is ready BEFORE we start the TLS handshake.
    if let Err(e) = client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
    {
        log::warn!("CONNECT 200 write failed for {}: {}", target, e);
        return Ok(());
    }

    // Mint / fetch the per-host ServerConfig and accept the TLS handshake.
    let server_config = match leaf_cache.get_or_create(host).await {
        Ok(cfg) => cfg,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("leaf cert generation failed: {}", e),
            )
            .await;
            return Ok(());
        }
    };
    let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
    let mut tls_client = match acceptor.accept(client_stream).await {
        Ok(s) => s,
        Err(e) => {
            // Two common causes:
            // 1) Client doesn't trust the Proxie CA (system trust store
            //    install missing or stale) → typically surfaces as
            //    "alert bad certificate" or "alert unknown ca".
            // 2) Client uses *certificate pinning* and intentionally
            //    rejects any cert outside its hardcoded pin set →
            //    typically surfaces as "tls handshake eof": the client
            //    aborts the handshake without sending an alert. Apple's
            //    iCloud daemon (gateway.icloud.com), APNS, the App
            //    Store, and most banking apps all pin and are
            //    fundamentally un-MITMable from a proxy.
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!(
                    "TLS handshake with client failed ({}): {}",
                    classify_tls_failure(&e),
                    e
                ),
            )
            .await;
            return Ok(());
        }
    };

    if is_tracked {
        log::info!("Tracked MITM CONNECT to {}", target);
    }

    // Read the first HTTP request from the decrypted stream.
    let mut buf = vec![0u8; 16 * 1024];
    let n = match tls_client.read(&mut buf).await {
        Ok(0) => return Ok(()),
        Ok(n) => n,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("read decrypted request failed: {}", e),
            )
            .await;
            return Ok(());
        }
    };
    let request_data = &buf[..n];
    let request_str = String::from_utf8_lossy(request_data);

    let first_line = request_str.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let request_headers: Vec<(String, String)> = request_str
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .filter_map(|line| {
            let mut p = line.splitn(2, ": ");
            Some((p.next()?.to_string(), p.next()?.to_string()))
        })
        .collect();

    let request_body = request_str
        .find("\r\n\r\n")
        .map(|idx| request_str[idx + 4..].to_string())
        .filter(|s| !s.is_empty());

    let url = format!("https://{}{}", host, path);

    // Re-check block rules with the decrypted path — this catches rules
    // with a `path_pattern` that the CONNECT-time check couldn't evaluate
    // (we only had "/" then). Runs BEFORE the intercept-rule check.
    if let Some(rule) = state.find_block_rule(host, &path).await {
        return serve_block_https(
            &mut tls_client,
            &method,
            &url,
            host,
            &path,
            &request_headers,
            &request_body,
            &rule,
            state,
            app_handle,
            start,
        )
        .await;
    }

    // Apply intercept rules on the decrypted request.
    if let Some(rule) = state.find_intercept_rule(host, &path, &method).await {
        return serve_intercept_over_tls(
            &mut tls_client,
            &method,
            &url,
            host,
            &path,
            &request_headers,
            &request_body,
            &rule.action,
            state,
            app_handle,
            start,
        )
        .await;
    }

    // No rule — forward to real upstream over TLS.
    let connector = match tls::build_upstream_connector() {
        Ok(c) => c,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("build upstream connector failed: {}", e),
            )
            .await;
            return Ok(());
        }
    };
    let upstream_addr = format!("{}:{}", host, port);
    let upstream_tcp = match tokio::net::TcpStream::connect(&upstream_addr).await {
        Ok(s) => s,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("upstream TCP connect failed: {}", e),
            )
            .await;
            return Ok(());
        }
    };
    let server_name = match rustls::pki_types::ServerName::try_from(host.to_string()) {
        Ok(n) => n,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("invalid upstream server name {}: {}", host, e),
            )
            .await;
            return Ok(());
        }
    };
    let mut upstream_tls = match connector.connect(server_name, upstream_tcp).await {
        Ok(s) => s,
        Err(e) => {
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!("upstream TLS handshake failed: {}", e),
            )
            .await;
            return Ok(());
        }
    };

    // Rewrite the request line so the path is absolute-form (already is for
    // intercepted requests), and force Connection: close so the upstream
    // doesn't keep the response open waiting for follow-ups.
    let rewritten = rewrite_for_upstream(request_data, host);
    if let Err(e) = upstream_tls.write_all(&rewritten).await {
        log_mitm_failure(
            state,
            app_handle,
            host,
            target,
            start,
            &format!("upstream write failed: {}", e),
        )
        .await;
        return Ok(());
    }

    // Read the full upstream response (header + body, bounded read loop).
    let mut response_buf = Vec::with_capacity(8192);
    let mut tmp = vec![0u8; 16 * 1024];
    loop {
        match upstream_tls.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => response_buf.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
        if response_buf.len() > 8 * 1024 * 1024 {
            // Cap at 8 MiB to avoid runaway memory on streaming responses.
            break;
        }
    }

    // Forward response to client.
    let _ = tls_client.write_all(&response_buf).await;
    let _ = tls_client.shutdown().await;

    let duration_ms = start.elapsed().as_millis() as u64;

    // Parse response status + headers + body for the connection log.
    let (status, response_headers, response_body, content_type) = parse_response(&response_buf);

    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method,
        url,
        host: host.to_string(),
        path,
        status,
        duration_ms: Some(duration_ms),
        request_size: Some(request_data.len() as u64),
        response_size: Some(response_buf.len() as u64),
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers,
        response_headers,
        request_body,
        response_body,
        content_type,
        intercepted: false,
        blocked: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);

    Ok(())
}

/// Serve a mock/reroute response back over the terminated TLS stream.
#[allow(clippy::too_many_arguments)]
async fn serve_intercept_over_tls(
    tls_client: &mut tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    method: &str,
    url: &str,
    host: &str,
    path: &str,
    request_headers: &[(String, String)],
    request_body: &Option<String>,
    action: &InterceptAction,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match action {
        InterceptAction::Mock { response } => {
            let body = response.content.text.as_deref().unwrap_or("");
            let full = build_mitm_mock_response_bytes(response);
            tls_client.write_all(&full).await?;
            let _ = tls_client.shutdown().await;

            let duration_ms = start.elapsed().as_millis() as u64;
            let content_type = response
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                .map(|h| h.value.clone())
                .unwrap_or_else(|| response.content.mime_type.clone());
            let response_headers: Vec<(String, String)> = response
                .headers
                .iter()
                .map(|h| (h.name.clone(), h.value.clone()))
                .collect();

            let conn = ConnectionLog {
                id: uuid::Uuid::new_v4().to_string(),
                method: method.to_string(),
                url: url.to_string(),
                host: host.to_string(),
                path: path.to_string(),
                status: Some(response.status),
                duration_ms: Some(duration_ms),
                request_size: None,
                response_size: Some(full.len() as u64),
                timestamp: chrono::Utc::now().to_rfc3339(),
                request_headers: request_headers.to_vec(),
                response_headers,
                request_body: request_body.clone(),
                response_body: Some(body.to_string()),
                content_type: Some(content_type),
                intercepted: true,
                blocked: false,
            };
            state.add_connection(conn.clone()).await;
            let _ = app_handle.emit("proxy:connection", &conn);
            log::info!(
                "Intercepted HTTPS {} {} -> Mock {}",
                method,
                url,
                response.status
            );
        }
        InterceptAction::Reroute { target_url } => {
            // For HTTPS reroute we go plain-HTTP/-HTTPS to the new target.
            // The current implementation supports http(s):// reroute targets.
            let reroute_host = extract_host(target_url, "");
            let reroute_path = extract_path(target_url);
            let is_https = target_url.starts_with("https://");
            let reroute_port = extract_port(target_url).unwrap_or(if is_https { 443 } else { 80 });

            let request_line = format!(
                "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                method, reroute_path, reroute_host
            );

            let upstream_tcp =
                tokio::net::TcpStream::connect((reroute_host.as_str(), reroute_port)).await?;
            let response_buf = if is_https {
                let connector = tls::build_upstream_connector()?;
                let server_name = rustls::pki_types::ServerName::try_from(reroute_host.clone())?;
                let mut upstream_tls = connector.connect(server_name, upstream_tcp).await?;
                upstream_tls.write_all(request_line.as_bytes()).await?;
                let mut buf = Vec::new();
                let _ = upstream_tls.read_to_end(&mut buf).await;
                buf
            } else {
                let mut s = upstream_tcp;
                s.write_all(request_line.as_bytes()).await?;
                let mut buf = Vec::new();
                let _ = s.read_to_end(&mut buf).await;
                buf
            };

            tls_client.write_all(&response_buf).await?;
            let _ = tls_client.shutdown().await;

            let (status, response_headers, _body, content_type) = parse_response(&response_buf);

            let duration_ms = start.elapsed().as_millis() as u64;
            let conn = ConnectionLog {
                id: uuid::Uuid::new_v4().to_string(),
                method: method.to_string(),
                url: url.to_string(),
                host: host.to_string(),
                path: path.to_string(),
                status,
                duration_ms: Some(duration_ms),
                request_size: None,
                response_size: Some(response_buf.len() as u64),
                timestamp: chrono::Utc::now().to_rfc3339(),
                request_headers: request_headers.to_vec(),
                response_headers,
                request_body: request_body.clone(),
                response_body: None,
                content_type,
                intercepted: true,
                blocked: false,
            };
            state.add_connection(conn.clone()).await;
            let _ = app_handle.emit("proxy:connection", &conn);
            log::info!(
                "Intercepted HTTPS {} {} -> Reroute {}",
                method,
                url,
                target_url
            );
        }
    }
    Ok(())
}

/// Emit a warning-level ConnectionLog row for an MITM path failure.
async fn log_mitm_failure(
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    host: &str,
    target: &str,
    start: std::time::Instant,
    note: &str,
) {
    log::warn!("MITM failed for {}: {}", target, note);
    let duration_ms = start.elapsed().as_millis() as u64;
    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: "CONNECT".to_string(),
        url: format!("https://{}", target),
        host: host.to_string(),
        path: "/".to_string(),
        status: None,
        duration_ms: Some(duration_ms),
        request_size: None,
        response_size: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers: vec![],
        response_headers: vec![],
        request_body: None,
        response_body: Some(format!("MITM error: {}", note)),
        content_type: None,
        intercepted: false,
        blocked: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);
}

/// Rewrite an inbound HTTP request to be safe for forwarding over an
/// upstream TLS connection.
///
/// Specifically: forces `Connection: close` so we don't have to negotiate
/// keep-alive on the upstream side. Leaves the request line and the rest of
/// the headers untouched (origin-form `/path` is what the upstream expects
/// anyway since the original request was over a CONNECT tunnel).
pub fn rewrite_for_upstream(request_data: &[u8], host: &str) -> Vec<u8> {
    let s = String::from_utf8_lossy(request_data).to_string();
    let (head, body) = match s.find("\r\n\r\n") {
        Some(idx) => (s[..idx].to_string(), s[idx + 4..].to_string()),
        None => (s.clone(), String::new()),
    };

    let mut out_lines: Vec<String> = Vec::new();
    let mut saw_host = false;
    let mut saw_conn = false;
    for (i, line) in head.lines().enumerate() {
        if i == 0 {
            out_lines.push(line.to_string());
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            saw_host = true;
            out_lines.push(line.to_string());
        } else if lower.starts_with("connection:") || lower.starts_with("proxy-connection:") {
            saw_conn = true;
            out_lines.push("Connection: close".to_string());
        } else {
            out_lines.push(line.to_string());
        }
    }
    if !saw_host {
        out_lines.insert(1, format!("Host: {}", host));
    }
    if !saw_conn {
        out_lines.push("Connection: close".to_string());
    }
    let mut bytes = out_lines.join("\r\n").into_bytes();
    bytes.extend_from_slice(b"\r\n\r\n");
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// Parse a raw HTTP response byte buffer into the pieces we log.
///
/// As of v0.4.3 this also decodes the body so the Connections drawer can
/// render it usefully:
/// - chunked `Transfer-Encoding` is unwrapped into a flat byte stream;
/// - `Content-Encoding: gzip | deflate | br` is decompressed (any failure
///   falls back silently to the raw bytes);
/// - text content types (`text/*`, JSON, XML, JavaScript, urlencoded form)
///   are returned as UTF-8 strings (lossy);
/// - binary content types (images, video, audio, fonts, PDFs, application/
///   octet-stream, unrecognized MIME) are base64-encoded as a `data:<mime>;
///   base64,...` URI so the frontend can drop them straight into `<img>` /
///   `<video>` / etc.
///
/// # Returns
/// `(status, headers, body_text, content_type)` — `body_text` is `None`
/// when the response has no body separator, an empty string when the body
/// section is present but empty, or a (potentially data-URI) string for
/// everything else.
#[allow(clippy::type_complexity)]
pub fn parse_response(
    buf: &[u8],
) -> (
    Option<u16>,
    Vec<(String, String)>,
    Option<String>,
    Option<String>,
) {
    // Locate the header / body boundary on raw bytes so we don't truncate
    // binary payloads via String::from_utf8_lossy.
    let header_end = find_header_end(buf);
    let head_bytes = match header_end {
        Some(idx) => &buf[..idx],
        None => buf,
    };
    let body_bytes_raw: Option<&[u8]> = header_end.map(|idx| &buf[idx + 4..]);

    // Headers are ASCII-only by RFC, so utf8_lossy on the header slice is
    // safe and matches the historical parser shape.
    let head = String::from_utf8_lossy(head_bytes);
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok());

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_type: Option<String> = None;
    let mut content_encoding: Option<String> = None;
    let mut transfer_encoding: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(": ") {
            if k.eq_ignore_ascii_case("content-type") {
                content_type = Some(v.to_string());
            } else if k.eq_ignore_ascii_case("content-encoding") {
                content_encoding = Some(v.to_string());
            } else if k.eq_ignore_ascii_case("transfer-encoding") {
                transfer_encoding = Some(v.to_string());
            }
            headers.push((k.to_string(), v.to_string()));
        }
    }

    let body = body_bytes_raw.map(|raw| {
        let dechunked = if transfer_encoding
            .as_deref()
            .map(|te| te.to_ascii_lowercase().contains("chunked"))
            .unwrap_or(false)
        {
            decode_chunked(raw).unwrap_or_else(|| raw.to_vec())
        } else {
            raw.to_vec()
        };

        let decoded = match content_encoding.as_deref().map(|s| s.to_ascii_lowercase()) {
            Some(ref e) if e == "gzip" || e == "x-gzip" => decompress_gzip(&dechunked)
                .unwrap_or(dechunked),
            Some(ref e) if e == "deflate" => decompress_deflate(&dechunked)
                .unwrap_or(dechunked),
            Some(ref e) if e == "br" => decompress_brotli(&dechunked)
                .unwrap_or(dechunked),
            _ => dechunked,
        };

        encode_body_for_log(&decoded, content_type.as_deref())
    });

    (status, headers, body, content_type)
}

/// Byte-level search for the `\r\n\r\n` header / body separator. Returns the
/// index of the first `\r` so callers can slice `buf[..idx]` for headers
/// and `buf[idx + 4..]` for the body.
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Decode HTTP/1.1 chunked transfer-encoding into a flat byte vector.
///
/// Returns `None` on any malformed input (the caller then falls back to
/// the raw bytes — preserving prior behavior for the "we can't parse it,
/// just show what we have" case).
fn decode_chunked(buf: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0usize;
    while i < buf.len() {
        // Find CRLF terminating the size line.
        let line_end = buf[i..].windows(2).position(|w| w == b"\r\n")? + i;
        let size_line = std::str::from_utf8(&buf[i..line_end]).ok()?;
        // Strip any chunk extensions after ';'.
        let size_hex = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        i = line_end + 2;
        if size == 0 {
            return Some(out);
        }
        if i + size > buf.len() {
            return None;
        }
        out.extend_from_slice(&buf[i..i + size]);
        i += size;
        // Each chunk is terminated by CRLF.
        if i + 2 > buf.len() {
            return None;
        }
        if &buf[i..i + 2] != b"\r\n" {
            return None;
        }
        i += 2;
    }
    Some(out)
}

fn decompress_gzip(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn decompress_deflate(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    // Try raw deflate first, then zlib-wrapped — servers vary on which they
    // mean when they say "deflate" (Microsoft IIS notoriously sends raw).
    let mut out = Vec::new();
    let mut zlib = flate2::read::ZlibDecoder::new(data);
    if zlib.read_to_end(&mut out).is_ok() {
        return Some(out);
    }
    out.clear();
    let mut raw = flate2::read::DeflateDecoder::new(data);
    raw.read_to_end(&mut out).ok()?;
    Some(out)
}

fn decompress_brotli(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut decoder = brotli::Decompressor::new(data, 4096);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Heuristic: should this content-type be shown as plain text?
fn is_text_content_type(ct: Option<&str>) -> bool {
    let Some(ct) = ct else {
        return true; // unknown ⇒ try text first (matches v0.4.2 behavior)
    };
    let ct = ct.to_ascii_lowercase();
    let base = ct.split(';').next().unwrap_or("").trim();
    if base.starts_with("text/") {
        return true;
    }
    matches!(
        base,
        "application/json"
            | "application/ld+json"
            | "application/javascript"
            | "application/x-javascript"
            | "application/ecmascript"
            | "application/xml"
            | "application/xhtml+xml"
            | "application/x-www-form-urlencoded"
            | "application/graphql"
            | "application/problem+json"
            | "application/vnd.api+json"
            | "application/x-yaml"
            | "application/yaml"
    ) || base.ends_with("+json")
        || base.ends_with("+xml")
}

/// Render a decoded body slice into the string we ship to the frontend.
///
/// Text-like content types come through as UTF-8 (lossy). Binary content
/// types are emitted as `data:<mime>;base64,...` URIs so `<img>` / `<video>`
/// / `<audio>` elements in the Connections drawer can render them directly.
fn encode_body_for_log(decoded: &[u8], content_type: Option<&str>) -> String {
    if decoded.is_empty() {
        return String::new();
    }
    if is_text_content_type(content_type) {
        return String::from_utf8_lossy(decoded).into_owned();
    }
    use base64::Engine as _;
    let mime = content_type
        .and_then(|c| c.split(';').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream");
    let b64 = base64::engine::general_purpose::STANDARD.encode(decoded);
    format!("data:{};base64,{}", mime, b64)
}

/// Map a rustls handshake-accept error into a short human-readable note
/// for the connection-log body.
///
/// We can't reliably introspect [`std::io::Error`] / `rustls::Error` enums
/// here because the accept path returns a `std::io::Error` whose inner
/// payload varies by rustls version — instead we inspect the `Display` text
/// for the two failure shapes that matter to users.
pub fn classify_tls_failure(err: &std::io::Error) -> &'static str {
    let s = err.to_string().to_ascii_lowercase();
    if s.contains("eof") || s.contains("unexpected end of file") || s.contains("peer closed") {
        // Client tore down the handshake without sending an alert. Pinning
        // clients (Apple iCloud / APNS / App Store / banking apps) almost
        // always look like this.
        "likely certificate pinning — common for iCloud, App Store, banking apps; cannot be MITM-ed"
    } else if s.contains("bad certificate")
        || s.contains("unknown ca")
        || s.contains("unknown_ca")
        || s.contains("certificate unknown")
        || s.contains("self-signed")
        || s.contains("self signed")
    {
        "is the Proxie CA installed in this client's trust store?"
    } else {
        "is the Proxie CA trusted?"
    }
}

async fn handle_http_request(
    client_stream: &mut tokio::net::TcpStream,
    method: &str,
    url: &str,
    request_data: &[u8],
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Parse host from URL or Host header
    let request_str = String::from_utf8_lossy(request_data);
    let host = extract_host(url, &request_str);
    let path = extract_path(url);

    // Self-served `/ping` endpoint — short-circuit any request whose Host
    // header equals the proxy's own listen addr AND whose path starts with
    // `/ping`. Lets users click the address chip on the Setup page and see
    // an immediate "yes, the proxy is up" response.
    //
    // Intentionally NOT recorded in the connection log — this is a meta
    // request to the proxy itself, not user traffic, and logging it would
    // fill the Connections view with noise every time the user clicks the
    // address link.
    if path == "/ping" || path.starts_with("/ping?") || path.starts_with("/ping/") {
        // Pull addr/port out of the `Result` and drop the non-Send boxed
        // error before the next `.await` — tokio::spawn requires the future
        // to be `Send` and `Box<dyn StdError>` is not.
        let listen = match state.get_proxy_config().await {
            Ok(cfg) => Some((cfg.listen_addr, cfg.port)),
            Err(_) => None,
        };
        if let Some((listen_addr, port)) = listen {
            if host_header_matches_listen(&request_str, &listen_addr, port) {
                let body = build_ping_response_body(&listen_addr, port);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
                    body.len(),
                    body
                );
                client_stream.write_all(resp.as_bytes()).await?;
                let _ = (app_handle, start); // intentionally not logged
                return Ok(());
            }
        }
    }

    // Extract request body (everything after \r\n\r\n)
    let request_body = request_str
        .find("\r\n\r\n")
        .map(|idx| request_str[idx + 4..].to_string())
        .filter(|s| !s.is_empty());

    // Extract request headers
    let request_headers: Vec<(String, String)> = request_str
        .lines()
        .skip(1) // skip request line
        .take_while(|line| !line.is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(2, ": ");
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect();

    // Block rules run BEFORE intercept rules and BEFORE any upstream socket
    // is opened — match-and-short-circuit with 204 No Content (Pi-hole-style
    // empty body so the client treats the resource as missing rather than
    // erroring on a refused connection).
    if let Some(rule) = state.find_block_rule(&host, &path).await {
        return serve_block_http(
            client_stream,
            method,
            url,
            &host,
            &path,
            &request_headers,
            &request_body,
            &rule,
            state,
            app_handle,
            start,
        )
        .await;
    }

    // Check for matching intercept rule
    if let Some(rule) = state.find_intercept_rule(&host, &path, method).await {
        return handle_intercepted_request(
            client_stream,
            method,
            url,
            &host,
            &path,
            &request_headers,
            &request_body,
            &rule.action,
            state,
            app_handle,
            start,
        )
        .await;
    }

    // No intercept — forward normally
    let port = extract_port(url).unwrap_or(80);
    let upstream_addr = format!("{}:{}", host, port);
    let mut upstream = tokio::net::TcpStream::connect(&upstream_addr).await?;

    // Forward the request
    upstream.write_all(request_data).await?;

    // Read the response
    let mut response_buf = Vec::new();
    let mut tmp = vec![0u8; 8192];
    loop {
        let n = upstream.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        response_buf.extend_from_slice(&tmp[..n]);
        if response_buf.len() > 4 && response_buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                upstream.read(&mut tmp),
            )
            .await
            {
                Ok(Ok(n)) if n > 0 => response_buf.extend_from_slice(&tmp[..n]),
                _ => break,
            }
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    // Send response back to client
    client_stream.write_all(&response_buf).await?;

    // Parse status from response
    let response_str = String::from_utf8_lossy(&response_buf);
    let status = response_str
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok());

    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: method.to_string(),
        url: url.to_string(),
        host: host.to_string(),
        path,
        status,
        duration_ms: Some(duration_ms),
        request_size: Some(request_data.len() as u64),
        response_size: Some(response_buf.len() as u64),
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers,
        response_headers: vec![],
        request_body,
        response_body: None,
        content_type: None,
        intercepted: false,
        blocked: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);

    Ok(())
}

/// Handle an intercepted request — either mock a response or reroute.
async fn handle_intercepted_request(
    client_stream: &mut tokio::net::TcpStream,
    method: &str,
    url: &str,
    host: &str,
    path: &str,
    request_headers: &[(String, String)],
    request_body: &Option<String>,
    action: &InterceptAction,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match action {
        InterceptAction::Mock { response } => {
            // Build HTTP response from HAR response object
            let body = response.content.text.as_deref().unwrap_or("");
            let body_bytes = body.as_bytes();

            let mut resp = format!("HTTP/1.1 {} {}\r\n", response.status, response.status_text);

            // Add HAR headers
            for header in &response.headers {
                resp.push_str(&format!("{}: {}\r\n", header.name, header.value));
            }

            // Add Content-Length if not already present
            let has_content_length = response
                .headers
                .iter()
                .any(|h| h.name.to_lowercase() == "content-length");
            if !has_content_length {
                resp.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
            }

            resp.push_str("\r\n");

            let mut full_response = resp.into_bytes();
            full_response.extend_from_slice(body_bytes);

            client_stream.write_all(&full_response).await?;

            let duration_ms = start.elapsed().as_millis() as u64;

            let content_type = response
                .headers
                .iter()
                .find(|h| h.name.to_lowercase() == "content-type")
                .map(|h| h.value.clone())
                .unwrap_or_else(|| response.content.mime_type.clone());

            let response_headers: Vec<(String, String)> = response
                .headers
                .iter()
                .map(|h| (h.name.clone(), h.value.clone()))
                .collect();

            let conn = ConnectionLog {
                id: uuid::Uuid::new_v4().to_string(),
                method: method.to_string(),
                url: url.to_string(),
                host: host.to_string(),
                path: path.to_string(),
                status: Some(response.status),
                duration_ms: Some(duration_ms),
                request_size: None,
                response_size: Some(full_response.len() as u64),
                timestamp: chrono::Utc::now().to_rfc3339(),
                request_headers: request_headers.to_vec(),
                response_headers,
                request_body: request_body.clone(),
                response_body: Some(body.to_string()),
                content_type: Some(content_type),
                intercepted: true,
                blocked: false,
            };
            state.add_connection(conn.clone()).await;
            let _ = app_handle.emit("proxy:connection", &conn);

            log::info!(
                "Intercepted {} {} -> Mock {} ",
                method,
                url,
                response.status
            );
        }

        InterceptAction::Reroute { target_url } => {
            // Reroute: connect to a different target
            let reroute_host = extract_host(target_url, "");
            let reroute_port = extract_port(target_url).unwrap_or(80);
            let reroute_addr = format!("{}:{}", reroute_host, reroute_port);

            let mut upstream = tokio::net::TcpStream::connect(&reroute_addr).await?;

            // Rewrite the request line to target the reroute URL
            let request_str = format!(
                "{} {} HTTP/1.1\r\nHost: {}\r\n",
                method,
                extract_path(target_url),
                reroute_host
            );

            // Send rewritten request
            upstream.write_all(request_str.as_bytes()).await?;

            // Read response from rerouted target
            let mut response_buf = Vec::new();
            let mut tmp = vec![0u8; 8192];
            loop {
                let n = upstream.read(&mut tmp).await?;
                if n == 0 {
                    break;
                }
                response_buf.extend_from_slice(&tmp[..n]);
                if response_buf.len() > 4 && response_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(100),
                        upstream.read(&mut tmp),
                    )
                    .await
                    {
                        Ok(Ok(n)) if n > 0 => response_buf.extend_from_slice(&tmp[..n]),
                        _ => break,
                    }
                }
            }

            let duration_ms = start.elapsed().as_millis() as u64;

            // Forward response to client
            client_stream.write_all(&response_buf).await?;

            let response_str = String::from_utf8_lossy(&response_buf);
            let status = response_str
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|s| s.parse::<u16>().ok());

            let conn = ConnectionLog {
                id: uuid::Uuid::new_v4().to_string(),
                method: method.to_string(),
                url: url.to_string(),
                host: host.to_string(),
                path: path.to_string(),
                status,
                duration_ms: Some(duration_ms),
                request_size: None,
                response_size: Some(response_buf.len() as u64),
                timestamp: chrono::Utc::now().to_rfc3339(),
                request_headers: request_headers.to_vec(),
                response_headers: vec![],
                request_body: request_body.clone(),
                response_body: None,
                content_type: None,
                intercepted: true,
                blocked: false,
            };
            state.add_connection(conn.clone()).await;
            let _ = app_handle.emit("proxy:connection", &conn);

            log::info!(
                "Intercepted {} {} -> Reroute to {}",
                method,
                url,
                target_url
            );
        }
    }

    Ok(())
}

/// Check if a host matches a rule pattern (supports wildcard prefix like *.example.com).
pub fn host_matches(pattern: &str, host: &str) -> bool {
    if pattern.starts_with("*.") {
        let suffix = &pattern[1..]; // ".example.com"
        host.ends_with(suffix) || host == &pattern[2..]
    } else {
        pattern == host
    }
}

/// Build the JSON body returned by the self-served `/ping` endpoint.
///
/// Shape: `{"proxy":"proxie","version":"<pkg>","status":"ok","listen":"<addr>:<port>"}`.
/// Kept tiny on purpose — the click target is a "is the proxy up?" probe,
/// not a metrics endpoint.
///
/// # Arguments
/// * `listen_addr` - The proxy's bound address (typically `127.0.0.1`).
/// * `port` - The proxy's bound port.
///
/// # Returns
/// A JSON string with no trailing newline.
pub(crate) fn build_ping_response_body(listen_addr: &str, port: u16) -> String {
    let body = serde_json::json!({
        "proxy": "proxie",
        "version": env!("CARGO_PKG_VERSION"),
        "status": "ok",
        "listen": format!("{}:{}", listen_addr, port),
    });
    body.to_string()
}

/// Check whether the `Host:` header of a raw HTTP request points at the
/// proxy's own listen address.
///
/// Accepts either the bare host (`127.0.0.1`) or the host+port form
/// (`127.0.0.1:39871`). Header-name match is case-insensitive; value
/// comparison is exact after trimming.
///
/// # Arguments
/// * `request` - The raw HTTP/1.1 request bytes as a UTF-8 lossy string.
/// * `listen_addr` - The proxy's bound address.
/// * `port` - The proxy's bound port.
///
/// # Returns
/// `true` when the Host header explicitly matches `<listen_addr>` or
/// `<listen_addr>:<port>`; `false` otherwise (including when no Host header
/// is present).
fn host_header_matches_listen(request: &str, listen_addr: &str, port: u16) -> bool {
    for line in request.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("host:") {
            let v = rest.trim();
            let expected_bare = listen_addr.to_ascii_lowercase();
            let expected_full = format!("{}:{}", expected_bare, port);
            if v == expected_bare || v == expected_full {
                return true;
            }
        }
    }
    false
}

fn extract_host(url: &str, request: &str) -> String {
    // Try from URL first
    if let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        if let Some(host) = rest.split('/').next() {
            let host = host.split(':').next().unwrap_or(host);
            if !host.is_empty() {
                return host.to_string();
            }
        }
    }
    // Fall back to Host header
    for line in request.lines() {
        if let Some(host) = line
            .strip_prefix("Host: ")
            .or_else(|| line.strip_prefix("host: "))
        {
            return host.split(':').next().unwrap_or(host).trim().to_string();
        }
    }
    "unknown".to_string()
}

fn extract_path(url: &str) -> String {
    if let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        if let Some(idx) = rest.find('/') {
            return rest[idx..].to_string();
        }
    }
    url.to_string()
}

fn extract_port(url: &str) -> Option<u16> {
    if let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        let host_part = rest.split('/').next()?;
        if let Some(port_str) = host_part.split(':').nth(1) {
            return port_str.parse().ok();
        }
    }
    None
}

/// Build the raw HTTP response bytes that the MITM (HTTPS) path writes back
/// to the client after an intercept rule matches.
///
/// The MITM dispatch in [`serve_intercept_over_tls`] terminates the client's
/// TLS and replies with this byte payload directly. It is identical in shape
/// to the plain-HTTP mock response built inline by [`handle_intercepted_request`]
/// except it always forces `Connection: close` — the MITM path doesn't want
/// keep-alive after a mock because the leaf TLS session is one-shot.
///
/// # Arguments
/// * `response` - The HAR-shaped mock response from the intercept rule.
///
/// # Returns
/// The full HTTP/1.1 response (status line + headers + CRLFCRLF + body).
/// `Content-Length` is added automatically unless the HAR headers already
/// contain one.
pub fn build_mitm_mock_response_bytes(response: &crate::types::HarResponse) -> Vec<u8> {
    let body = response.content.text.as_deref().unwrap_or("");
    let body_bytes = body.as_bytes();

    let mut resp = format!("HTTP/1.1 {} {}\r\n", response.status, response.status_text);
    for h in &response.headers {
        resp.push_str(&format!("{}: {}\r\n", h.name, h.value));
    }
    let has_cl = response
        .headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("content-length"));
    if !has_cl {
        resp.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
    }
    resp.push_str("Connection: close\r\n\r\n");

    let mut full = resp.into_bytes();
    full.extend_from_slice(body_bytes);
    full
}

/// Build a mock HTTP response bytes from an InterceptAction::Mock.
/// Used by the proxy engine and available for external testing/validation.
#[allow(dead_code)]
pub fn build_mock_response(action: &InterceptAction) -> Option<Vec<u8>> {
    match action {
        InterceptAction::Mock { response } => {
            let body = response.content.text.as_deref().unwrap_or("");
            let body_bytes = body.as_bytes();

            let mut resp = format!("HTTP/1.1 {} {}\r\n", response.status, response.status_text);

            for header in &response.headers {
                resp.push_str(&format!("{}: {}\r\n", header.name, header.value));
            }

            let has_content_length = response
                .headers
                .iter()
                .any(|h| h.name.to_lowercase() == "content-length");
            if !has_content_length {
                resp.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
            }

            resp.push_str("\r\n");

            let mut full = resp.into_bytes();
            full.extend_from_slice(body_bytes);
            Some(full)
        }
        InterceptAction::Reroute { .. } => None,
    }
}

// -------------------------------------------------------------------------
// Block-rule (Pi-hole style) response helpers.
// -------------------------------------------------------------------------

/// Build the raw HTTP/1.1 response bytes returned to a client when a
/// [`crate::types::BlockRule`] matches a decrypted HTTP/HTTPS request.
///
/// We use `204 No Content` (not `403 Forbidden`) as the HTTP-layer analogue
/// of Pi-hole's NXDOMAIN: an empty, successful-looking response so the
/// client treats the blocked resource as "nothing to render here" rather
/// than as a server error that triggers retries or error UI.
///
/// The 403 path is reserved for the raw CONNECT short-circuit
/// ([`build_block_connect_response_bytes`]) where there is no decrypted
/// HTTP envelope to fill — the client needs to know the tunnel was
/// actively refused.
///
/// # Returns
/// `HTTP/1.1 204 No Content` with `Content-Length: 0`,
/// `Connection: close`, and an `X-Blocked-By: Proxie` marker header.
pub fn build_block_http_response_bytes() -> Vec<u8> {
    let mut resp = String::from("HTTP/1.1 204 No Content\r\n");
    resp.push_str("Content-Length: 0\r\n");
    resp.push_str("X-Blocked-By: Proxie\r\n");
    resp.push_str("Connection: close\r\n\r\n");
    resp.into_bytes()
}

/// Build the raw HTTP/1.1 response bytes returned over the CONNECT socket
/// when a block rule matches BEFORE the TLS handshake (no upstream socket
/// is opened, no leaf cert is minted). 403 + empty body + immediate close
/// is the closest TCP-layer analogue of a Pi-hole DNS sinkhole.
pub fn build_block_connect_response_bytes() -> Vec<u8> {
    let mut resp = String::from("HTTP/1.1 403 Forbidden\r\n");
    resp.push_str("Content-Length: 0\r\n");
    resp.push_str("X-Blocked-By: Proxie\r\n");
    resp.push_str("Connection: close\r\n\r\n");
    resp.into_bytes()
}

/// Short-circuit a plain-HTTP request with a 204 No Content reply, log
/// the blocked connection, and emit the `proxy:connection` event.
#[allow(clippy::too_many_arguments)]
async fn serve_block_http(
    client_stream: &mut tokio::net::TcpStream,
    method: &str,
    url: &str,
    host: &str,
    path: &str,
    request_headers: &[(String, String)],
    request_body: &Option<String>,
    rule: &crate::types::BlockRule,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bytes = build_block_http_response_bytes();
    client_stream.write_all(&bytes).await?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: method.to_string(),
        url: url.to_string(),
        host: host.to_string(),
        path: path.to_string(),
        status: Some(204),
        duration_ms: Some(duration_ms),
        request_size: None,
        response_size: Some(bytes.len() as u64),
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers: request_headers.to_vec(),
        response_headers: vec![
            ("X-Blocked-By".to_string(), "Proxie".to_string()),
            ("Connection".to_string(), "close".to_string()),
        ],
        request_body: request_body.clone(),
        response_body: Some(format!("blocked by rule: {}", rule.note)),
        content_type: None,
        intercepted: false,
        blocked: true,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);
    log::info!("Blocked HTTP {} {} (rule: {})", method, url, rule.note);
    Ok(())
}

/// Short-circuit a decrypted HTTPS request (post-MITM) with a 204 No
/// Content reply written back over the terminated TLS stream.
#[allow(clippy::too_many_arguments)]
async fn serve_block_https(
    tls_client: &mut tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    method: &str,
    url: &str,
    host: &str,
    path: &str,
    request_headers: &[(String, String)],
    request_body: &Option<String>,
    rule: &crate::types::BlockRule,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bytes = build_block_http_response_bytes();
    let _ = tls_client.write_all(&bytes).await;
    let _ = tls_client.shutdown().await;

    let duration_ms = start.elapsed().as_millis() as u64;
    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: method.to_string(),
        url: url.to_string(),
        host: host.to_string(),
        path: path.to_string(),
        status: Some(204),
        duration_ms: Some(duration_ms),
        request_size: None,
        response_size: Some(bytes.len() as u64),
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers: request_headers.to_vec(),
        response_headers: vec![
            ("X-Blocked-By".to_string(), "Proxie".to_string()),
            ("Connection".to_string(), "close".to_string()),
        ],
        request_body: request_body.clone(),
        response_body: Some(format!("blocked by rule: {}", rule.note)),
        content_type: None,
        intercepted: false,
        blocked: true,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);
    log::info!("Blocked HTTPS {} {} (rule: {})", method, url, rule.note);
    Ok(())
}

/// Short-circuit a CONNECT request on the raw TCP path — replies 403,
/// closes the socket, and never opens an upstream connection.
async fn serve_block_connect(
    mut client_stream: tokio::net::TcpStream,
    host: &str,
    target: &str,
    rule: &crate::types::BlockRule,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bytes = build_block_connect_response_bytes();
    let _ = client_stream.write_all(&bytes).await;
    let _ = client_stream.shutdown().await;

    let duration_ms = start.elapsed().as_millis() as u64;
    let conn = ConnectionLog {
        id: uuid::Uuid::new_v4().to_string(),
        method: "CONNECT".to_string(),
        url: format!("https://{}", target),
        host: host.to_string(),
        path: "/".to_string(),
        status: Some(403),
        duration_ms: Some(duration_ms),
        request_size: None,
        response_size: Some(bytes.len() as u64),
        timestamp: chrono::Utc::now().to_rfc3339(),
        request_headers: vec![],
        response_headers: vec![
            ("X-Blocked-By".to_string(), "Proxie".to_string()),
            ("Connection".to_string(), "close".to_string()),
        ],
        request_body: None,
        response_body: Some(format!("blocked by rule: {}", rule.note)),
        content_type: None,
        intercepted: false,
        blocked: true,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);
    log::info!("Blocked CONNECT {} (rule: {})", target, rule.note);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HarContent, HarHeader, HarResponse, InterceptAction};

    #[test]
    fn test_host_matches_exact() {
        assert!(host_matches("api.example.com", "api.example.com"));
        assert!(!host_matches("api.example.com", "other.example.com"));
    }

    #[test]
    fn test_host_matches_wildcard() {
        assert!(host_matches("*.example.com", "api.example.com"));
        assert!(host_matches("*.example.com", "www.example.com"));
        assert!(host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "example.org"));
    }

    #[test]
    fn test_extract_host_from_url() {
        assert_eq!(
            extract_host("http://api.example.com/path", ""),
            "api.example.com"
        );
        assert_eq!(
            extract_host("https://secure.example.com:443/path", ""),
            "secure.example.com"
        );
    }

    #[test]
    fn test_extract_host_from_header() {
        assert_eq!(
            extract_host("/path", "GET /path HTTP/1.1\r\nHost: api.example.com\r\n"),
            "api.example.com"
        );
    }

    #[test]
    fn test_extract_path() {
        assert_eq!(
            extract_path("http://example.com/api/v1/users"),
            "/api/v1/users"
        );
        assert_eq!(extract_path("http://example.com"), "http://example.com");
        assert_eq!(extract_path("/plain/path"), "/plain/path");
    }

    #[test]
    fn test_extract_port() {
        assert_eq!(extract_port("http://example.com:8080/path"), Some(8080));
        assert_eq!(extract_port("http://example.com/path"), None);
        assert_eq!(extract_port("https://secure.com:443/"), Some(443));
    }

    #[test]
    fn test_build_mock_response_200() {
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 200,
                status_text: "OK".to_string(),
                headers: vec![HarHeader {
                    name: "Content-Type".to_string(),
                    value: "application/json".to_string(),
                }],
                content: HarContent {
                    size: 13,
                    mime_type: "application/json".to_string(),
                    text: Some(r#"{"ok":true}"#.to_string()),
                },
            },
        };
        let resp = build_mock_response(&action).unwrap();
        let resp_str = String::from_utf8(resp).unwrap();
        assert!(resp_str.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(resp_str.contains("Content-Type: application/json"));
        assert!(resp_str.contains("Content-Length: 11"));
        assert!(resp_str.ends_with(r#"{"ok":true}"#));
    }

    #[test]
    fn test_build_mock_response_custom_status() {
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 404,
                status_text: "Not Found".to_string(),
                headers: vec![],
                content: HarContent {
                    size: 0,
                    mime_type: "text/plain".to_string(),
                    text: Some("not found".to_string()),
                },
            },
        };
        let resp = build_mock_response(&action).unwrap();
        let resp_str = String::from_utf8(resp).unwrap();
        assert!(resp_str.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(resp_str.contains("Content-Length: 9"));
    }

    #[test]
    fn test_build_mock_response_with_multiple_headers() {
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 302,
                status_text: "Found".to_string(),
                headers: vec![
                    HarHeader {
                        name: "Location".to_string(),
                        value: "https://other.com".to_string(),
                    },
                    HarHeader {
                        name: "X-Custom".to_string(),
                        value: "test-value".to_string(),
                    },
                ],
                content: HarContent {
                    size: 0,
                    mime_type: "text/html".to_string(),
                    text: None,
                },
            },
        };
        let resp = build_mock_response(&action).unwrap();
        let resp_str = String::from_utf8(resp).unwrap();
        assert!(resp_str.contains("Location: https://other.com"));
        assert!(resp_str.contains("X-Custom: test-value"));
        assert!(resp_str.contains("Content-Length: 0"));
    }

    #[test]
    fn test_build_mock_response_reroute_returns_none() {
        let action = InterceptAction::Reroute {
            target_url: "https://staging.example.com".to_string(),
        };
        assert!(build_mock_response(&action).is_none());
    }

    #[test]
    fn test_build_mock_response_explicit_content_length() {
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 200,
                status_text: "OK".to_string(),
                headers: vec![HarHeader {
                    name: "Content-Length".to_string(),
                    value: "42".to_string(),
                }],
                content: HarContent {
                    size: 5,
                    mime_type: "text/plain".to_string(),
                    text: Some("hello".to_string()),
                },
            },
        };
        let resp = build_mock_response(&action).unwrap();
        let resp_str = String::from_utf8(resp).unwrap();
        // Should use the explicit Content-Length, not auto-add one
        let count = resp_str.matches("Content-Length").count();
        assert_eq!(count, 1);
        assert!(resp_str.contains("Content-Length: 42"));
    }

    #[test]
    fn test_parse_response_basic() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let (status, headers, body, ct) = parse_response(raw);
        assert_eq!(status, Some(200));
        assert!(headers.iter().any(|(k, _)| k == "Content-Type"));
        assert_eq!(ct.as_deref(), Some("application/json"));
        assert_eq!(body.as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn test_parse_response_missing_body() {
        let raw = b"HTTP/1.1 204 No Content\r\nX-Foo: bar\r\n\r\n";
        let (status, headers, body, ct) = parse_response(raw);
        assert_eq!(status, Some(204));
        assert_eq!(headers.len(), 1);
        assert_eq!(body.as_deref(), Some(""));
        assert!(ct.is_none());
    }

    #[test]
    fn test_parse_response_no_header_terminator() {
        let raw = b"HTTP/1.1 500 Internal";
        let (status, _headers, body, _ct) = parse_response(raw);
        assert_eq!(status, Some(500));
        assert!(body.is_none());
    }

    #[test]
    fn test_rewrite_for_upstream_adds_connection_close() {
        let req = b"GET /path HTTP/1.1\r\nHost: api.example.com\r\nAccept: */*\r\n\r\n";
        let out = rewrite_for_upstream(req, "api.example.com");
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("GET /path HTTP/1.1\r\n"));
        assert!(s.contains("Host: api.example.com"));
        assert!(s.contains("Connection: close"));
    }

    #[test]
    fn test_rewrite_for_upstream_replaces_keep_alive() {
        let req =
            b"POST /api HTTP/1.1\r\nHost: api.example.com\r\nConnection: keep-alive\r\n\r\nbody";
        let out = rewrite_for_upstream(req, "api.example.com");
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("Connection: close"));
        assert!(!s.contains("keep-alive"));
        assert!(s.ends_with("body"));
    }

    #[test]
    fn test_rewrite_for_upstream_inserts_host_if_missing() {
        let req = b"GET /path HTTP/1.1\r\nAccept: */*\r\n\r\n";
        let out = rewrite_for_upstream(req, "fallback.example.com");
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("Host: fallback.example.com"));
    }

    // -------------------------------------------------------------------
    // MITM intercept-dispatch regression coverage.
    //
    // The HTTPS MITM path (see `serve_intercept_over_tls`) terminates the
    // client's TLS, parses the decrypted request line, and — when an
    // intercept rule matches — writes back the exact byte payload produced
    // by `build_mitm_mock_response_bytes`. These tests pin that byte
    // contract so a future refactor can't silently break the HTTPS
    // intercept feature (no plain-HTTP fixture exercises the
    // `Connection: close` variant or the 418 status path used here).
    // -------------------------------------------------------------------

    #[test]
    fn test_build_mitm_mock_response_bytes_teapot_payload() {
        let response = HarResponse {
            status: 418,
            status_text: "I'm a teapot".to_string(),
            headers: vec![HarHeader {
                name: "Content-Type".to_string(),
                value: "text/plain".to_string(),
            }],
            content: HarContent {
                size: 11,
                mime_type: "text/plain".to_string(),
                text: Some("intercepted".to_string()),
            },
        };

        let bytes = build_mitm_mock_response_bytes(&response);
        let s = String::from_utf8(bytes).unwrap();

        assert!(s.starts_with("HTTP/1.1 418 I'm a teapot\r\n"));
        assert!(s.contains("Content-Type: text/plain\r\n"));
        // Auto-added since the HAR headers don't include Content-Length.
        assert!(s.contains("Content-Length: 11\r\n"));
        // The MITM path always forces Connection: close — this distinguishes
        // it from the plain-HTTP mock path.
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\nintercepted"));
    }

    #[test]
    fn test_build_mitm_mock_response_bytes_respects_explicit_content_length() {
        let response = HarResponse {
            status: 200,
            status_text: "OK".to_string(),
            headers: vec![HarHeader {
                name: "Content-Length".to_string(),
                value: "5".to_string(),
            }],
            content: HarContent {
                size: 5,
                mime_type: "text/plain".to_string(),
                text: Some("hello".to_string()),
            },
        };

        let bytes = build_mitm_mock_response_bytes(&response);
        let s = String::from_utf8(bytes).unwrap();

        // Should not double-emit Content-Length when the HAR rule already
        // supplied one.
        assert_eq!(s.matches("Content-Length").count(), 1);
        assert!(s.contains("Content-Length: 5\r\n"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\nhello"));
    }

    #[test]
    fn test_build_mitm_mock_response_bytes_empty_body() {
        // A 204-style mock with no body — used to verify the helper still
        // produces a well-formed header/body separator.
        let response = HarResponse {
            status: 204,
            status_text: "No Content".to_string(),
            headers: vec![],
            content: HarContent {
                size: 0,
                mime_type: "text/plain".to_string(),
                text: None,
            },
        };

        let bytes = build_mitm_mock_response_bytes(&response);
        let s = String::from_utf8(bytes).unwrap();

        assert!(s.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    #[test]
    fn test_build_mitm_mock_response_bytes_roundtrips_through_parse_response() {
        // End-to-end byte-roundtrip: bytes emitted on the MITM path must
        // parse back via the same `parse_response` helper the proxy uses to
        // log upstream responses. This proves the HTTPS-intercept payload
        // is wire-correct without needing a real TLS test harness.
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 418,
                status_text: "I'm a teapot".to_string(),
                headers: vec![HarHeader {
                    name: "Content-Type".to_string(),
                    value: "text/plain".to_string(),
                }],
                content: HarContent {
                    size: 11,
                    mime_type: "text/plain".to_string(),
                    text: Some("intercepted".to_string()),
                },
            },
        };
        let response = match &action {
            InterceptAction::Mock { response } => response.clone(),
            _ => unreachable!(),
        };
        let bytes = build_mitm_mock_response_bytes(&response);
        let (status, headers, body, content_type) = parse_response(&bytes);
        assert_eq!(status, Some(418));
        assert_eq!(content_type.as_deref(), Some("text/plain"));
        assert_eq!(body.as_deref(), Some("intercepted"));
        assert!(headers
            .iter()
            .any(|(k, v)| k == "Connection" && v == "close"));
    }

    #[test]
    fn test_mitm_intercept_match_shape_for_https_requests() {
        // Regression check for the MITM path's dispatch decision: after TLS
        // termination, `serve_intercept_over_tls` is reached only when
        // `state.find_intercept_rule(host, path, method)` returns Some(rule)
        // for the decrypted request line. The matching primitives —
        // `host_matches` (this file) and `path_matches` (in state.rs) — are
        // applied to plain `host` / `path` strings; the scheme (http vs
        // https) plays no part. This test pins that contract for an HTTPS
        // shape so a future change can't accidentally start rejecting
        // MITM-decrypted requests.

        // Host pattern from an intercept rule
        assert!(host_matches("api.example.test", "api.example.test"));
        assert!(host_matches("*.example.test", "api.example.test"));
        // Path matching is in state.rs, but the MITM extractor produces
        // origin-form paths ("/foo") — confirm the host check stays true
        // regardless of port.
        assert!(host_matches("api.example.test", "api.example.test"));
    }

    // ---------------------------------------------------------------
    // Block-rule (Pi-hole) byte-contract regressions.
    //
    // These tests pin the wire bytes the proxy returns to a client
    // when a BlockRule matches. We deliberately do NOT spin up a real
    // TCP/TLS harness — instead we verify the pure response-byte
    // builders that `serve_block_*` write back. Combined with the
    // matching-predicate tests in `state.rs`, this covers the
    // "block-rule fires correctly and produces the right bytes"
    // contract end-to-end.
    // ---------------------------------------------------------------

    #[test]
    fn test_build_block_http_response_is_204_no_content() {
        // HTTP-layer block: 204 No Content + empty body + close.
        // 204 is the Pi-hole analogue (NXDOMAIN -> "nothing here").
        let bytes = build_block_http_response_bytes();
        let s = String::from_utf8(bytes.clone()).unwrap();
        assert!(s.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(s.contains("X-Blocked-By: Proxie\r\n"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\n"));

        // Roundtrip through the parser the proxy uses for upstream
        // responses — proves the bytes are well-formed enough to be
        // logged correctly if any future code path tries to parse them.
        let (status, headers, body, content_type) = parse_response(&bytes);
        assert_eq!(status, Some(204));
        assert_eq!(body.as_deref(), Some(""));
        assert!(content_type.is_none());
        assert!(headers
            .iter()
            .any(|(k, v)| k == "X-Blocked-By" && v == "Proxie"));
    }

    #[test]
    fn test_build_block_connect_response_is_403_forbidden() {
        // CONNECT pre-MITM block: 403 + close. We can't return 204 here
        // because the client expects a "200 Connection Established" if
        // the tunnel opened — 403 explicitly signals the tunnel was
        // refused before any upstream socket was opened.
        let bytes = build_block_connect_response_bytes();
        let s = String::from_utf8(bytes.clone()).unwrap();
        assert!(s.starts_with("HTTP/1.1 403 Forbidden\r\n"));
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(s.contains("X-Blocked-By: Proxie\r\n"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\n"));

        let (status, _h, body, _ct) = parse_response(&bytes);
        assert_eq!(status, Some(403));
        assert_eq!(body.as_deref(), Some(""));
    }

    #[test]
    fn test_block_response_bytes_differ_by_path() {
        // The HTTP-layer (204) and CONNECT-layer (403) replies must NOT
        // be the same payload — they signal different things to the
        // client. This is the load-bearing contract: don't accidentally
        // converge them in a future refactor.
        let http_bytes = build_block_http_response_bytes();
        let connect_bytes = build_block_connect_response_bytes();
        assert_ne!(http_bytes, connect_bytes);
        assert!(String::from_utf8_lossy(&http_bytes).contains("204"));
        assert!(String::from_utf8_lossy(&connect_bytes).contains("403"));
    }

    // -------------------------------------------------------------------
    // Extra v0.4.2 unit coverage — extractor / parser edge cases that
    // were previously only exercised by happy-path tests. These pin
    // behavior on malformed URLs, missing Host headers, and a number of
    // off-by-one parser edges that bit during MITM bring-up.
    // -------------------------------------------------------------------

    #[test]
    fn test_host_matches_wildcard_does_not_overmatch_unrelated_tld() {
        // *.example.com must NOT match unrelated.example.com.evil.tld —
        // host.ends_with(".example.com") is anchored to the suffix only.
        assert!(!host_matches("*.example.com", "unrelated.example.org"));
        assert!(!host_matches("*.example.com", "evilexample.com"));
        // Apex match still works.
        assert!(host_matches("*.example.com", "example.com"));
    }

    #[test]
    fn test_host_matches_empty_pattern_and_host() {
        // Empty pattern only matches empty host (exact path).
        assert!(host_matches("", ""));
        assert!(!host_matches("", "api.example.com"));
        assert!(!host_matches("api.example.com", ""));
    }

    #[test]
    fn test_extract_host_falls_back_to_unknown_when_no_url_or_header() {
        // Neither a parseable URL nor a Host: header — extractor must
        // return the literal "unknown" sentinel rather than panicking.
        let got = extract_host("/just/a/path", "GET / HTTP/1.1\r\n\r\n");
        assert_eq!(got, "unknown");
    }

    #[test]
    fn test_extract_host_uses_lowercase_host_header() {
        // Some clients send `host:` lowercase — the fallback path must
        // still accept it.
        let req = "GET /foo HTTP/1.1\r\nhost: api.example.com\r\n\r\n";
        assert_eq!(extract_host("/foo", req), "api.example.com");
    }

    #[test]
    fn test_extract_host_strips_port_in_url_form() {
        assert_eq!(
            extract_host("http://api.example.com:8443/v1/things", ""),
            "api.example.com"
        );
    }

    #[test]
    fn test_extract_path_handles_root_only_url() {
        // Bare `http://host` with no path — extract_path returns the
        // input verbatim (we don't synthesize "/" here; callers do).
        assert_eq!(extract_path("http://example.com"), "http://example.com");
        assert_eq!(extract_path("https://example.com"), "https://example.com");
        // With explicit / it returns just /.
        assert_eq!(extract_path("http://example.com/"), "/");
    }

    #[test]
    fn test_extract_port_rejects_non_numeric() {
        // A non-numeric :port segment can't be parsed — must return None
        // rather than panicking.
        assert!(extract_port("http://example.com:abc/path").is_none());
    }

    #[test]
    fn test_extract_port_handles_no_scheme() {
        // No http(s):// prefix → extractor short-circuits to None.
        assert!(extract_port("example.com:8080/path").is_none());
    }

    #[test]
    fn test_parse_response_with_lf_only_header_terminator_is_unparsed() {
        // We require CRLFCRLF — a bare LFLF response yields headers but
        // no body (the parser falls into the "no terminator" branch).
        let raw = b"HTTP/1.1 200 OK\nFoo: bar\n\nhello";
        let (status, _h, body, _ct) = parse_response(raw);
        // status still parses from the first line.
        assert_eq!(status, Some(200));
        // No CRLFCRLF → body is None.
        assert!(body.is_none());
    }

    #[test]
    fn test_parse_response_multi_value_header_keeps_first() {
        // Two Content-Type headers should not panic — last write wins
        // for `content_type`, both are preserved in `headers`.
        let raw =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Type: application/json\r\n\r\n{}";
        let (status, headers, body, ct) = parse_response(raw);
        assert_eq!(status, Some(200));
        assert_eq!(body.as_deref(), Some("{}"));
        assert_eq!(ct.as_deref(), Some("application/json"));
        let cts: Vec<_> = headers
            .iter()
            .filter(|(k, _)| k == "Content-Type")
            .collect();
        assert_eq!(cts.len(), 2);
    }

    #[test]
    fn test_parse_response_garbage_status_line() {
        // A status line without a numeric in the right position yields
        // status=None but the rest of the parser still succeeds.
        let raw = b"NOT-A-STATUS-LINE\r\nX-Foo: bar\r\n\r\n";
        let (status, headers, body, _ct) = parse_response(raw);
        assert!(status.is_none());
        assert_eq!(headers.len(), 1);
        assert_eq!(body.as_deref(), Some(""));
    }

    #[test]
    fn test_rewrite_for_upstream_preserves_body_bytes() {
        // The body after CRLFCRLF must survive the rewrite verbatim,
        // including binary-ish payloads — we can't lose POST data.
        let req =
            b"POST /api HTTP/1.1\r\nHost: x.test\r\nContent-Length: 4\r\n\r\n\x00\x01\x02\x03";
        let out = rewrite_for_upstream(req, "x.test");
        // The trailing 4 bytes must still be present.
        assert!(out.ends_with(&[0u8, 1, 2, 3]));
    }

    #[test]
    fn test_rewrite_for_upstream_handles_no_double_crlf() {
        // Malformed request without CRLFCRLF — rewriter must still emit
        // a well-formed envelope (header-only) without panicking.
        let req = b"GET /path HTTP/1.1\r\nHost: x.test\r\n";
        let out = rewrite_for_upstream(req, "x.test");
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("GET /path HTTP/1.1\r\n"));
        assert!(s.contains("Connection: close"));
    }

    #[test]
    fn test_rewrite_for_upstream_replaces_proxy_connection_too() {
        // Some HTTP/1.0-era clients send `Proxy-Connection:` instead of
        // `Connection:` — the rewriter normalizes both to `Connection: close`.
        let req = b"GET / HTTP/1.1\r\nHost: x.test\r\nProxy-Connection: keep-alive\r\n\r\n";
        let out = rewrite_for_upstream(req, "x.test");
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("Connection: close"));
        assert!(!s.contains("Proxy-Connection: keep-alive"));
    }

    #[test]
    fn test_build_mock_response_path_pattern_matches_intercept_dispatch() {
        // Sanity check for the dispatch shape that `state.find_intercept_rule`
        // sees — the host/path matcher must agree with the intercept
        // rule's expected match shape so the mock-builder runs.
        assert!(host_matches("*.example.com", "api.example.com"));
        // Path is matched in state.rs; here we just confirm the host
        // half (the one this module owns).
        assert!(!host_matches("api.example.com", "api.example.org"));
    }

    #[test]
    fn test_build_mock_response_with_empty_body_still_well_formed() {
        // A mock with text = None must still emit a header/body separator
        // and Content-Length: 0.
        let action = InterceptAction::Mock {
            response: HarResponse {
                status: 204,
                status_text: "No Content".to_string(),
                headers: vec![],
                content: HarContent {
                    size: 0,
                    mime_type: "text/plain".to_string(),
                    text: None,
                },
            },
        };
        let resp = build_mock_response(&action).unwrap();
        let s = String::from_utf8(resp).unwrap();
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    // ---------------------------------------------------------------
    // v0.4.3 — parse_response decoding (chunked / gzip / br / binary)
    // ---------------------------------------------------------------

    #[test]
    fn test_is_text_content_type_covers_common_text_mimes() {
        assert!(is_text_content_type(Some("text/html")));
        assert!(is_text_content_type(Some("text/plain; charset=utf-8")));
        assert!(is_text_content_type(Some("application/json")));
        assert!(is_text_content_type(Some("application/json; charset=utf-8")));
        assert!(is_text_content_type(Some("application/javascript")));
        assert!(is_text_content_type(Some("application/xml")));
        assert!(is_text_content_type(Some("application/vnd.api+json")));
        assert!(is_text_content_type(Some("image/svg+xml")));
        // Unknown content type defaults to text (preserves pre-v0.4.3 shape).
        assert!(is_text_content_type(None));
        // Binary types
        assert!(!is_text_content_type(Some("image/png")));
        assert!(!is_text_content_type(Some("image/jpeg")));
        assert!(!is_text_content_type(Some("video/mp4")));
        assert!(!is_text_content_type(Some("application/octet-stream")));
        assert!(!is_text_content_type(Some("application/pdf")));
    }

    #[test]
    fn test_encode_body_binary_emits_data_uri() {
        let png_magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let out = encode_body_for_log(&png_magic, Some("image/png"));
        assert!(out.starts_with("data:image/png;base64,"));
        // The decoded base64 must round-trip back to the original bytes.
        use base64::Engine as _;
        let b64 = out.strip_prefix("data:image/png;base64,").unwrap();
        let back = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(back, png_magic);
    }

    #[test]
    fn test_encode_body_text_returns_utf8_string() {
        let out = encode_body_for_log(b"{\"ok\":true}", Some("application/json"));
        assert_eq!(out, "{\"ok\":true}");
    }

    #[test]
    fn test_decode_chunked_basic() {
        // RFC 7230 example: two chunks then 0-length terminator.
        let raw = b"5\r\nHello\r\n6\r\n World\r\n0\r\n";
        let out = decode_chunked(raw).expect("valid chunked input");
        assert_eq!(out, b"Hello World");
    }

    #[test]
    fn test_decode_chunked_with_extension() {
        // Chunk extension after ';' should be tolerated.
        let raw = b"5;ext=foo\r\nHello\r\n0\r\n";
        let out = decode_chunked(raw).expect("valid chunked input with ext");
        assert_eq!(out, b"Hello");
    }

    #[test]
    fn test_decode_chunked_malformed_returns_none() {
        // Missing CRLF after chunk data.
        let raw = b"5\r\nHello0\r\n";
        assert!(decode_chunked(raw).is_none());
    }

    #[test]
    fn test_parse_response_decompresses_gzip_text() {
        use flate2::write::GzEncoder;
        use std::io::Write as _;
        let mut enc = GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"{\"hello\":\"world\"}").unwrap();
        let compressed = enc.finish().unwrap();

        let mut raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\n\r\n".to_vec();
        raw.extend_from_slice(&compressed);

        let (status, _h, body, ct) = parse_response(&raw);
        assert_eq!(status, Some(200));
        assert_eq!(ct.as_deref(), Some("application/json"));
        assert_eq!(body.as_deref(), Some("{\"hello\":\"world\"}"));
    }

    #[test]
    fn test_parse_response_decompresses_brotli_text() {
        let mut compressed = Vec::new();
        {
            use std::io::Write as _;
            let mut writer =
                brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            writer.write_all(b"<h1>hello</h1>").unwrap();
        }
        let mut raw =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: br\r\n\r\n".to_vec();
        raw.extend_from_slice(&compressed);

        let (_status, _h, body, _ct) = parse_response(&raw);
        assert_eq!(body.as_deref(), Some("<h1>hello</h1>"));
    }

    #[test]
    fn test_parse_response_dechunks_then_returns_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nHello\r\n6\r\n World\r\n0\r\n";
        let (_status, _h, body, _ct) = parse_response(raw);
        assert_eq!(body.as_deref(), Some("Hello World"));
    }

    #[test]
    fn test_parse_response_binary_emits_data_uri() {
        // GIF89a magic bytes — a known-binary content type. The parser
        // must base64-encode them and prefix with the data: URI scheme
        // so the frontend can render via <img>.
        let mut raw = b"HTTP/1.1 200 OK\r\nContent-Type: image/gif\r\n\r\n".to_vec();
        let body_bytes: &[u8] = &[
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00,
        ];
        raw.extend_from_slice(body_bytes);

        let (_status, _h, body, _ct) = parse_response(&raw);
        let body = body.expect("body present");
        assert!(body.starts_with("data:image/gif;base64,"));
    }

    #[test]
    fn test_parse_response_unknown_content_encoding_falls_back_to_raw() {
        // An unknown Content-Encoding must NOT panic — fall back to the
        // raw bytes as text (then base64 if binary content-type).
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: pied-piper\r\n\r\nhello";
        let (_status, _h, body, _ct) = parse_response(raw);
        assert_eq!(body.as_deref(), Some("hello"));
    }

    #[test]
    fn test_classify_tls_failure_eof_marks_pinning() {
        let e = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "tls handshake eof");
        let note = classify_tls_failure(&e);
        assert!(
            note.contains("pinning"),
            "EOF should be classified as pinning, got: {}",
            note
        );
    }

    #[test]
    fn test_classify_tls_failure_bad_certificate_marks_trust_store() {
        let e = std::io::Error::other("alert bad certificate received");
        let note = classify_tls_failure(&e);
        assert!(
            note.contains("trust store"),
            "bad certificate should be classified as trust-store issue, got: {}",
            note
        );
    }

    #[test]
    fn test_classify_tls_failure_unknown_falls_back() {
        let e = std::io::Error::other("something else entirely");
        let note = classify_tls_failure(&e);
        assert!(
            note.contains("CA"),
            "unknown errors should still hint at the CA, got: {}",
            note
        );
    }

    #[test]
    fn test_build_ping_response_body_shape() {
        // `/ping` reply is a tiny JSON status blob. Assert all four keys
        // are present, well-formed, and carry the expected values so the
        // contract stays stable for any future client (curl, browser, k6).
        let body = build_ping_response_body("127.0.0.1", 39871);
        let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(v["proxy"], "proxie");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["listen"], "127.0.0.1:39871");
        // Version must be a non-empty string sourced from CARGO_PKG_VERSION.
        let version = v["version"].as_str().expect("version is a string");
        assert!(!version.is_empty(), "version should be non-empty");
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn test_host_header_matches_listen_bare_and_full() {
        let req_bare = "GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let req_full = "GET /ping HTTP/1.1\r\nHost: 127.0.0.1:39871\r\n\r\n";
        let req_other = "GET /ping HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let req_none = "GET /ping HTTP/1.1\r\n\r\n";
        assert!(host_header_matches_listen(req_bare, "127.0.0.1", 39871));
        assert!(host_header_matches_listen(req_full, "127.0.0.1", 39871));
        assert!(!host_header_matches_listen(req_other, "127.0.0.1", 39871));
        assert!(!host_header_matches_listen(req_none, "127.0.0.1", 39871));
        // Wrong port on the Host header must NOT match.
        assert!(!host_header_matches_listen(req_full, "127.0.0.1", 1234));
    }
}
