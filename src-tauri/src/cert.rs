use crate::types::{CertInfo, PlatformInstructions};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};
use std::path::PathBuf;

/// Returns the directory where Proxie stores its CA certificate and key.
pub fn cert_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("proxie").join("certs")
}

pub fn ca_cert_path() -> PathBuf {
    cert_dir().join("proxie-ca.pem")
}

pub fn ca_key_path() -> PathBuf {
    cert_dir().join("proxie-ca-key.pem")
}

/// Generate a new self-signed CA certificate for MITM HTTPS interception.
pub fn generate_ca() -> Result<CertInfo, Box<dyn std::error::Error>> {
    let dir = cert_dir();
    std::fs::create_dir_all(&dir)?;

    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Proxie CA");
    dn.push(DnType::OrganizationName, "Proxie");
    params.distinguished_name = dn;
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);

    // Valid for 10 years
    let now = chrono::Utc::now();
    let not_before = rcgen::date_time_ymd(now.format("%Y").to_string().parse()?, 1, 1);
    let not_after = rcgen::date_time_ymd(
        now.format("%Y").to_string().parse::<i32>()? + 10,
        12,
        31,
    );
    params.not_before = not_before;
    params.not_after = not_after;

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    std::fs::write(ca_cert_path(), &cert_pem)?;
    std::fs::write(ca_key_path(), &key_pem)?;

    // Compute a simple fingerprint from the first 20 bytes of the DER
    let der = cert.der();
    let fingerprint = der
        .iter()
        .take(20)
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");

    let cert_path_str = ca_cert_path().to_string_lossy().to_string();
    let install_instructions = build_install_instructions(&cert_path_str);

    Ok(CertInfo {
        ca_cert_path: cert_path_str,
        ca_key_path: ca_key_path().to_string_lossy().to_string(),
        fingerprint,
        created_at: now.format("%Y-%m-%d").to_string(),
        expires_at: format!("{}-12-31", now.format("%Y").to_string().parse::<i32>()? + 10),
        install_instructions,
    })
}

/// Load existing CA cert info from disk.
pub fn load_cert_info() -> Result<Option<CertInfo>, Box<dyn std::error::Error>> {
    let cert_path = ca_cert_path();
    let key_path = ca_key_path();

    if !cert_path.exists() || !key_path.exists() {
        return Ok(None);
    }

    let cert_pem = std::fs::read_to_string(&cert_path)?;
    let cert_path_str = cert_path.to_string_lossy().to_string();

    // Parse basic info from the PEM
    let fingerprint = cert_pem
        .as_bytes()
        .iter()
        .take(20)
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");

    let install_instructions = build_install_instructions(&cert_path_str);

    Ok(Some(CertInfo {
        ca_cert_path: cert_path_str,
        ca_key_path: key_path.to_string_lossy().to_string(),
        fingerprint,
        created_at: "unknown".to_string(),
        expires_at: "unknown".to_string(),
        install_instructions,
    }))
}

fn build_install_instructions(cert_path: &str) -> PlatformInstructions {
    PlatformInstructions {
        macos: format!(
            "# Install the CA certificate into the macOS system trust store:\nsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"{}\"\n\n# To remove later:\nsudo security remove-trusted-cert -d \"{}\"",
            cert_path, cert_path
        ),
        windows: format!(
            "# Install the CA certificate (run as Administrator):\ncertutil -addstore -f \"ROOT\" \"{}\"\n\n# To remove later:\ncertutil -delstore \"ROOT\" \"Proxie CA\"",
            cert_path
        ),
        linux: format!(
            "# Install the CA certificate (Ubuntu/Debian):\nsudo cp \"{}\" /usr/local/share/ca-certificates/proxie-ca.crt\nsudo update-ca-certificates\n\n# To remove later:\nsudo rm /usr/local/share/ca-certificates/proxie-ca.crt\nsudo update-ca-certificates --fresh",
            cert_path
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cert_dir_is_not_empty() {
        let dir = cert_dir();
        assert!(dir.to_string_lossy().contains("proxie"));
    }

    #[test]
    fn test_install_instructions_contain_path() {
        let instructions = build_install_instructions("/tmp/test.pem");
        assert!(instructions.macos.contains("/tmp/test.pem"));
        assert!(instructions.windows.contains("/tmp/test.pem"));
        assert!(instructions.linux.contains("/tmp/test.pem"));
    }

    #[test]
    fn test_install_instructions_have_removal_steps() {
        let instructions = build_install_instructions("/tmp/ca.pem");
        assert!(instructions.macos.contains("remove"));
        assert!(instructions.windows.contains("delstore"));
        assert!(instructions.linux.contains("--fresh"));
    }
}
