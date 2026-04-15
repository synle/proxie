mod cert;
mod proxy;
mod state;
mod types;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;
use types::{CertInfo, ConnectionLog, HostRule, ProxyConfig, ProxyStatus};

#[tauri::command]
async fn generate_cert(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CertInfo, String> {
    state.generate_ca_cert().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_cert_info(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<CertInfo>, String> {
    state.get_cert_info().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_proxy_config(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ProxyConfig, String> {
    state.get_proxy_config().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_proxy_config(
    state: tauri::State<'_, Arc<AppState>>,
    config: ProxyConfig,
) -> Result<(), String> {
    state
        .update_proxy_config(config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_host_rules(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<HostRule>, String> {
    state.get_host_rules().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_host_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: HostRule,
) -> Result<Vec<HostRule>, String> {
    state.add_host_rule(rule).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_host_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: HostRule,
) -> Result<Vec<HostRule>, String> {
    state
        .update_host_rule(rule)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_host_rule(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<HostRule>, String> {
    state.delete_host_rule(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_connections(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ConnectionLog>, String> {
    state.get_connections().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_connections(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.clear_connections().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_proxy(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ProxyStatus, String> {
    let state_clone = Arc::clone(&state);
    proxy::start_proxy(app_handle, state_clone)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_proxy(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ProxyStatus, String> {
    state.stop_proxy().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_proxy_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ProxyStatus, String> {
    state.get_proxy_status().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            let app_state = Arc::new(AppState::new(app.handle()));
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            generate_cert,
            get_cert_info,
            get_proxy_config,
            update_proxy_config,
            get_host_rules,
            add_host_rule,
            update_host_rule,
            delete_host_rule,
            get_connections,
            clear_connections,
            start_proxy,
            stop_proxy,
            get_proxy_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_types_serialization() {
        let rule = HostRule {
            id: "test-1".to_string(),
            host: "api.example.com".to_string(),
            enabled: true,
            ignore_paths: vec!["/health".to_string()],
        };
        let json = serde_json::to_string(&rule).unwrap();
        let deserialized: HostRule = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.host, "api.example.com");
        assert!(deserialized.enabled);
        assert_eq!(deserialized.ignore_paths.len(), 1);
    }

    #[test]
    fn test_proxy_config_defaults() {
        let config = ProxyConfig::default();
        assert_eq!(config.port, 8899);
        assert_eq!(config.listen_addr, "127.0.0.1");
    }
}
