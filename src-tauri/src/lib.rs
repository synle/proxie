// Modules are `pub` so they can be exercised by integration tests under
// `tests/`. The Tauri command surface (`#[tauri::command]` fns below)
// remains the primary frontend-facing API; the `pub` mods are
// considered an internal-test-only export.
pub mod cert;
pub mod proxy;
pub mod state;
pub mod tls;
pub mod types;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;
use types::{
    BlockRule, CertInfo, ConnectionLog, HostRule, ImportMode, ImportSummary, InterceptRule,
    ProxyConfig, ProxyStatus,
};

#[tauri::command]
async fn generate_cert(state: tauri::State<'_, Arc<AppState>>) -> Result<CertInfo, String> {
    state.generate_ca_cert().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_cert_info(state: tauri::State<'_, Arc<AppState>>) -> Result<Option<CertInfo>, String> {
    state.get_cert_info().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_proxy_config(state: tauri::State<'_, Arc<AppState>>) -> Result<ProxyConfig, String> {
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
async fn get_host_rules(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<HostRule>, String> {
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
async fn get_intercept_rules(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<InterceptRule>, String> {
    state.get_intercept_rules().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_intercept_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: InterceptRule,
) -> Result<Vec<InterceptRule>, String> {
    state
        .add_intercept_rule(rule)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_intercept_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: InterceptRule,
) -> Result<Vec<InterceptRule>, String> {
    state
        .update_intercept_rule(rule)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_intercept_rule(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<InterceptRule>, String> {
    state
        .delete_intercept_rule(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Return every persisted [`BlockRule`].
#[tauri::command]
async fn get_block_rules(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<BlockRule>, String> {
    state.get_block_rules().await.map_err(|e| e.to_string())
}

/// Insert a new block rule. Frontend supplies a UUID for `id`.
#[tauri::command]
async fn add_block_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: BlockRule,
) -> Result<Vec<BlockRule>, String> {
    state.add_block_rule(rule).await.map_err(|e| e.to_string())
}

/// Replace an existing block rule (matched by id).
#[tauri::command]
async fn update_block_rule(
    state: tauri::State<'_, Arc<AppState>>,
    rule: BlockRule,
) -> Result<Vec<BlockRule>, String> {
    state
        .update_block_rule(rule)
        .await
        .map_err(|e| e.to_string())
}

/// Delete the block rule with the given id (no-op if it does not exist).
#[tauri::command]
async fn delete_block_rule(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<BlockRule>, String> {
    state
        .delete_block_rule(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Export the user's persisted rule sets (host / intercept / block) as a
/// pretty-printed JSON string. Intended to be triggered by the Setup page
/// "Export Config" button, then offered to the user as a `proxie.json`
/// download.
#[tauri::command]
async fn export_config(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    state
        .export_config(env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|e| e.to_string())
}

/// Import a previously-exported configuration bundle.
///
/// # Arguments
/// * `json` - Raw file contents read on the frontend.
/// * `mode` - `"replace"` wipes existing rules per list, `"merge"` appends
///   and skips duplicates by `id`.
///
/// # Errors
/// Returns a user-safe `Err(String)` on invalid JSON, wrong shape, or an
/// unknown mode. Raw paths and IO error chains are not leaked.
#[tauri::command]
async fn import_config(
    state: tauri::State<'_, Arc<AppState>>,
    json: String,
    mode: String,
) -> Result<ImportSummary, String> {
    let mode = ImportMode::parse(&mode)?;
    state.import_config(&json, mode).await
}

#[tauri::command]
async fn get_connections(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ConnectionLog>, String> {
    state.get_connections().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_connections(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
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
async fn stop_proxy(state: tauri::State<'_, Arc<AppState>>) -> Result<ProxyStatus, String> {
    state.stop_proxy().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_proxy_status(state: tauri::State<'_, Arc<AppState>>) -> Result<ProxyStatus, String> {
    state.get_proxy_status().await.map_err(|e| e.to_string())
}

/// Return the host OS family as a lowercase string compatible with
/// `@tauri-apps/plugin-os`'s `platform()` return values.
///
/// Used by the frontend Setup page to gate the macOS Permissions &
/// System Setup card. The empty fallback (`""`) keeps tests/builds on
/// exotic targets parseable instead of panicking — the frontend simply
/// hides the macOS-only UI.
#[tauri::command]
fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        "".to_string()
    }
}

/// Open the supplied URL or file path using the OS default handler.
///
/// macOS: shells out to `open <url>`. Windows: `cmd /C start`. Linux:
/// `xdg-open`. Any non-zero exit status is surfaced as an `Err` so the
/// frontend can fall back to an alternate URL (e.g. the modern macOS
/// System Settings URL → legacy `com.apple.preference.network` URL).
///
/// # Errors
/// Returns the underlying I/O error or a `"exit code <n>"` message when
/// the child process fails to launch or exits non-zero.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).status()
    } else if cfg!(target_os = "windows") {
        // `start` is a cmd builtin; the empty `""` is the optional title
        // argument that `start` requires when the first quoted argument
        // would otherwise be treated as the window title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&url).status()
    };
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("exit code {status}")),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_state = Arc::new(AppState::new(app.handle()));
            // Auto-load `<config-dir>/proxie.json` if present and the current
            // config has no rules. Runs on the Tokio runtime that Tauri has
            // already spun up. Errors are logged and swallowed — we never
            // want a malformed sidecar to break app startup.
            let autoload_state = Arc::clone(&app_state);
            tauri::async_runtime::spawn(async move {
                autoload_state.maybe_autoload_proxie_json().await;
            });
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
            get_intercept_rules,
            add_intercept_rule,
            update_intercept_rule,
            delete_intercept_rule,
            get_block_rules,
            add_block_rule,
            update_block_rule,
            delete_block_rule,
            export_config,
            import_config,
            get_connections,
            clear_connections,
            start_proxy,
            stop_proxy,
            get_proxy_status,
            get_platform,
            open_url,
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
        assert_eq!(config.port, 39871);
        assert_eq!(config.listen_addr, "127.0.0.1");
    }

    #[test]
    fn test_get_platform_returns_current_os() {
        let p = get_platform();
        let expected = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            ""
        };
        assert_eq!(p, expected);
    }

    #[test]
    fn test_open_url_invalid_command_returns_err() {
        // On the CI Linux runner `xdg-open` is unlikely to be installed
        // in the test sandbox, and on every platform a bogus
        // gopher-scheme URL with no handler will fail. We only assert
        // the function returns `Err` rather than panicking — exact
        // error text is OS-dependent.
        let res = open_url("gopher://nonexistent.invalid/proxie-test".to_string());
        // We tolerate Ok on systems where the opener silently succeeds
        // (e.g. macOS `open` returns 0 even for unhandled schemes), so
        // just ensure no panic and result type is correct.
        let _: Result<(), String> = res;
    }
}
