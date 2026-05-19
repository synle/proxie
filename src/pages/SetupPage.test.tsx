import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SetupPage from './SetupPage';

function makeCert(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ca_cert_path: '/home/user/.config/proxie/ca-cert.pem',
    ca_key_path: '/home/user/.config/proxie/ca-key.pem',
    fingerprint: 'AB:CD:EF:01:23:45',
    created_at: '2026-01-01',
    expires_at: '2036-01-01',
    install_instructions: {
      macos: 'sudo security add-trusted-cert ...',
      windows: 'certutil -addstore ...',
      linux: 'sudo cp ca-cert.pem /usr/local/share/ca-certificates/ && sudo update-ca-certificates',
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    port: 39871,
    listen_addr: '127.0.0.1',
    ssl_enabled: true,
    ...overrides,
  };
}

/**
 * Build a default `invoke` implementation seeded with the given cert,
 * config, and platform (`macos` | `linux` | `windows`). Individual tests
 * can override by passing a richer mock.
 */
function makeInvokeMock(opts: {
  cert?: unknown;
  config?: ReturnType<typeof makeConfig>;
  platform?: 'macos' | 'linux' | 'windows';
  openUrlSpy?: (url: string) => void;
}) {
  const { cert = null, config = makeConfig(), platform = 'linux', openUrlSpy } = opts;
  return async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'get_cert_info') return cert;
    if (cmd === 'get_proxy_config') return config;
    if (cmd === 'get_platform') return platform;
    if (cmd === 'open_url') {
      openUrlSpy?.(String(args?.url ?? ''));
      return undefined;
    }
    return undefined;
  };
}

