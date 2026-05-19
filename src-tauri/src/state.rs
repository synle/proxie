use crate::cert;
use crate::tls::LeafCertCache;
use crate::types::{
    BlockRule, CertInfo, ConfigExport, ConnectionLog, HostRule, ImportMode, ImportSummary,
    InterceptRule, ProxyConfig, ProxyStatus,
};
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
    #[serde(default)]
    intercept_rules: Vec<InterceptRule>,
    /// Pi-hole style host/path blockers. Added in v0.4.0.
    #[serde(default)]
    block_rules: Vec<BlockRule>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            proxy_config: ProxyConfig::default(),
            host_rules: Vec::new(),
            intercept_rules: Vec::new(),
            block_rules: Vec::new(),
        }
    }
}

pub struct AppState {
    persisted: Mutex<PersistedState>,
    connections: Mutex<Vec<ConnectionLog>>,
    proxy_status: Mutex<ProxyStatus>,
    shutdown_notify: Arc<Notify>,
    /// Lazily-initialized per-host leaf cert cache for MITM TLS termination.
    ///
    /// `None` means the CA hasn't been generated/installed yet — the proxy
    /// falls back to a blind tunnel in that case. The outer Mutex is locked
    /// only during init and replacement (cheap); the inner `Arc<LeafCertCache>`
    /// is what callers actually use.
    leaf_cache: Mutex<Option<Arc<LeafCertCache>>>,
    _app_handle: AppHandle,
}

impl AppState {
    /// Build a new AppState bound to the given Tauri AppHandle.
    ///
    /// # Arguments
    /// * `app_handle` - Handle used by emitters / future Tauri-side helpers.
    pub fn new(app_handle: &AppHandle) -> Self {
        let persisted = Self::load_persisted_state();
        Self {
            persisted: Mutex::new(persisted),
            connections: Mutex::new(Vec::new()),
            proxy_status: Mutex::new(ProxyStatus::default()),
            shutdown_notify: Arc::new(Notify::new()),
            leaf_cache: Mutex::new(None),
            _app_handle: app_handle.clone(),
        }
    }

    /// Fetch the leaf cert cache, lazily loading the CA from disk on the first
    /// call. Returns `None` if the CA hasn't been generated yet (proxy then
    /// falls back to a blind CONNECT tunnel).
    ///
    /// # Returns
    /// `Some(Arc<LeafCertCache>)` if the CA loaded successfully, `None` if it
    /// is missing or fails to parse. Errors are logged at warning level.
    pub async fn get_or_init_leaf_cache(&self) -> Option<Arc<LeafCertCache>> {
        let mut guard = self.leaf_cache.lock().await;
        if let Some(c) = guard.as_ref() {
            return Some(Arc::clone(c));
        }
        if !cert::ca_cert_path().exists() || !cert::ca_key_path().exists() {
            return None;
        }
        match LeafCertCache::from_disk() {
            Ok(cache) => {
                let arc = Arc::new(cache);
                *guard = Some(Arc::clone(&arc));
                Some(arc)
            }
            Err(e) => {
                log::warn!("failed to load Proxie CA for MITM: {}", e);
                None
            }
        }
    }

    /// Invalidate the leaf cache (call after regenerating the CA so the
    /// proxy re-reads the new key+cert).
    pub async fn invalidate_leaf_cache(&self) {
        let mut guard = self.leaf_cache.lock().await;
        *guard = None;
    }

