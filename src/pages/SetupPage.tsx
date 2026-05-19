import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  TextField,
  Alert,
  Tabs,
  Tab,
  Divider,
  Chip,
  Link,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Stack,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

interface PlatformInstructions {
  macos: string;
  windows: string;
  linux: string;
}

interface CertInfo {
  ca_cert_path: string;
  ca_key_path: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  install_instructions: PlatformInstructions;
}

interface ProxyConfig {
  port: number;
  listen_addr: string;
  ssl_enabled: boolean;
}

// macOS System Settings deep-link URLs. The Ventura+ syntax targets the
// modern System Settings app; the legacy URL is used as a fallback for
// older macOS releases (Monterey and earlier) where the new pane
// identifiers aren't registered.
const MAC_URL_NETWORK_PROXIES_MODERN =
  'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies';
const MAC_URL_NETWORK_PROXIES_LEGACY =
  'x-apple.systempreferences:com.apple.preference.network?Proxies';
const MAC_URL_PRIVACY_LOCAL_NETWORK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork';
const MAC_URL_KEYCHAIN_PRIMARY = 'keychainaccess:';
const MAC_URL_KEYCHAIN_FALLBACK = '/System/Applications/Utilities/Keychain Access.app';

/**
 * Return `true` when the given listen address is NOT a loopback
 * interface. Used to gate the macOS Local Network privacy row — Sonoma
 * 14+ only prompts for Local Network when the listener is reachable
 * from other hosts on the LAN.
 *
 * @param addr Raw listen address from the persisted ProxyConfig.
 * @returns `true` if the address is a non-loopback (LAN/0.0.0.0)
 *   address, `false` for `127.0.0.1`, `::1`, or `localhost` (case
 *   insensitive).
 */
function isNonLoopbackAddr(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a !== '' && a !== '127.0.0.1' && a !== '::1' && a !== 'localhost';
}

/**
 * Attempt each URL in turn via the Rust `open_url` command, returning
 * after the first success. Used so the macOS Network proxies button can
 * try the Ventura+ URL first and silently fall back to the legacy URL
 * on older releases.
 *
 * @param urls Ordered list of URLs to try.
 * @returns `true` if any URL opened successfully, `false` otherwise.
 */
async function openFirstAvailable(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await invoke('open_url', { url });
      return true;
    } catch {
      // try the next URL
    }
  }
  return false;
}

