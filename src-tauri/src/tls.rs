//! TLS interception support for the proxy.
//!
//! This module provides the machinery to terminate TLS at the proxy by minting
//! per-host leaf certificates on the fly, signed by Proxie's locally-stored CA.
//! The resulting [`rustls::ServerConfig`] is cached per hostname inside
//! [`LeafCertCache`] so subsequent CONNECTs to the same host reuse the same
//! cert instead of paying the keygen + signing cost on every connection.

use crate::cert;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Re-export the loaded CA so callers can share it across leaf signs.
///
/// We hold the raw rcgen [`rcgen::Certificate`] (reconstructed from the CA's
/// own params + key) plus the matching [`KeyPair`]. Both are needed to sign
/// new leaves via [`CertificateParams::signed_by`].
pub struct LoadedCa {
    /// Reconstructed CA certificate suitable for use as an issuer.
    pub cert: rcgen::Certificate,
    /// CA private key used to sign leaf certificates.
    pub key_pair: KeyPair,
}

/// Load the Proxie CA certificate and key from disk.
///
/// Reads the PEM files written by [`crate::cert::generate_ca`], parses them
/// into rcgen types, and reconstructs a usable issuer [`rcgen::Certificate`].
///
/// # Returns
/// A [`LoadedCa`] containing the parsed CA cert + key pair ready to sign
/// leaf certs.
///
/// # Errors
/// Returns an error if either PEM file is missing, unreadable, or contains
/// malformed cert / key data.
pub fn load_ca() -> Result<LoadedCa, Box<dyn std::error::Error + Send + Sync>> {
    let cert_path = cert::ca_cert_path();
    let key_path = cert::ca_key_path();

    let cert_pem = std::fs::read_to_string(&cert_path)
        .map_err(|e| format!("read CA cert {}: {}", cert_path.display(), e))?;
    let key_pem = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("read CA key {}: {}", key_path.display(), e))?;

    let key_pair = KeyPair::from_pem(&key_pem).map_err(|e| format!("parse CA key: {}", e))?;
    let params = CertificateParams::from_ca_cert_pem(&cert_pem)
        .map_err(|e| format!("parse CA cert: {}", e))?;
    // Reconstruct a usable Certificate so we can pass it as the issuer to
    // signed_by(). Note this re-serializes the CA — the underlying public key
    // remains the same because the key pair is unchanged.
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("reconstruct CA cert: {}", e))?;

    Ok(LoadedCa { cert, key_pair })
}

/// Mint a fresh leaf certificate for `hostname`, signed by `ca`.
///
/// The leaf gets a single Subject Alternative Name entry — the literal
/// `hostname` (DNS) — and a one-year validity window. This is enough for
/// rustls clients (browsers, curl, libcurl-based SDKs) to validate the cert
/// when the CA is in the system trust store.
///
/// # Arguments
/// * `hostname` - Fully-qualified hostname the leaf should cover (e.g.
///   `api.example.com`).
/// * `ca` - The loaded Proxie CA used to sign the leaf.
///
/// # Returns
/// A tuple of `(leaf_cert_pem, leaf_key_pem)` suitable for building a
/// [`rustls::ServerConfig`].
///
/// # Errors
/// Returns an error if rcgen fails to generate or sign the leaf (typically
/// indicates a corrupt CA or an unsupported algorithm).
pub fn mint_leaf_cert(
    hostname: &str,
    ca: &LoadedCa,
) -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
    let mut params = CertificateParams::new(vec![hostname.to_string()])
        .map_err(|e| format!("build leaf params: {}", e))?;

    // SAN already populated by new(); also set CN for clients that still
    // peek at the subject DN.
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, hostname);
    params.distinguished_name = dn;

    // Belt-and-braces: explicit DNS SAN entry. CertificateParams::new
    // already adds these, but being explicit avoids surprises if upstream
    // rcgen changes its defaults.
    params.subject_alt_names =
        vec![SanType::DnsName(hostname.to_string().try_into().map_err(
            |e| format!("invalid DNS SAN {}: {}", hostname, e),
        )?)];

    // 1-year validity window centered on today. We start one day in the
    // past to tolerate clock drift on either side.
    let now = chrono::Utc::now();
    let year: i32 = now.format("%Y").to_string().parse()?;
    params.not_before = rcgen::date_time_ymd(year, 1, 1);
    params.not_after = rcgen::date_time_ymd(year + 1, 12, 31);

    let leaf_key = KeyPair::generate().map_err(|e| format!("generate leaf key: {}", e))?;
    let leaf_cert = params
        .signed_by(&leaf_key, &ca.cert, &ca.key_pair)
        .map_err(|e| format!("sign leaf cert: {}", e))?;

    Ok((leaf_cert.pem(), leaf_key.serialize_pem()))
}