    pub(crate) fn config_path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("proxie").join("config.json")
    }

    /// Path to the side-car `proxie.json` used by the auto-load-on-startup
    /// flow. Sits next to `config.json` so users can drop a shared bundle
    /// in (e.g. a teammate's export) and have it picked up automatically
    /// when no config exists yet. See [`AppState::maybe_autoload_proxie_json`].
    pub(crate) fn proxie_json_path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("proxie").join("proxie.json")
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

    /// Generate a new Proxie CA on disk and invalidate any cached leaf certs
    /// so subsequent connections pick up the new root.
    pub async fn generate_ca_cert(&self) -> Result<CertInfo, Box<dyn std::error::Error>> {
        let info = cert::generate_ca()?;
        self.invalidate_leaf_cache().await;
        Ok(info)
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

    // Intercept rules
    pub async fn get_intercept_rules(
        &self,
    ) -> Result<Vec<InterceptRule>, Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        Ok(state.intercept_rules.clone())
    }

    pub async fn add_intercept_rule(
        &self,
        rule: InterceptRule,
    ) -> Result<Vec<InterceptRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.intercept_rules.push(rule);
        }
        self.save().await?;
        self.get_intercept_rules().await
    }

    pub async fn update_intercept_rule(
        &self,
        rule: InterceptRule,
    ) -> Result<Vec<InterceptRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            if let Some(existing) = state.intercept_rules.iter_mut().find(|r| r.id == rule.id) {
                *existing = rule;
            }
        }
        self.save().await?;
        self.get_intercept_rules().await
    }

    pub async fn delete_intercept_rule(
        &self,
        id: &str,
    ) -> Result<Vec<InterceptRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.intercept_rules.retain(|r| r.id != id);
        }
        self.save().await?;
        self.get_intercept_rules().await
    }

    // Block rules (Pi-hole style host/path blockers — added v0.4.0).

    /// Return every persisted block rule (enabled and disabled).
    ///
    /// # Returns
    /// A cloned vector so the caller doesn't hold the persisted-state lock
    /// past the call.
    pub async fn get_block_rules(&self) -> Result<Vec<BlockRule>, Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        Ok(state.block_rules.clone())
    }

    /// Insert a new block rule and persist the change.
    ///
    /// # Arguments
    /// * `rule` - Caller-supplied [`BlockRule`]. `host_pattern` must be
    ///   non-empty after trimming (rule 21 — validate input shape).
    ///
    /// # Errors
    /// Returns an error string when `host_pattern` is empty/whitespace, or
    /// when the on-disk save fails.
    pub async fn add_block_rule(
        &self,
        rule: BlockRule,
    ) -> Result<Vec<BlockRule>, Box<dyn std::error::Error>> {
        if rule.host_pattern.trim().is_empty() {
            return Err("host_pattern must be non-empty".into());
        }
        {
            let mut state = self.persisted.lock().await;
            state.block_rules.push(rule);
        }
        self.save().await?;
        self.get_block_rules().await
    }

    /// Replace an existing block rule (matched by id) in-place. No-op when
    /// no rule with the given id exists.
    pub async fn update_block_rule(
        &self,
        rule: BlockRule,
    ) -> Result<Vec<BlockRule>, Box<dyn std::error::Error>> {
        if rule.host_pattern.trim().is_empty() {
            return Err("host_pattern must be non-empty".into());
        }
        {
            let mut state = self.persisted.lock().await;
            if let Some(existing) = state.block_rules.iter_mut().find(|r| r.id == rule.id) {
                *existing = rule;
            }
        }
        self.save().await?;
        self.get_block_rules().await
    }

    /// Remove the block rule whose `id` matches and persist.
    pub async fn delete_block_rule(
        &self,
        id: &str,
    ) -> Result<Vec<BlockRule>, Box<dyn std::error::Error>> {
        {
            let mut state = self.persisted.lock().await;
            state.block_rules.retain(|r| r.id != id);
        }
        self.save().await?;
        self.get_block_rules().await
    }

    /// Find the first enabled block rule that matches `host` and `path`.
    ///
    /// Host matches use the shared [`crate::proxy::host_matches`] helper so
    /// wildcard patterns (`*.example.com`) work identically to host-tracking
    /// rules. If a rule has `path_pattern: Some(p)`, the path is checked
    /// against `p` via [`path_matches`]; when `path_pattern` is `None`, every
    /// path on the matched host is treated as blocked.
    ///
    /// # Arguments
    /// * `host` - Request host (e.g. `ads.doubleclick.net`).
    /// * `path` - Origin-form request path. For CONNECT pre-checks, callers
    ///   pass `"/"`, so host-only rules still match before any upstream
    ///   socket is opened.
    ///
    /// # Returns
    /// `Some(rule)` for the first enabled match in insertion order, `None`
    /// when nothing matches or the rule is disabled.
    pub async fn find_block_rule(&self, host: &str, path: &str) -> Option<BlockRule> {
        let state = self.persisted.lock().await;
        state
            .block_rules
            .iter()
            .find(|r| block_rule_matches(r, host, path))
            .cloned()
    }

    /// Find a matching intercept rule for a given request.
    pub async fn find_intercept_rule(
        &self,
        host: &str,
        path: &str,
        method: &str,
    ) -> Option<InterceptRule> {
        let state = self.persisted.lock().await;
        state
            .intercept_rules
            .iter()
            .find(|r| {
                if !r.enabled {
                    return false;
                }
                if !crate::proxy::host_matches(&r.match_host, host) {
                    return false;
                }
                if !path_matches(&r.match_path, path) {
                    return false;
                }
                if let Some(ref m) = r.match_method {
                    if m.to_uppercase() != method.to_uppercase() {
                        return false;
                    }
                }
                true
            })
            .cloned()
    }

    // Config import / export (v0.4.4)

    /// Build a [`ConfigExport`] snapshot of the user's rule sets plus
    /// provenance (version + timestamp). The result is intended to be
    /// pretty-JSON serialized and offered as a `proxie.json` download to the
    /// user.
    ///
    /// # Arguments
    /// * `version` - String tag stamped into the export (typically
    ///   `env!("CARGO_PKG_VERSION")` from the caller).
    ///
    /// # Returns
    /// `Ok(String)` containing pretty-printed JSON. `Err` only on the
    /// extremely unlikely serde failure path.
    pub async fn export_config(
        &self,
        version: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let state = self.persisted.lock().await;
        let export = build_export(&state, version);
        let json = serde_json::to_string_pretty(&export)?;
        Ok(json)
    }

    /// Apply an import payload to the persisted state and save to disk.
    ///
    /// Validates that the payload is a JSON object with the expected shape
    /// before mutating anything (rule 22 — check input shape first). On
    /// success the new state is persisted via [`AppState::save`].
    ///
    /// # Arguments
    /// * `json` - Raw JSON string supplied by the frontend (file contents).
    /// * `mode` - [`ImportMode::Replace`] wipes per-list before applying;
    ///   [`ImportMode::Merge`] appends, skipping rules with an existing `id`.
    ///
    /// # Returns
    /// [`ImportSummary`] with per-list counts of rules actually added.
    ///
    /// # Errors
    /// `Err(String)` with a user-safe description when:
    /// * the input is not valid JSON,
    /// * the top-level value is not a JSON object,
    /// * deserialization into [`ConfigExport`] fails.
    /// Raw paths or internal IO errors are NOT leaked into the message.
    pub async fn import_config(
        &self,
        json: &str,
        mode: ImportMode,
    ) -> Result<ImportSummary, String> {
        let parsed: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| format!("invalid JSON: {}", e))?;
        if !parsed.is_object() {
            return Err("expected a JSON object at the top level".to_string());
        }
        let export: ConfigExport = serde_json::from_value(parsed)
            .map_err(|e| format!("invalid config shape: {}", e))?;
        let summary = {
            let mut state = self.persisted.lock().await;
            apply_import(&mut state, mode, export)
        };
        self.save().await.map_err(|_| {
            // Don't leak the on-disk path or raw IO error to the user (rule 16).
            "failed to persist imported config".to_string()
        })?;
        Ok(summary)
    }

    /// Auto-load `proxie.json` from the config directory when it exists AND
    /// the current persisted state has no rules of any kind (host / intercept
    /// / block). Used at app startup so a freshly-installed Proxie can pick
    /// up a teammate's shared bundle without going through the UI.
    ///
    /// Always uses merge mode (idempotent). All outcomes are logged to stderr
    /// — failure here must never break startup.
    ///
    /// # Returns
    /// `Some(ImportSummary)` when an import ran successfully, `None` when no
    /// file exists, the state already has rules, or any step failed.
    pub async fn maybe_autoload_proxie_json(&self) -> Option<ImportSummary> {
        let path = Self::proxie_json_path();
        if !path.exists() {
            return None;
        }
        let has_rules = {
            let state = self.persisted.lock().await;
            !state.host_rules.is_empty()
                || !state.intercept_rules.is_empty()
                || !state.block_rules.is_empty()
        };
        let config_exists = Self::config_path().exists();
        if config_exists && has_rules {
            eprintln!(
                "proxie: skipping proxie.json auto-load (existing config has rules)"
            );
            return None;
        }
        let json = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("proxie: failed to read proxie.json: {}", e);
                return None;
            }
        };
        match self.import_config(&json, ImportMode::Merge).await {
            Ok(summary) => {
                eprintln!(
                    "proxie: auto-loaded proxie.json (host={}, intercept={}, block={})",
                    summary.host_rules_added,
                    summary.intercept_rules_added,
                    summary.block_rules_added
                );
                Some(summary)
            }
            Err(e) => {
                eprintln!("proxie: failed to auto-load proxie.json: {}", e);
                None
            }
        }
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

    /// Toggle the bookmark flag on an in-memory connection log.
    ///
    /// Bookmarks are user-set "flag for further investigation" markers. Like
    /// the rest of the connection list, they live only as long as the log
    /// entry does — Proxie never persists connections to disk
    /// (see [`AppState::add_connection`] for the 10k-row cap).
    ///
    /// # Arguments
    /// * `id` - Connection log id (UUID assigned by the proxy when the
    ///   request was first observed).
    /// * `bookmarked` - New flag value.
    ///
    /// # Returns
    /// `true` when a matching connection was found and updated, `false` when
    /// no connection with that id is currently in memory (e.g. it was evicted
    /// by the 10k-row cap or a `clear_connections` call).
    pub async fn set_bookmark(&self, id: &str, bookmarked: bool) -> bool {
        let mut conns = self.connections.lock().await;
        apply_bookmark(&mut conns, id, bookmarked)
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

/// Match a path pattern against a request path.
///
/// Supports a trailing `/*` (matches the prefix or any deeper segment) and a
/// generic trailing `*` (prefix-only). A literal `*` matches every path.
/// Without a wildcard, the pattern must match the path exactly.
///
/// # Arguments
/// * `pattern` - Path pattern from a rule (e.g. `/api/*`, `/api/v*`, `/health`).
/// * `path` - The request path being checked (e.g. `/api/users/1`).
///
/// # Returns
/// `true` when `path` matches `pattern` under the rules above.
/// Pure predicate used by [`AppState::find_block_rule`]. Extracted into a
/// free function so tests can exercise the matching logic without spinning
/// up an [`AppState`] (which depends on a Tauri `AppHandle`).
///
/// # Arguments
/// * `rule` - Candidate block rule.
/// * `host` - Request host being checked.
/// * `path` - Request path (`"/"` for CONNECT pre-checks).
///
/// # Returns
/// `true` when the rule is enabled, its host pattern matches `host`, and
/// either it has no path pattern or the path pattern matches `path`.
fn block_rule_matches(rule: &BlockRule, host: &str, path: &str) -> bool {
    if !rule.enabled {
        return false;
    }
    if !crate::proxy::host_matches(&rule.host_pattern, host) {
        return false;
    }
    match &rule.path_pattern {
        Some(p) => path_matches(p, path),
        None => true,
    }
}

/// Toggle the `bookmarked` flag on the connection log whose `id` matches.
///
/// Extracted as a free function so unit tests can exercise the mutation
/// without standing up an [`AppState`] (which needs a Tauri `AppHandle`).
///
/// # Arguments
/// * `conns` - Mutable slice of in-memory connection logs.
/// * `id` - Connection log id to locate.
/// * `bookmarked` - New flag value.
///
/// # Returns
/// `true` when a matching connection was updated, `false` when no entry
/// with that id exists in `conns`.
fn apply_bookmark(conns: &mut [ConnectionLog], id: &str, bookmarked: bool) -> bool {
    if let Some(c) = conns.iter_mut().find(|c| c.id == id) {
        c.bookmarked = bookmarked;
        true
    } else {
        false
    }
}

/// Build a [`ConfigExport`] snapshot from an arbitrary [`PersistedState`].
///
/// Pure / synchronous so tests can exercise it without spinning up an
/// [`AppState`] (which requires a Tauri `AppHandle`). Stamps the current UTC
/// time as the `exported_at` field.
///
/// # Arguments
/// * `state` - Persisted state to snapshot. Borrowed only — no mutation.
/// * `version` - Caller-supplied app version string.
///
/// # Returns
/// A freshly-allocated [`ConfigExport`] cloning every rule list.
fn build_export(state: &PersistedState, version: &str) -> ConfigExport {
    ConfigExport {
        version: version.to_string(),
        exported_at: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        host_rules: state.host_rules.clone(),
        intercept_rules: state.intercept_rules.clone(),
        block_rules: state.block_rules.clone(),
    }
}

/// Fold a [`ConfigExport`] into a [`PersistedState`] under the given mode.
///
/// Pure / synchronous so tests can verify replace / merge / dedup semantics
/// without IO. Returns the per-list counts of rules actually applied.
///
/// # Arguments
/// * `state` - Mutable reference to the persisted state.
/// * `mode` - [`ImportMode::Replace`] wipes per-list first; [`ImportMode::Merge`]
///   appends and skips rules whose `id` already exists.
/// * `export` - Parsed import payload. Consumed.
///
/// # Returns
/// [`ImportSummary`] counting rules added per list. In replace mode this
/// equals the imported list length; in merge mode it excludes duplicates.
fn apply_import(
    state: &mut PersistedState,
    mode: ImportMode,
    export: ConfigExport,
) -> ImportSummary {
    let mut summary = ImportSummary::default();
    match mode {
        ImportMode::Replace => {
            summary.host_rules_added = export.host_rules.len() as u32;
            summary.intercept_rules_added = export.intercept_rules.len() as u32;
            summary.block_rules_added = export.block_rules.len() as u32;
            state.host_rules = export.host_rules;
            state.intercept_rules = export.intercept_rules;
            state.block_rules = export.block_rules;
        }
        ImportMode::Merge => {
            for rule in export.host_rules {
                if !state.host_rules.iter().any(|r| r.id == rule.id) {
                    state.host_rules.push(rule);
                    summary.host_rules_added += 1;
                }
            }
            for rule in export.intercept_rules {
                if !state.intercept_rules.iter().any(|r| r.id == rule.id) {
                    state.intercept_rules.push(rule);
                    summary.intercept_rules_added += 1;
                }
            }
            for rule in export.block_rules {
                if !state.block_rules.iter().any(|r| r.id == rule.id) {
                    state.block_rules.push(rule);
                    summary.block_rules_added += 1;
                }
            }
        }
    }
    summary
}

pub(crate) fn path_matches(pattern: &str, path: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        path == prefix || path.starts_with(&format!("{}/", prefix))
    } else if pattern.ends_with('*') {
        let prefix = &pattern[..pattern.len() - 1];
        path.starts_with(prefix)
    } else {
        pattern == path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HarResponse, InterceptAction};

    #[test]
    fn test_path_matches_exact() {
        assert!(path_matches("/api/users", "/api/users"));
        assert!(!path_matches("/api/users", "/api/other"));
    }

    #[test]
    fn test_path_matches_wildcard_suffix() {
        assert!(path_matches("/api/*", "/api/users"));
        assert!(path_matches("/api/*", "/api/users/1"));
        assert!(path_matches("/api/*", "/api"));
        assert!(!path_matches("/api/*", "/other"));
    }

    #[test]
    fn test_path_matches_star_all() {
        assert!(path_matches("*", "/anything"));
        assert!(path_matches("*", "/"));
    }

    #[test]
    fn test_path_matches_prefix_star() {
        assert!(path_matches("/api/v*", "/api/v1"));
        assert!(path_matches("/api/v*", "/api/v2/users"));
        assert!(!path_matches("/api/v*", "/api/users"));
    }

    #[test]
    fn test_persisted_state_with_intercept_rules() {
        let state = PersistedState {
            proxy_config: ProxyConfig::default(),
            host_rules: vec![],
            intercept_rules: vec![InterceptRule {
                id: "ir1".to_string(),
                name: "Mock users".to_string(),
                enabled: true,
                match_host: "api.example.com".to_string(),
                match_path: "/api/users".to_string(),
                match_method: Some("GET".to_string()),
                action: InterceptAction::Mock {
                    response: HarResponse::default(),
                },
            }],
            block_rules: vec![],
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.intercept_rules.len(), 1);
        assert_eq!(back.intercept_rules[0].name, "Mock users");
    }

    #[test]
    fn test_persisted_state_backward_compat() {
        // Old config without intercept_rules should still deserialize
        let json = r#"{"proxy_config":{"port":8899,"listen_addr":"127.0.0.1","ssl_enabled":true},"host_rules":[]}"#;
        let state: PersistedState = serde_json::from_str(json).unwrap();
        assert!(state.intercept_rules.is_empty());
    }

    #[test]
    fn test_persisted_state_default() {
        let state = PersistedState::default();
        assert_eq!(state.proxy_config.port, 39871);
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
            intercept_rules: vec![],
            block_rules: vec![BlockRule {
                id: "b1".to_string(),
                host_pattern: "*.doubleclick.net".to_string(),
                path_pattern: None,
                enabled: true,
                note: "ads".to_string(),
            }],
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy_config.port, 9000);
        assert_eq!(back.host_rules.len(), 1);
        assert_eq!(back.block_rules.len(), 1);
    }

    #[test]
    fn test_persisted_state_backward_compat_no_block_rules() {
        // A pre-v0.4.0 config (no block_rules field) must still deserialize
        // and produce an empty block_rules vector.
        let json = r#"{"proxy_config":{"port":8899,"listen_addr":"127.0.0.1","ssl_enabled":true},"host_rules":[],"intercept_rules":[]}"#;
        let state: PersistedState = serde_json::from_str(json).unwrap();
        assert!(state.block_rules.is_empty());
    }

    fn make_block_rule(host: &str, path: Option<&str>, enabled: bool) -> BlockRule {
        BlockRule {
            id: format!("br-{}", host),
            host_pattern: host.to_string(),
            path_pattern: path.map(|s| s.to_string()),
            enabled,
            note: "test".to_string(),
        }
    }

    #[test]
    fn test_block_rule_matches_exact_host_no_path() {
        let r = make_block_rule("ads.example.com", None, true);
        assert!(block_rule_matches(&r, "ads.example.com", "/"));
        assert!(block_rule_matches(&r, "ads.example.com", "/anything"));
        assert!(!block_rule_matches(&r, "other.example.com", "/"));
    }

    #[test]
    fn test_block_rule_matches_wildcard_host() {
        let r = make_block_rule("*.doubleclick.net", None, true);
        assert!(block_rule_matches(&r, "ads.doubleclick.net", "/"));
        assert!(block_rule_matches(&r, "pagead.doubleclick.net", "/foo"));
        assert!(block_rule_matches(&r, "doubleclick.net", "/"));
        assert!(!block_rule_matches(&r, "doubleclick.org", "/"));
    }

    #[test]
    fn test_block_rule_matches_with_path_pattern() {
        let r = make_block_rule("api.example.com", Some("/ads/*"), true);
        assert!(block_rule_matches(&r, "api.example.com", "/ads/banner"));
        assert!(block_rule_matches(&r, "api.example.com", "/ads"));
        // Same host but path mismatches -> not blocked.
        assert!(!block_rule_matches(&r, "api.example.com", "/users"));
    }

    #[test]
    fn test_block_rule_matches_disabled_rule_ignored() {
        // Even when host+path match, a disabled rule must not match.
        let r = make_block_rule("ads.example.com", None, false);
        assert!(!block_rule_matches(&r, "ads.example.com", "/"));
    }

    #[test]
    fn test_block_rule_matches_no_host_match_returns_false() {
        let r = make_block_rule("ads.example.com", Some("/ads/*"), true);
        assert!(!block_rule_matches(&r, "totally.unrelated.com", "/ads/foo"));
    }

    #[test]
    fn test_block_rule_matches_connect_path_root() {
        // Block rules with `path_pattern = None` must match the synthetic
        // "/" path used on the CONNECT pre-check path (so HTTPS gets blocked
        // before any upstream socket is opened).
        let r = make_block_rule("*.tracker.example", None, true);
        assert!(block_rule_matches(&r, "x.tracker.example", "/"));
    }

    #[test]
    fn test_config_path_is_reasonable() {
        let path = AppState::config_path();
        assert!(path.to_string_lossy().contains("proxie"));
        assert!(path.to_string_lossy().contains("config.json"));
    }

    // -------------------------------------------------------------------
    // v0.4.2 expanded coverage — block-rule and path-match edge cases
    // plus PersistedState backward-compat probes that didn't exist before.
    // -------------------------------------------------------------------

    #[test]
    fn test_path_matches_pattern_exact_root() {
        // Root-only pattern matches root request path.
        assert!(path_matches("/", "/"));
        assert!(!path_matches("/", "/anything"));
    }

    #[test]
    fn test_path_matches_empty_pattern_only_matches_empty_path() {
        // An empty pattern is treated as a literal exact match — only the
        // empty path satisfies it. This pins the "no wildcard, no special
        // case" branch.
        assert!(path_matches("", ""));
        assert!(!path_matches("", "/"));
    }

    #[test]
    fn test_path_matches_trailing_slash_star_only_anchors_prefix() {
        // /api/* must match /api and /api/<anything> but NOT /api-extra.
        assert!(path_matches("/api/*", "/api"));
        assert!(path_matches("/api/*", "/api/foo"));
        assert!(!path_matches("/api/*", "/api-extra"));
    }

    #[test]
    fn test_persisted_state_default_block_rules_empty() {
        // Default PersistedState carries no block rules.
        let s = PersistedState::default();
        assert!(s.block_rules.is_empty());
        assert!(s.intercept_rules.is_empty());
        assert!(s.host_rules.is_empty());
    }

    #[test]
    fn test_persisted_state_round_trip_preserves_all_fields() {
        // Full roundtrip — proxy_config + host_rules + intercept_rules +
        // block_rules. Catches accidental serde rename / drop of a field.
        let original = PersistedState {
            proxy_config: ProxyConfig {
                port: 12345,
                listen_addr: "0.0.0.0".to_string(),
                ssl_enabled: false,
            },
            host_rules: vec![HostRule {
                id: "h1".to_string(),
                host: "api.example.com".to_string(),
                enabled: true,
                ignore_paths: vec!["/health".to_string()],
            }],
            intercept_rules: vec![InterceptRule {
                id: "ir1".to_string(),
                name: "mock".to_string(),
                enabled: true,
                match_host: "api.example.com".to_string(),
                match_path: "/foo".to_string(),
                match_method: Some("GET".to_string()),
                action: InterceptAction::Mock {
                    response: HarResponse::default(),
                },
            }],
            block_rules: vec![BlockRule {
                id: "b1".to_string(),
                host_pattern: "*.tracker.com".to_string(),
                path_pattern: Some("/pixel/*".to_string()),
                enabled: false,
                note: "tracker".to_string(),
            }],
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy_config.port, 12345);
        assert!(!back.proxy_config.ssl_enabled);
        assert_eq!(back.host_rules.len(), 1);
        assert_eq!(back.intercept_rules.len(), 1);
        assert_eq!(back.block_rules.len(), 1);
        assert_eq!(
            back.block_rules[0].path_pattern.as_deref(),
            Some("/pixel/*")
        );
    }

    #[test]
    fn test_block_rule_matches_path_pattern_star_all() {
        // path_pattern = Some("*") should behave like the wildcard match
        // — every path on the host matches.
        let r = make_block_rule("api.example.com", Some("*"), true);
        assert!(block_rule_matches(&r, "api.example.com", "/anywhere"));
        assert!(block_rule_matches(&r, "api.example.com", "/"));
        // Host still has to match.
        assert!(!block_rule_matches(&r, "other.example.com", "/"));
    }

    fn make_conn(id: &str, bookmarked: bool) -> ConnectionLog {
        ConnectionLog {
            id: id.to_string(),
            method: "GET".to_string(),
            url: "https://api.example.com/x".to_string(),
            host: "api.example.com".to_string(),
            path: "/x".to_string(),
            status: Some(200),
            duration_ms: Some(1),
            request_size: Some(0),
            response_size: Some(0),
            timestamp: "2026-05-18T00:00:00Z".to_string(),
            request_headers: vec![],
            response_headers: vec![],
            request_body: None,
            response_body: None,
            content_type: None,
            intercepted: false,
            blocked: false,
            bookmarked,
        }
    }

    #[test]
    fn test_apply_bookmark_toggles_existing_connection() {
        // Round-trip: flag a connection, read it back, unflag, read it back.
        let mut conns = vec![make_conn("a", false), make_conn("b", false)];
        assert!(apply_bookmark(&mut conns, "a", true));
        assert!(conns[0].bookmarked);
        assert!(!conns[1].bookmarked);
        assert!(apply_bookmark(&mut conns, "a", false));
        assert!(!conns[0].bookmarked);
    }

    #[test]
    fn test_apply_bookmark_unknown_id_returns_false() {
        // Missing id must be a no-op + return false (rule 23 — empty/absent
        // is a distinct outcome, not a silent success).
        let mut conns = vec![make_conn("a", false)];
        assert!(!apply_bookmark(&mut conns, "missing", true));
        assert!(!conns[0].bookmarked);
    }

    // -------------------------------------------------------------------
    // v0.4.4 import / export — pure helpers exercised without AppState
    // (which requires a Tauri AppHandle).
    // -------------------------------------------------------------------

    fn make_persisted_with_rules() -> PersistedState {
        PersistedState {
            proxy_config: ProxyConfig::default(),
            host_rules: vec![
                HostRule {
                    id: "h1".to_string(),
                    host: "api.example.com".to_string(),
                    enabled: true,
                    ignore_paths: vec!["/health".to_string()],
                },
                HostRule {
                    id: "h2".to_string(),
                    host: "*.staging.example.com".to_string(),
                    enabled: false,
                    ignore_paths: vec![],
                },
            ],
            intercept_rules: vec![InterceptRule {
                id: "ir1".to_string(),
                name: "mock users".to_string(),
                enabled: true,
                match_host: "api.example.com".to_string(),
                match_path: "/api/users".to_string(),
                match_method: Some("GET".to_string()),
                action: InterceptAction::Mock {
                    response: HarResponse::default(),
                },
            }],
            block_rules: vec![BlockRule {
                id: "b1".to_string(),
                host_pattern: "*.doubleclick.net".to_string(),
                path_pattern: None,
                enabled: true,
                note: "ads".to_string(),
            }],
        }
    }

    #[test]
    fn test_build_export_includes_all_rule_sets() {
        let state = make_persisted_with_rules();
        let exp = build_export(&state, "9.9.9-test");
        assert_eq!(exp.version, "9.9.9-test");
        assert!(!exp.exported_at.is_empty());
        assert_eq!(exp.host_rules.len(), 2);
        assert_eq!(exp.intercept_rules.len(), 1);
        assert_eq!(exp.block_rules.len(), 1);
    }

    #[test]
    fn test_export_import_round_trip_replace_preserves_rules() {
        let original = make_persisted_with_rules();
        let exp = build_export(&original, "test");
        // Round-trip through JSON to simulate the wire format.
        let json = serde_json::to_string(&exp).unwrap();
        let parsed: ConfigExport = serde_json::from_str(&json).unwrap();

        // Apply to an empty state in replace mode.
        let mut target = PersistedState::default();
        let summary = apply_import(&mut target, ImportMode::Replace, parsed);

        assert_eq!(summary.host_rules_added, 2);
        assert_eq!(summary.intercept_rules_added, 1);
        assert_eq!(summary.block_rules_added, 1);
        assert_eq!(target.host_rules.len(), 2);
        assert_eq!(target.intercept_rules.len(), 1);
        assert_eq!(target.block_rules.len(), 1);
        // Verify a field survived the round-trip.
        assert_eq!(target.host_rules[0].host, "api.example.com");
        assert_eq!(target.block_rules[0].host_pattern, "*.doubleclick.net");
    }

    #[test]
    fn test_apply_import_replace_wipes_existing_rules() {
        let mut target = make_persisted_with_rules();
        let empty = ConfigExport {
            version: "test".to_string(),
            exported_at: "now".to_string(),
            host_rules: vec![],
            intercept_rules: vec![],
            block_rules: vec![],
        };
        let summary = apply_import(&mut target, ImportMode::Replace, empty);
        assert_eq!(summary.host_rules_added, 0);
        // Replace with an empty export must wipe everything.
        assert!(target.host_rules.is_empty());
        assert!(target.intercept_rules.is_empty());
        assert!(target.block_rules.is_empty());
    }

    #[test]
    fn test_apply_import_merge_dedups_by_id() {
        let mut target = make_persisted_with_rules();
        // Build an import that has one duplicate (h1) and one fresh (h3).
        let import = ConfigExport {
            version: "test".to_string(),
            exported_at: "now".to_string(),
            host_rules: vec![
                HostRule {
                    id: "h1".to_string(),
                    host: "api.example.com".to_string(),
                    enabled: true,
                    ignore_paths: vec![],
                },
                HostRule {
                    id: "h3".to_string(),
                    host: "new.example.com".to_string(),
                    enabled: true,
                    ignore_paths: vec![],
                },
            ],
            intercept_rules: vec![],
            block_rules: vec![BlockRule {
                id: "b1".to_string(), // duplicate
                host_pattern: "*.doubleclick.net".to_string(),
                path_pattern: None,
                enabled: true,
                note: "dup".to_string(),
            }],
        };
        let summary = apply_import(&mut target, ImportMode::Merge, import);
        assert_eq!(summary.host_rules_added, 1);
        assert_eq!(summary.intercept_rules_added, 0);
        assert_eq!(summary.block_rules_added, 0);
        // Original h1 is preserved; h3 appended; total = 3.
        assert_eq!(target.host_rules.len(), 3);
        assert_eq!(target.block_rules.len(), 1);
    }

    #[test]
    fn test_apply_import_merge_into_empty_adds_all() {
        let mut target = PersistedState::default();
        let import = build_export(&make_persisted_with_rules(), "test");
        let summary = apply_import(&mut target, ImportMode::Merge, import);
        assert_eq!(summary.host_rules_added, 2);
        assert_eq!(summary.intercept_rules_added, 1);
        assert_eq!(summary.block_rules_added, 1);
    }

    #[test]
    fn test_proxie_json_path_sits_next_to_config() {
        let cfg = AppState::config_path();
        let pj = AppState::proxie_json_path();
        assert_eq!(cfg.parent(), pj.parent());
        assert!(pj.to_string_lossy().ends_with("proxie.json"));
    }

    #[test]
    fn test_block_rule_matches_exact_path_pattern_rejects_prefix() {
        // An exact `/login` path_pattern must NOT match `/login/admin`.
        let r = make_block_rule("api.example.com", Some("/login"), true);
        assert!(block_rule_matches(&r, "api.example.com", "/login"));
        assert!(!block_rule_matches(&r, "api.example.com", "/login/admin"));
    }
}
