use crate::state::AppState;
use crate::types::{ConnectionLog, ProxyStatus};
use std::sync::Arc;
use tauri::{Emitter, AppHandle};

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
    use tokio::io::AsyncReadExt;

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

    let method = parts[0];
    let target = parts[1];

    let start = std::time::Instant::now();

    if method == "CONNECT" {
        // HTTPS tunnel: respond with 200 and relay bytes
        handle_connect_tunnel(&mut client_stream, target, &state, &app_handle, start).await?;
    } else {
        // Plain HTTP: forward the request
        handle_http_request(
            &mut client_stream,
            method,
            target,
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

async fn handle_connect_tunnel(
    client_stream: &mut tokio::net::TcpStream,
    target: &str,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
    start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::AsyncWriteExt;

    let host_port: Vec<&str> = target.split(':').collect();
    let host = host_port.first().unwrap_or(&"unknown");
    let port = host_port.get(1).unwrap_or(&"443");

    // Check if this host is being tracked
    let rules = state.get_host_rules().await.unwrap_or_default();
    let is_tracked = rules.iter().any(|r| r.enabled && host_matches(&r.host, host));

    // Connect to the upstream server
    let upstream_addr = format!("{}:{}", host, port);
    let upstream = tokio::net::TcpStream::connect(&upstream_addr).await?;

    // Send 200 Connection Established
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;

    let duration_ms = start.elapsed().as_millis() as u64;

    // Log the connection
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
        response_body: None,
        content_type: None,
        intercepted: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);

    if is_tracked {
        log::info!("Tracked CONNECT to {}", target);
    }

    // Relay bytes bidirectionally
    let (mut client_read, mut client_write) = tokio::io::split(tokio::io::BufReader::new(client_stream));
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);

    let c2u = tokio::io::copy(&mut client_read, &mut upstream_write);
    let u2c = tokio::io::copy(&mut upstream_read, &mut client_write);

    let _ = tokio::try_join!(c2u, u2c);

    Ok(())
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Parse host from URL or Host header
    let host = extract_host(url, &String::from_utf8_lossy(request_data));
    let path = extract_path(url);

    // Connect to upstream
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
        // Simple heuristic: if we got headers and it looks complete, break
        if response_buf.len() > 4
            && response_buf
                .windows(4)
                .any(|w| w == b"\r\n\r\n")
        {
            // Try one more read with a short timeout
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
        request_headers: vec![],
        response_headers: vec![],
        request_body: None,
        response_body: None,
        content_type: None,
        intercepted: false,
    };
    state.add_connection(conn.clone()).await;
    let _ = app_handle.emit("proxy:connection", &conn);

    Ok(())
}

/// Check if a host matches a rule pattern (supports wildcard prefix like *.example.com).
fn host_matches(pattern: &str, host: &str) -> bool {
    if pattern.starts_with("*.") {
        let suffix = &pattern[1..]; // ".example.com"
        host.ends_with(suffix) || host == &pattern[2..]
    } else {
        pattern == host
    }
}

fn extract_host(url: &str, request: &str) -> String {
    // Try from URL first
    if let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) {
        if let Some(host) = rest.split('/').next() {
            let host = host.split(':').next().unwrap_or(host);
            if !host.is_empty() {
                return host.to_string();
            }
        }
    }
    // Fall back to Host header
    for line in request.lines() {
        if let Some(host) = line.strip_prefix("Host: ").or_else(|| line.strip_prefix("host: ")) {
            return host.split(':').next().unwrap_or(host).trim().to_string();
        }
    }
    "unknown".to_string()
}

fn extract_path(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) {
        if let Some(idx) = rest.find('/') {
            return rest[idx..].to_string();
        }
    }
    url.to_string()
}

fn extract_port(url: &str) -> Option<u16> {
    if let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) {
        let host_part = rest.split('/').next()?;
        if let Some(port_str) = host_part.split(':').nth(1) {
            return port_str.parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