export default function SetupPage() {
  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [config, setConfig] = useState<ProxyConfig>({
    port: 39871,
    listen_addr: '127.0.0.1',
    ssl_enabled: true,
  });
  const [platformTab, setPlatformTab] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Hydrate the page from Rust: existing cert, persisted proxy config,
   * and the host OS family. Errors are logged but non-fatal so the page
   * still renders with default ProxyConfig values.
   */
  const loadData = async () => {
    try {
      const cert = await invoke<CertInfo | null>('get_cert_info');
      if (cert) setCertInfo(cert);
      const cfg = await invoke<ProxyConfig>('get_proxy_config');
      setConfig(cfg);
      try {
        const p = await invoke<string>('get_platform');
        setPlatform(p);
      } catch {
        // Older builds may not have get_platform yet — leave platform
        // unset so the macOS card simply stays hidden.
      }
    } catch (e) {
      console.error('Failed to load setup data:', e);
    }
  };

  const handleGenerateCert = async () => {
    try {
      const cert = await invoke<CertInfo>('generate_cert');
      setCertInfo(cert);
      setStatus('Certificate generated successfully');
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const handleSaveConfig = async () => {
    try {
      await invoke('update_proxy_config', { config });
      setStatus('Configuration saved');
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  /**
   * Open the proxy's self-served `/ping` endpoint in the user's default
   * browser via the Tauri opener plugin.
   *
   * The Rust proxy short-circuits any `GET <listen_addr>:<port>/ping`
   * request and replies with a small JSON status blob, giving the user a
   * one-click way to confirm Proxie is actually listening on the address
   * shown on this page.
   */
  const handleOpenPing = async () => {
    const url = `http://${config.listen_addr}:${config.port}/ping`;
    try {
      await openUrl(url);
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const platformLabels = ['macOS', 'Windows', 'Linux (Ubuntu)'];
  const platformKeys: (keyof PlatformInstructions)[] = ['macos', 'windows', 'linux'];

  const isMac = platform === 'macos';
  const showLocalNetworkRow = isMac && isNonLoopbackAddr(config.listen_addr);

  return (
    <Box>
      <Typography variant='h5' gutterBottom>
        Setup
      </Typography>

      {status && (
        <Alert
          severity={status.startsWith('Error') ? 'error' : 'success'}
          sx={{ mb: 2 }}
          onClose={() => setStatus(null)}>
          {status}
        </Alert>
      )}

      {/* Proxy Configuration */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant='h6' gutterBottom>
            Proxy Configuration
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              label='Listen Address'
              value={config.listen_addr}
              onChange={(e) => setConfig({ ...config, listen_addr: e.target.value })}
              size='small'
            />
            <TextField
              label='Port'
              type='number'
              value={config.port}
              onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
              size='small'
            />
          </Box>
          <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
            Configure your system or browser to use HTTP proxy at{' '}
            <Link
              component='button'
              type='button'
              onClick={handleOpenPing}
              sx={{ fontWeight: 'bold', verticalAlign: 'baseline' }}
              title='Open /ping in your default browser to verify the proxy is reachable'>
              {config.listen_addr}:{config.port}
            </Link>
          </Typography>
          <Button variant='contained' onClick={handleSaveConfig}>
            Save Configuration
          </Button>
        </CardContent>
      </Card>

      {/* macOS Permissions & System Setup — only rendered on macOS. */}
      {isMac && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant='h6' gutterBottom>
              macOS Permissions & System Setup
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
              Proxie works best when these macOS settings are configured. Click each to open the
              relevant System Settings pane.
            </Typography>

            <Stack spacing={2}>
              {/* Row 1 — System proxy configuration */}
              <Box>
                <Typography variant='subtitle2'>System Proxy Configuration</Typography>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                  Tell macOS to route HTTP/HTTPS traffic through Proxie at{' '}
                  <strong>
                    {config.listen_addr}:{config.port}
                  </strong>
                  .
                </Typography>
                <Button
                  variant='outlined'
                  size='small'
                  onClick={() =>
                    openFirstAvailable([
                      MAC_URL_NETWORK_PROXIES_MODERN,
                      MAC_URL_NETWORK_PROXIES_LEGACY,
                    ])
                  }>
                  Open System Settings
                </Button>
              </Box>

              {/* Row 2 — Local Network privacy (only when non-loopback) */}
              {showLocalNetworkRow && (
                <Box>
                  <Typography variant='subtitle2'>Local Network access</Typography>
                  <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                    Required by macOS Sonoma 14+ when Proxie listens on a non-loopback address.
                  </Typography>
                  <Button
                    variant='outlined'
                    size='small'
                    onClick={() => openFirstAvailable([MAC_URL_PRIVACY_LOCAL_NETWORK])}>
                    Open Privacy & Security
                  </Button>
                </Box>
              )}

              {/* Row 3 — Verify CA Certificate */}
              <Box>
                <Typography variant='subtitle2'>Verify CA Certificate</Typography>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                  See the SSL Certificate section below for install commands. Keychain Access lets
                  you confirm Proxie's CA is trusted.
                </Typography>
                <Button
                  variant='outlined'
                  size='small'
                  onClick={() =>
                    openFirstAvailable([MAC_URL_KEYCHAIN_PRIMARY, MAC_URL_KEYCHAIN_FALLBACK])
                  }>
                  Open Keychain Access
                </Button>
              </Box>

              {/* Row 4 — FAQ accordion */}
              <Accordion>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant='subtitle2'>
                    What about Full Disk Access, Accessibility, Notifications?
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Typography variant='body2' color='text.secondary'>
                    Proxie does NOT request these. If macOS prompts you for them, deny — Proxie
                    does not need them.
                  </Typography>
                </AccordionDetails>
              </Accordion>
            </Stack>
          </CardContent>
        </Card>
      )}

      {/* SSL Certificate */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant='h6' gutterBottom>
            SSL Certificate
          </Typography>

          {certInfo ? (
            <Box>
              <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
                <Chip label={`Created: ${certInfo.created_at}`} size='small' />
                <Chip label={`Expires: ${certInfo.expires_at}`} size='small' />
              </Box>
              <Typography variant='body2' sx={{ mb: 1 }}>
                <strong>Certificate:</strong> {certInfo.ca_cert_path}
              </Typography>
              <Typography variant='body2' sx={{ mb: 1 }}>
                <strong>Fingerprint:</strong>{' '}
                <code style={{ fontSize: '0.8em' }}>{certInfo.fingerprint}</code>
              </Typography>
              <Divider sx={{ my: 2 }} />
              <Button variant='outlined' onClick={handleGenerateCert} sx={{ mb: 2 }}>
                Regenerate Certificate
              </Button>
            </Box>
          ) : (
            <Box>
              <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                No CA certificate found. Generate one to enable HTTPS interception.
              </Typography>
              <Button variant='contained' color='primary' onClick={handleGenerateCert}>
                Generate CA Certificate
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Install Instructions */}
      {certInfo && (
        <Card>
          <CardContent>
            <Typography variant='h6' gutterBottom>
              Install Certificate
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
              To intercept HTTPS traffic, install the CA certificate in your system trust store:
            </Typography>
            <Tabs value={platformTab} onChange={(_, v) => setPlatformTab(v)} sx={{ mb: 2 }}>
              {platformLabels.map((label) => (
                <Tab key={label} label={label} />
              ))}
            </Tabs>
            <Box
              sx={{
                bgcolor: 'background.default',
                p: 2,
                borderRadius: 1,
                fontFamily: 'monospace',
                fontSize: '0.85em',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
              }}>
              {certInfo.install_instructions[platformKeys[platformTab]]}
            </Box>
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
