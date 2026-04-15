use crate::cert;
use crate::types::{CertInfo, ConnectionLog, HostRule, ProxyConfig, ProxyStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::{Mutex, Notify};

/// Persistent config saved to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedState {
    proxy_config: ProxyConfig,
    host_rules: Vec<HostRule>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            proxy_config: ProxyConfig::default(),
            host_rules: Vec::new(),
        }
    }
}

pub struct AppState {
    persisted: Mutex<PersistedState>,
    connections: Mutex<Vec<ConnectionLog>>,
    proxy_status: Mutex<ProxyStatus>,
    shutdown_notify: Arc<Notify>,
    _app_handle: AppHandle,
}

impl AppState {
    pub fn new(app_handle: &AppHandle) -> Self {
        let persisted = Self::load_persisted_state();
        Self {
            persisted: Mutex::new(persisted),
            connections: Mutex::new(Vec::new()),
            proxy_status: Mutex::new(ProxyStatus::default()),
            shutdown_notify: Arc::new(Notify::new()),
            _app_handle: app_handle.clone(),
        }
    }

    fn config_path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("proxie").join("config.json")
    }

    fn load_persisted_state() -> PersistedState {
        let path = Self::config_path();
        if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            PersistedState::default()
        }
    }

    async fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&*state)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    // Certificate management
    pub async fn generate_ca_cert(&self) -> Result<CertInfo, Box<dyn std::error::Error>> {
        cert::generate_ca()
    }

    pub async fn get_cert_info(&self) -> Result<Option<CertInfo>, Box<dyn std::error::Error>> {
        cert::load_cert_info()
    }

    // Proxy config
    pub async fn get_proxy_config(&self) -> Result<ProxyConfig, Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        Ok(state.proxy_config.clone())
    }

    pub async fn update_proxy_config(
        &self,
        config: ProxyConfig,
    ) -> Result<(), Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.proxy_config = config;
        }
        self.save().await
    }

    // Host rules
    pub async fn get_host_rules(&self) -> Result<Vec<HostRule>, Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        Ok(state.host_rules.clone())
    }

    pub async fn add_host_rule(
        &self,
        rule: HostRule,
    ) -> Result<Vec<HostRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.host_rules.push(rule);
        }
        self.save().await?;
        self.get_host_rules().await
    }

    pub async fn update_host_rule(
        &self,
        rule: HostRule,
    ) -> Result<Vec<HostRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            if let Some(existing) = state.host_rules.iter_mut().find(|r| r.id == rule.id) {
                *existing = rule;
            }
        }
        self.save().await?;
        self.get_host_rules().await
    }

    pub async fn delete_host_rule(
        &self,
        id: &str,
    ) -> Result<Vec<HostRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.host_rules.retain(|r| r.id != id);
        }
        self.save().await?;
        self.get_host_rules().await
    }

    // Connections
    pub async fn get_connections(&self) -> Result<Vec<ConnectionLog>, Box<dyn std::error::Error>> {
        let conns = self.connections.lock().await;
        Ok(conns.clone())
    }

    pub async fn add_connection(&self, conn: ConnectionLog) {
        let mut conns = self.connections.lock().await;
        conns.push(conn);
        // Keep last 10000 connections
        if conns.len() > 10000 {
            let drain_count = conns.len() - 10000;
            conns.drain(..drain_count);
        }
    }

    pub async fn clear_connections(&self) -> Result<(), Box<dyn std::error::Error>> {
        let mut conns = self.connections.lock().await;
        conns.clear();
        Ok(())
    }

    // Proxy lifecycle
    pub async fn set_proxy_running(&self, port: u16, addr: &str) {
        let mut status = self.proxy_status.lock().await;
        status.running = true;
        status.port = Some(port);
        status.listen_addr = Some(addr.to_string());
    }

    pub async fn stop_proxy(&self) -> Result<ProxyStatus, Box<dyn std::error::Error>> {
        self.shutdown_notify.notify_one();
        let mut status = self.proxy_status.lock().await;
        status.running = false;
        status.port = None;
        status.listen_addr = None;
        Ok(status.clone())
    }

    pub async fn get_proxy_status(&self) -> Result<ProxyStatus, Box<dyn std::error::Error>> {
        let status = self.proxy_status.lock().await;
        Ok(status.clone())
    }

    pub fn shutdown_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.shutdown_notify)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persisted_state_default() {
        let state = PersistedState::default();
        assert_eq!(state.proxy_config.port, 8899);
        assert!(state.host_rules.is_empty());
    }

    #[test]
    fn test_persisted_state_serde_roundtrip() {
        let state = PersistedState {
            proxy_config: ProxyConfig {
                port: 9000,
                listen_addr: "0.0.0.0".to_string(),
                ssl_enabled: false,
            },
            host_rules: vec![HostRule {
                id: "r1".to_string(),
                host: "example.com".to_string(),
                enabled: true,
                ignore_paths: vec![],
            }],
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy_config.port, 9000);
        assert_eq!(back.host_rules.len(), 1);
    }

    #[test]
    fn test_config_path_is_reasonable() {
        let path = AppState::config_path();
        assert!(path.to_string_lossy().contains("proxie"));
        assert!(path.to_string_lossy().contains("config.json"));
    }
}
