import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SetupPage from '../../pages/SetupPage';

/**
 * Setup-page integration coverage — generate-cert and save-config
 * flows. Both flip backend state (the file-on-disk in the real app)
 * and re-render the page with the new shape; this asserts both halves.
 */

interface CertInfo {
  ca_cert_path: string;
  ca_key_path: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  install_instructions: { macos: string; windows: string; linux: string };
}

const sampleCert: CertInfo = {
  ca_cert_path: '/tmp/proxie-ca.pem',
  ca_key_path: '/tmp/proxie-ca-key.pem',
  fingerprint: 'AA:BB:CC:DD',
  created_at: '2026-05-16',
  expires_at: '2036-12-31',
  install_instructions: {
    macos: 'sudo security add-trusted-cert ...',
    windows: 'certutil -addstore ...',
    linux: 'sudo cp ... && sudo update-ca-certificates',
  },
};

describe('Setup workflow — integration', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders no-cert state then generates a CA and shows fingerprint + install instructions', async () => {
    const user = userEvent.setup();
    let cert: CertInfo | null = null;

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return cert;
      if (cmd === 'get_proxy_config')
        return { port: 39871, listen_addr: '127.0.0.1', ssl_enabled: true };
      if (cmd === 'generate_cert') {
        cert = sampleCert;
        return sampleCert;
      }
      return undefined;
    });

    render(<SetupPage />);

    // No-cert initial state.
    await waitFor(() => {
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument();
    });

    // Click generate.
    await user.click(screen.getByRole('button', { name: /Generate CA Certificate/i }));

    // The cert appears.
    await waitFor(() => {
      expect(screen.getByText('AA:BB:CC:DD')).toBeInTheDocument();
      // Install Certificate card shows up only when cert is present.
      expect(screen.getByText(/Install Certificate/i)).toBeInTheDocument();
    });

    // Success status banner.
    expect(screen.getByText(/Certificate generated successfully/i)).toBeInTheDocument();
  });

  it('saves the proxy configuration and surfaces a success banner', async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config')
        return { port: 39871, listen_addr: '127.0.0.1', ssl_enabled: true };
      if (cmd === 'update_proxy_config') return undefined;
      return undefined;
    });

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Listen Address/i)).toBeInTheDocument();
    });

    // Tweak the port and save.
    const portInput = screen.getByLabelText('Port') as HTMLInputElement;
    await user.clear(portInput);
    await user.type(portInput, '12345');
    await user.click(screen.getByRole('button', { name: /Save Configuration/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_proxy_config',
        expect.objectContaining({
          config: expect.objectContaining({ port: 12345 }),
        }),
      );
      expect(screen.getByText(/Configuration saved/i)).toBeInTheDocument();
    });
  });
});
