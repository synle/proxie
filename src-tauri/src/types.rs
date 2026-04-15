use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertInfo {
    pub ca_cert_path: String,
    pub ca_key_path: String,
    pub fingerprint: String,
    pub created_at: String,
    pub expires_at: String,
    pub install_instructions: PlatformInstructions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInstructions {
    pub macos: String,
    pub windows: String,
    pub linux: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub port: u16,
    pub listen_addr: String,
    pub ssl_enabled: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            port: 8899,
            listen_addr: "127.0.0.1".to_string(),
            ssl_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRule {
    pub id: String,
    pub host: String,
    pub enabled: bool,
    pub ignore_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionLog {
    pub id: String,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub request_size: Option<u64>,
    pub response_size: Option<u64>,
    pub timestamp: String,
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub content_type: Option<String>,
    pub intercepted: bool,
}

/// An intercept rule defines how to handle a matched request.
/// Uses HAR-inspired response format for easy import/export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterceptRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Match criteria
    pub match_host: String,
    pub match_path: String,
    pub match_method: Option<String>,
    /// Action: "mock" returns a hardcoded response, "reroute" forwards to a different target
    pub action: InterceptAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum InterceptAction {
    /// Return a hardcoded response (HAR-inspired format)
    #[serde(rename = "mock")]
    Mock { response: HarResponse },
    /// Reroute to a different target URL
    #[serde(rename = "reroute")]
    Reroute { target_url: String },
}

/// HAR-inspired response object.
/// Follows the HAR 1.2 spec response shape for future import compatibility.
/// See: http://www.softwareishard.com/blog/har-12-spec/#response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HarHeader>,
    pub content: HarContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarContent {
    pub size: i64,
    pub mime_type: String,
    pub text: Option<String>,
}

impl Default for HarResponse {
    fn default() -> Self {
        Self {
            status: 200,
            status_text: "OK".to_string(),
            headers: vec![HarHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            content: HarContent {
                size: 0,
                mime_type: "application/json".to_string(),
                text: Some("{}".to_string()),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub listen_addr: Option<String>,
}

impl Default for ProxyStatus {
    fn default() -> Self {
        Self {
            running: false,
            port: None,
            listen_addr: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_config_default() {
        let config = ProxyConfig::default();
        assert_eq!(config.port, 8899);
        assert_eq!(config.listen_addr, "127.0.0.1");
        assert!(config.ssl_enabled);
    }

    #[test]
    fn test_proxy_status_default() {
        let status = ProxyStatus::default();
        assert!(!status.running);
        assert!(status.port.is_none());
    }

    #[test]
    fn test_host_rule_serde() {
        let rule = HostRule {
            id: "r1".to_string(),
            host: "*.example.com".to_string(),
            enabled: true,
            ignore_paths: vec!["/healthz".to_string(), "/metrics".to_string()],
        };
        let json = serde_json::to_string(&rule).unwrap();
        assert!(json.contains("*.example.com"));

        let back: HostRule = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ignore_paths.len(), 2);
    }

    #[test]
    fn test_connection_log_serde() {
        let log = ConnectionLog {
            id: "c1".to_string(),
            method: "GET".to_string(),
            url: "https://api.example.com/data".to_string(),
            host: "api.example.com".to_string(),
            path: "/data".to_string(),
            status: Some(200),
            duration_ms: Some(123),
            request_size: Some(0),
            response_size: Some(1024),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            request_headers: vec![("Accept".to_string(), "application/json".to_string())],
            response_headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            request_body: None,
            response_body: Some(r#"{"ok":true}"#.to_string()),
            content_type: Some("application/json".to_string()),
            intercepted: false,
        };
        let json = serde_json::to_string(&log).unwrap();
        let back: ConnectionLog = serde_json::from_str(&json).unwrap();
        assert_eq!(back.status, Some(200));
        assert_eq!(back.duration_ms, Some(123));
    }

    #[test]
    fn test_intercept_rule_mock_serde() {
        let rule = InterceptRule {
            id: "ir1".to_string(),
            name: "Mock /api/users".to_string(),
            enabled: true,
            match_host: "api.example.com".to_string(),
            match_path: "/api/users".to_string(),
            match_method: Some("GET".to_string()),
            action: InterceptAction::Mock {
                response: HarResponse {
                    status: 200,
                    status_text: "OK".to_string(),
                    headers: vec![HarHeader {
                        name: "Content-Type".to_string(),
                        value: "application/json".to_string(),
                    }],
                    content: HarContent {
                        size: 27,
                        mime_type: "application/json".to_string(),
                        text: Some(r#"{"users":["alice","bob"]}"#.to_string()),
                    },
                },
            },
        };
        let json = serde_json::to_string(&rule).unwrap();
        assert!(json.contains("\"type\":\"mock\""));
        let back: InterceptRule = serde_json::from_str(&json).unwrap();
        match &back.action {
            InterceptAction::Mock { response } => {
                assert_eq!(response.status, 200);
                assert!(response.content.text.as_ref().unwrap().contains("alice"));
            }
            _ => panic!("Expected Mock action"),
        }
    }

    #[test]
    fn test_intercept_rule_reroute_serde() {
        let rule = InterceptRule {
            id: "ir2".to_string(),
            name: "Reroute to staging".to_string(),
            enabled: true,
            match_host: "api.example.com".to_string(),
            match_path: "/api/*".to_string(),
            match_method: None,
            action: InterceptAction::Reroute {
                target_url: "https://staging.example.com".to_string(),
            },
        };
        let json = serde_json::to_string(&rule).unwrap();
        assert!(json.contains("\"type\":\"reroute\""));
        let back: InterceptRule = serde_json::from_str(&json).unwrap();
        match &back.action {
            InterceptAction::Reroute { target_url } => {
                assert_eq!(target_url, "https://staging.example.com");
            }
            _ => panic!("Expected Reroute action"),
        }
    }

    #[test]
    fn test_har_response_default() {
        let resp = HarResponse::default();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.status_text, "OK");
        assert_eq!(resp.headers.len(), 1);
        assert_eq!(resp.content.mime_type, "application/json");
    }

    #[test]
    fn test_cert_info_serde() {
        let info = CertInfo {
            ca_cert_path: "/tmp/proxie-ca.pem".to_string(),
            ca_key_path: "/tmp/proxie-ca-key.pem".to_string(),
            fingerprint: "AA:BB:CC".to_string(),
            created_at: "2026-01-01".to_string(),
            expires_at: "2027-01-01".to_string(),
            install_instructions: PlatformInstructions {
                macos: "security add-trusted-cert ...".to_string(),
                windows: "certutil -addstore ...".to_string(),
                linux: "cp ... /usr/local/share/ca-certificates/".to_string(),
            },
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: CertInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.fingerprint, "AA:BB:CC");
    }
}
