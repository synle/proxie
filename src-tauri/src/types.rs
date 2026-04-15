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
