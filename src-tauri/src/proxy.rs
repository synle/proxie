use crate::state::AppState;
use crate::types::{ConnectionLog, InterceptAction, ProxyStatus};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

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
        // Plain HTTP: forward the request (or intercept)
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
    let is_tracked = rules
        .iter()
        .any(|r| r.enabled && host_matches(&r.host, host));

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
    let (mut client_read, mut client_write) =
        tokio::io::split(tokio::io::BufReader::new(client_stream));
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
        if response_buf.len() > 4
            && response_buf.windows(4).any(|w| w == b"\r\n\r\n")
        {
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    match action {
        InterceptAction::Mock { response } => {
            // Build HTTP response from HAR response object
            let body = response.content.text.as_deref().unwrap_or("");
            let body_bytes = body.as_bytes();

            let mut resp = format!(
                "HTTP/1.1 {} {}\r\n",
                response.status, response.status_text
            );

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
            };
            state.add_connection(conn.clone()).await;
            let _ = app_handle.emit("proxy:connection", &conn);

            log::info!("Intercepted {} {} -> Mock {} ", method, url, response.status);
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
                if response_buf.len() > 4
                    && response_buf.windows(4).any(|w| w == b"\r\n\r\n")
                {
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

/// Build a mock HTTP response bytes from an InterceptAction::Mock.
/// Used by the proxy engine and available for external testing/validation.
#[allow(dead_code)]
pub fn build_mock_response(action: &InterceptAction) -> Option<Vec<u8>> {
    match action {
        InterceptAction::Mock { response } => {
            let body = response.content.text.as_deref().unwrap_or("");
            let body_bytes = body.as_bytes();

            let mut resp = format!(
                "HTTP/1.1 {} {}\r\n",
                response.status, response.status_text
            );

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
}