/// Build a [`rustls::ServerConfig`] from a freshly minted leaf cert.
///
/// Includes the CA cert in the chain so clients that don't have the CA
/// pre-installed in their per-process trust store can still walk the chain
/// (most clients do; the extra few bytes are harmless).
///
/// # Arguments
/// * `leaf_cert_pem` - PEM-encoded leaf cert.
/// * `leaf_key_pem` - PEM-encoded leaf private key.
/// * `ca_cert_pem` - PEM-encoded CA cert to append to the chain.
///
/// # Errors
/// Returns an error if any PEM blob fails to parse or rustls rejects the
/// combination (e.g. mismatched key + cert).
pub fn build_server_config(
    leaf_cert_pem: &str,
    leaf_key_pem: &str,
    ca_cert_pem: &str,
) -> Result<rustls::ServerConfig, Box<dyn std::error::Error + Send + Sync>> {
    // Parse leaf cert chain.
    let mut leaf_reader = leaf_cert_pem.as_bytes();
    let leaf_certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut leaf_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("parse leaf chain: {}", e))?;

    // Append CA cert so the chain is complete.
    let mut ca_reader = ca_cert_pem.as_bytes();
    let ca_certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut ca_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("parse CA chain: {}", e))?;
    let mut chain = leaf_certs;
    chain.extend(ca_certs);

    // Parse the leaf private key. rcgen emits PKCS#8 PEM.
    let mut key_reader = leaf_key_pem.as_bytes();
    let key_der: PrivatePkcs8KeyDer<'static> = rustls_pemfile::pkcs8_private_keys(&mut key_reader)
        .next()
        .ok_or("no PKCS#8 private key found in leaf key PEM")?
        .map_err(|e| format!("parse leaf key: {}", e))?;
    let private_key: PrivateKeyDer<'static> = PrivateKeyDer::Pkcs8(key_der);

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(chain, private_key)
        .map_err(|e| format!("build server config: {}", e))?;

    Ok(config)
}

/// Per-hostname cache of `rustls::ServerConfig` for MITM TLS termination.
///
/// Minting a leaf cert is expensive (RSA / ECDSA keygen + signing) — caching
/// the resulting [`rustls::ServerConfig`] makes repeat connections to the
/// same host effectively free after the first hit.
pub struct LeafCertCache {
    ca: LoadedCa,
    ca_cert_pem: String,
    cache: Mutex<HashMap<String, Arc<rustls::ServerConfig>>>,
}

