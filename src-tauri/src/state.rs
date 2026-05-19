use crate::cert;
use crate::tls::LeafCertCache;
use crate::types::{
    BlockRule, CertInfo, ConnectionLog, HostRule, InterceptRule, ProxyConfig, ProxyStatus,
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

    #[test]
    fn test_block_rule_matches_exact_path_pattern_rejects_prefix() {
        // An exact `/login` path_pattern must NOT match `/login/admin`.
        let r = make_block_rule("api.example.com", Some("/login"), true);
        assert!(block_rule_matches(&r, "api.example.com", "/login"));
        assert!(!block_rule_matches(&r, "api.example.com", "/login/admin"));
    }
}