describe('SetupPage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders proxy config and the "no cert" state initially', async () => {
    invokeMock.mockImplementation(makeInvokeMock({}));

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument();
      expect(screen.getByText(/127\.0\.0\.1:39871/)).toBeInTheDocument();
    });
    // "Generate CA Certificate" button is shown when no cert exists.
    expect(screen.getByRole('button', { name: /Generate CA Certificate/i })).toBeInTheDocument();
    // No install-instructions card when there's no cert.
    expect(screen.queryByText(/Install Certificate/i)).toBeNull();
  });

  it('renders cert details and install instructions when a cert exists', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ cert: makeCert() }));

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByText(/AB:CD:EF:01:23:45/)).toBeInTheDocument();
      expect(screen.getByText(/Install Certificate/i)).toBeInTheDocument();
    });
    // macOS instructions are visible by default (first tab).
    expect(screen.getByText(/sudo security add-trusted-cert/)).toBeInTheDocument();
    // "Regenerate Certificate" button replaces the generate button.
    expect(screen.getByRole('button', { name: /Regenerate Certificate/i })).toBeInTheDocument();
  });

  it('logs an error when loadData rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') throw new Error('load boom');
      return undefined;
    });

    render(<SetupPage />);

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to load setup data:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('clicking Generate CA Certificate calls generate_cert and shows success alert', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'generate_cert') return makeCert({ fingerprint: 'FRESH:CERT' });
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Generate CA Certificate/i }));

    await waitFor(() => {
      expect(screen.getByText('Certificate generated successfully')).toBeInTheDocument();
      expect(screen.getByText(/FRESH:CERT/)).toBeInTheDocument();
    });
  });

  it('shows an error alert when generate_cert rejects', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'generate_cert') throw new Error('permission denied');
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Generate CA Certificate/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/Error: .*permission denied/);
    });
  });

  it('Save Configuration calls update_proxy_config with edited port and address', async () => {
    const user = userEvent.setup();
    let saved: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'update_proxy_config') {
        saved = args?.config as Record<string, unknown>;
        return undefined;
      }
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    const addrInput = screen.getByLabelText(/Listen Address/i);
    const portInput = screen.getByLabelText(/^Port$/i);

    await user.clear(addrInput);
    await user.type(addrInput, '0.0.0.0');
    await user.clear(portInput);
    await user.type(portInput, '8080');

    await user.click(screen.getByRole('button', { name: /Save Configuration/i }));

    await waitFor(() => {
      expect(saved).not.toBeNull();
    });
    expect(saved).toMatchObject({ listen_addr: '0.0.0.0', port: 8080, ssl_enabled: true });
    expect(screen.getByText('Configuration saved')).toBeInTheDocument();
  });

  it('shows an error alert when update_proxy_config rejects', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'update_proxy_config') throw new Error('port in use');
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Save Configuration/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Error: .*port in use/);
    });
  });

  it('switching install-instruction tabs swaps the platform body', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(makeInvokeMock({ cert: makeCert() }));

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/sudo security add-trusted-cert/)).toBeInTheDocument(),
    );

    // Switch to Windows.
    await user.click(screen.getByRole('tab', { name: /Windows/i }));
    await waitFor(() => {
      expect(screen.getByText(/certutil -addstore/)).toBeInTheDocument();
    });

    // Switch to Linux.
    await user.click(screen.getByRole('tab', { name: /Linux/i }));
    await waitFor(() => {
      expect(screen.getByText(/update-ca-certificates/)).toBeInTheDocument();
    });
  });

  it('alert close button dismisses the status banner', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'update_proxy_config') return undefined;
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Save Configuration/i }));
    expect(await screen.findByText('Configuration saved')).toBeInTheDocument();

    // MUI Alert close button has aria-label "Close" by default.
    await user.click(screen.getByRole('button', { name: /^Close$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Configuration saved')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // macOS Permissions & System Setup card
  // ---------------------------------------------------------------------

  it('renders the macOS Permissions card on macOS', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ platform: 'macos' }));

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/System Proxy Configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify CA Certificate/i)).toBeInTheDocument();
  });

  it('does NOT render the macOS Permissions card on Linux', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ platform: 'linux' }));

    render(<SetupPage />);

    // Wait for the rest of the page to settle so the macOS card has had a chance to mount.
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/macOS Permissions & System Setup/i)).toBeNull();
  });

  it('does NOT render the macOS Permissions card on Windows', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ platform: 'windows' }));

    render(<SetupPage />);

    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/macOS Permissions & System Setup/i)).toBeNull();
  });

  it('shows the Local Network row only when listen_addr is non-loopback', async () => {
    invokeMock.mockImplementation(
      makeInvokeMock({
        platform: 'macos',
        config: makeConfig({ listen_addr: '192.168.1.10' }),
      }),
    );

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByText(/Local Network access/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Open Privacy & Security/i })).toBeInTheDocument();
  });

  it('hides the Local Network row for loopback listen_addr (127.0.0.1)', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ platform: 'macos' }));

    render(<SetupPage />);

    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Local Network access/i)).toBeNull();
  });

  it('hides the Local Network row for ::1 and localhost', async () => {
    invokeMock.mockImplementation(
      makeInvokeMock({ platform: 'macos', config: makeConfig({ listen_addr: '::1' }) }),
    );
    const { unmount } = render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Local Network access/i)).toBeNull();
    unmount();

    invokeMock.mockReset();
    invokeMock.mockImplementation(
      makeInvokeMock({ platform: 'macos', config: makeConfig({ listen_addr: 'LocalHost' }) }),
    );
    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Local Network access/i)).toBeNull();
  });

  it('clicking Open System Settings invokes open_url with the Ventura+ network proxies URL', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    invokeMock.mockImplementation(
      makeInvokeMock({ platform: 'macos', openUrlSpy: (u) => opened.push(u) }),
    );

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Open System Settings/i }));

    await waitFor(() => {
      expect(opened).toContain(
        'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies',
      );
    });
  });

  it('clicking Open Keychain Access invokes open_url with the keychainaccess URL', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    invokeMock.mockImplementation(
      makeInvokeMock({ platform: 'macos', openUrlSpy: (u) => opened.push(u) }),
    );

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Open Keychain Access/i }));

    await waitFor(() => {
      expect(
        opened.some(
          (u) =>
            u === 'keychainaccess:' ||
            u === '/System/Applications/Utilities/Keychain Access.app',
        ),
      ).toBe(true);
    });
  });

  it('clicking Open Privacy & Security invokes open_url with the LocalNetwork pane URL', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    invokeMock.mockImplementation(
      makeInvokeMock({
        platform: 'macos',
        config: makeConfig({ listen_addr: '0.0.0.0' }),
        openUrlSpy: (u) => opened.push(u),
      }),
    );

    render(<SetupPage />);
    await waitFor(() => expect(screen.getByText(/Local Network access/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Open Privacy & Security/i }));

    await waitFor(() => {
      expect(opened).toContain(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
      );
    });
  });

  it('falls back to the legacy network-proxy URL when the modern URL fails', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'get_platform') return 'macos';
      if (cmd === 'open_url') {
        const url = String(args?.url ?? '');
        opened.push(url);
        if (url.includes('Network-Settings.extension')) {
          throw new Error('not registered');
        }
        return undefined;
      }
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/macOS Permissions & System Setup/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Open System Settings/i }));

    await waitFor(() => {
      // Legacy URL is attempted after the modern one fails.
      expect(opened).toEqual([
        'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies',
        'x-apple.systempreferences:com.apple.preference.network?Proxies',
      ]);
    });
  });

  it('renders the FAQ accordion about Full Disk Access / Accessibility / Notifications', async () => {
    invokeMock.mockImplementation(makeInvokeMock({ platform: 'macos' }));

    render(<SetupPage />);

    await waitFor(() =>
      expect(
        screen.getByText(/What about Full Disk Access, Accessibility, Notifications\?/i),
      ).toBeInTheDocument(),
    );
  });
});
