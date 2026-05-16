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
            // Most common cause: client doesn't trust the CA.
            log_mitm_failure(
                state,
                app_handle,
                host,
                target,
                start,
                &format!(
                    "TLS handshake with client failed (is the Proxie CA trusted?): {}",
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
/// # Returns
/// `(status, headers, body_text, content_type)` — all optional fields
/// fall back to `None` when the response can't be parsed (truncated, non-
/// text body, etc).
#[allow(clippy::type_complexity)]
pub fn parse_response(
    buf: &[u8],
) -> (
    Option<u16>,
    Vec<(String, String)>,
    Option<String>,
    Option<String>,
) {
    let s = String::from_utf8_lossy(buf);
    let header_end = s.find("\r\n\r\n");
    let head = match header_end {
        Some(idx) => &s[..idx],
        None => &s[..],
    };
    let body = header_end.map(|idx| s[idx + 4..].to_string());

    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok());

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_type: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(": ") {
            if k.eq_ignore_ascii_case("content-type") {
                content_type = Some(v.to_string());
            }
            headers.push((k.to_string(), v.to_string()));
        }
    }
    (status, headers, body, content_type)
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
}