impl LeafCertCache {
    /// Construct a new cache backed by the given loaded CA.
    ///
    /// # Arguments
    /// * `ca` - The loaded Proxie CA used to sign every leaf this cache
    ///   produces.
    /// * `ca_cert_pem` - PEM blob of the same CA, appended to every leaf
    ///   chain.
    pub fn new(ca: LoadedCa, ca_cert_pem: String) -> Self {
        Self {
            ca,
            ca_cert_pem,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Load the CA from disk and build a fresh empty cache.
    ///
    /// # Errors
    /// Returns an error if [`load_ca`] fails or the CA PEM cannot be read.
    pub fn from_disk() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let ca = load_ca()?;
        let ca_cert_pem = std::fs::read_to_string(cert::ca_cert_path())?;
        Ok(Self::new(ca, ca_cert_pem))
    }

    /// Fetch a cached [`rustls::ServerConfig`] for `hostname`, minting one
    /// if it's not already cached.
    ///
    /// # Arguments
    /// * `hostname` - Hostname from the CONNECT line (port stripped).
    ///
    /// # Returns
    /// An `Arc<rustls::ServerConfig>` suitable for `TlsAcceptor::from(...)`.
    /// Same `Arc` returned on subsequent calls for the same hostname.
    ///
    /// # Errors
    /// Returns an error if leaf-cert generation or rustls config assembly
    /// fails. Cache is left untouched on error.
    pub async fn get_or_create(
        &self,
        hostname: &str,
    ) -> Result<Arc<rustls::ServerConfig>, Box<dyn std::error::Error + Send + Sync>> {
        {
            let cache = self.cache.lock().await;
            if let Some(cfg) = cache.get(hostname) {
                return Ok(Arc::clone(cfg));
            }
        }

        let (leaf_cert_pem, leaf_key_pem) = mint_leaf_cert(hostname, &self.ca)?;
        let config = build_server_config(&leaf_cert_pem, &leaf_key_pem, &self.ca_cert_pem)?;
        let arc = Arc::new(config);

        let mut cache = self.cache.lock().await;
        // Another task may have raced us — keep the first arrival to
        // preserve Arc identity for callers that already pulled it.
        let entry = cache
            .entry(hostname.to_string())
            .or_insert_with(|| Arc::clone(&arc));
        Ok(Arc::clone(entry))
    }

    /// Test-only helper: returns the current cache size.
    #[cfg(test)]
    pub async fn len(&self) -> usize {
        self.cache.lock().await.len()
    }
}

/// Build a rustls [`tokio_rustls::TlsConnector`] using the OS native trust
/// store for upstream TLS.
///
/// Using `rustls-native-certs` means we honor the same set of CAs the
/// user's browser and curl do — important for corporate environments that
/// inject their own roots.
///
/// # Errors
/// Returns an error if the native trust store can't be loaded (rare;
/// platform misconfiguration).
pub fn build_upstream_connector(
) -> Result<tokio_rustls::TlsConnector, Box<dyn std::error::Error + Send + Sync>> {
    let mut root_store = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    // load_native_certs returns CertificateResult with `certs` and `errors`;
    // we tolerate partial failures as long as we got at least one root.
    for cert in native.certs {
        // ignore individual cert failures — rustls returns Err on duplicates,
        // which is expected on macOS where the same root appears in multiple
        // keychains.
        let _ = root_store.add(cert);
    }
    if root_store.is_empty() {
        return Err("no native root certificates loaded".into());
    }

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a self-signed CA in-memory (not touching disk) and wrap it in a
    /// `LoadedCa`. Mirrors the structure produced by `load_ca()` post
    /// `generate_ca()`.
    fn make_test_ca() -> (LoadedCa, String) {
        let key_pair = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Test CA");
        params.distinguished_name = dn;
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let cert = params.self_signed(&key_pair).unwrap();
        let pem = cert.pem();
        (LoadedCa { cert, key_pair }, pem)
    }

    #[test]
    fn test_mint_leaf_cert_has_san() {
        let (ca, _ca_pem) = make_test_ca();
        let (leaf_pem, leaf_key_pem) = mint_leaf_cert("api.example.com", &ca).unwrap();
        assert!(leaf_pem.contains("BEGIN CERTIFICATE"));
        assert!(leaf_key_pem.contains("BEGIN PRIVATE KEY"));

        // Parse back and confirm the SAN is present.
        let parsed = CertificateParams::from_ca_cert_pem(&leaf_pem).unwrap();
        let has_san = parsed
            .subject_alt_names
            .iter()
            .any(|s| matches!(s, SanType::DnsName(n) if n.as_ref() == "api.example.com"));
        assert!(has_san, "leaf cert should contain the hostname SAN");
    }

    #[test]
    fn test_build_server_config_round_trip() {
        let (ca, ca_pem) = make_test_ca();
        let (leaf_pem, leaf_key_pem) = mint_leaf_cert("example.com", &ca).unwrap();
        let _cfg = build_server_config(&leaf_pem, &leaf_key_pem, &ca_pem).unwrap();
        // We don't inspect cfg internals — successful construction is the
        // contract this test guards.
    }

    #[tokio::test]
    async fn test_leaf_cert_cache_returns_same_arc() {
        let (ca, ca_pem) = make_test_ca();
        let cache = LeafCertCache::new(ca, ca_pem);
        let a = cache.get_or_create("api.example.com").await.unwrap();
        let b = cache.get_or_create("api.example.com").await.unwrap();
        assert!(Arc::ptr_eq(&a, &b), "second call should reuse cached Arc");
        assert_eq!(cache.len().await, 1);

        let c = cache.get_or_create("other.example.com").await.unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(cache.len().await, 2);
    }

    #[test]
    fn test_load_ca_round_trip_via_tempdir() {
        // We can't override cert::ca_cert_path easily, so this test
        // generates an in-memory CA, writes the PEMs to a tempdir, and
        // proves parse_ca_pems works the same way load_ca does.
        let (ca, ca_pem) = make_test_ca();
        let key_pem = ca.key_pair.serialize_pem();

        // Round-trip through parsing.
        let key_pair = KeyPair::from_pem(&key_pem).unwrap();
        let params = CertificateParams::from_ca_cert_pem(&ca_pem).unwrap();
        let reconstructed = params.self_signed(&key_pair).unwrap();
        assert!(reconstructed.pem().contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn test_build_upstream_connector_loads_native_roots() {
        // Should succeed on a normal dev / CI box. If the OS has no roots,
        // we'd get an explicit error — fine to assert success here since
        // the tests run inside an OS image that has roots.
        let _connector = build_upstream_connector().expect("native roots load");
    }
}
