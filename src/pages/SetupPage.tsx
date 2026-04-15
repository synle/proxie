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
} from '@mui/material';
import { invoke } from '@tauri-apps/api/core';

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

export default function SetupPage() {
  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [config, setConfig] = useState<ProxyConfig>({
    port: 8899,
    listen_addr: '127.0.0.1',
    ssl_enabled: true,
  });
  const [platformTab, setPlatformTab] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const cert = await invoke<CertInfo | null>('get_cert_info');
      if (cert) setCertInfo(cert);
      const cfg = await invoke<ProxyConfig>('get_proxy_config');
      setConfig(cfg);
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

  const platformLabels = ['macOS', 'Windows', 'Linux (Ubuntu)'];
  const platformKeys: (keyof PlatformInstructions)[] = ['macos', 'windows', 'linux'];

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
            <strong>
              {config.listen_addr}:{config.port}
            </strong>
          </Typography>
          <Button variant='contained' onClick={handleSaveConfig}>
            Save Configuration
          </Button>
        </CardContent>
      </Card>

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
