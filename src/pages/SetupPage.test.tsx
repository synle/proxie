import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SetupPage, { makeExportFilename } from './SetupPage';

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

describe('SetupPage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders proxy config and the "no cert" state initially', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      return undefined;
    });

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
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return makeCert();
      if (cmd === 'get_proxy_config') return makeConfig();
      return undefined;
    });

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
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return makeCert();
      if (cmd === 'get_proxy_config') return makeConfig();
      return undefined;
    });

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

  it('makeExportFilename produces a YYYY-MM-DD suffix', () => {
    const name = makeExportFilename(new Date(2026, 4, 18)); // May 18, 2026
    expect(name).toBe('proxie-2026-05-18.json');
  });

  it('Export Config invokes export_config and creates a JSON blob download', async () => {
    const user = userEvent.setup();
    const jsonPayload = JSON.stringify({
      version: '0.0.0-test',
      exported_at: '2026-05-18T00:00:00Z',
      host_rules: [],
      intercept_rules: [],
      block_rules: [],
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'export_config') return jsonPayload;
      return undefined;
    });

    // Spy on Blob construction and URL.createObjectURL so we can assert
    // the download pipeline was driven with the JSON payload.
    const blobs: Blob[] = [];
    const origBlob = global.Blob;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Blob = class TestBlob extends origBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        blobs.push(this);
      }
    };
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-url');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Export Config/i }));

    await waitFor(() => {
      expect(blobs.length).toBeGreaterThan(0);
      expect(createUrl).toHaveBeenCalled();
    });
    // Read the constructed blob back as text to confirm the payload.
    const text = await blobs[0].text();
    expect(text).toBe(jsonPayload);
    expect(blobs[0].type).toBe('application/json');
    expect(screen.getByText('Configuration exported')).toBeInTheDocument();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Blob = origBlob;
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it('Export Config shows an error alert when export_config rejects', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'export_config') throw new Error('export boom');
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Export Config/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Error: .*export boom/);
    });
  });

  it('Import Config: selecting a file then choosing Merge invokes import_config with mode=merge', async () => {
    const user = userEvent.setup();
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'import_config') {
        captured = args ?? null;
        return {
          host_rules_added: 2,
          intercept_rules_added: 1,
          block_rules_added: 0,
        };
      }
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    // Simulate the user picking a file. The hidden <input type=file>
    // carries data-testid="import-config-file".
    const fileInput = screen.getByTestId('import-config-file') as HTMLInputElement;
    const payload = JSON.stringify({
      version: '0.0.0-test',
      exported_at: '2026-05-18T00:00:00Z',
      host_rules: [{ id: 'h1', host: 'a.com', enabled: true, ignore_paths: [] }],
      intercept_rules: [],
      block_rules: [],
    });
    const file = new File([payload], 'proxie.json', { type: 'application/json' });
    await user.upload(fileInput, file);

    // Dialog opens; default mode is merge — confirm with Import.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Import$/i }));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured).toMatchObject({ json: payload, mode: 'merge' });
    // Snackbar reflects the per-list import summary.
    await waitFor(() => {
      expect(screen.getByText(/2 host.*1 intercept.*0 block rules/)).toBeInTheDocument();
    });
  });

  it('Import Config: switching to Replace mode forwards mode=replace', async () => {
    const user = userEvent.setup();
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'import_config') {
        captured = args ?? null;
        return { host_rules_added: 0, intercept_rules_added: 0, block_rules_added: 0 };
      }
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    const fileInput = screen.getByTestId('import-config-file') as HTMLInputElement;
    const file = new File(['{}'], 'proxie.json', { type: 'application/json' });
    await user.upload(fileInput, file);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Replace/i }));
    await user.click(screen.getByRole('button', { name: /^Import$/i }));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured).toMatchObject({ mode: 'replace' });
  });

  it('Import Config: Cancel closes the dialog without invoking import_config', async () => {
    const user = userEvent.setup();
    let importCalled = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'import_config') {
        importCalled = true;
        return { host_rules_added: 0, intercept_rules_added: 0, block_rules_added: 0 };
      }
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    const fileInput = screen.getByTestId('import-config-file') as HTMLInputElement;
    const file = new File(['{}'], 'proxie.json', { type: 'application/json' });
    await user.upload(fileInput, file);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(importCalled).toBe(false);
  });

  it('Import Config: backend error surfaces in the alert banner', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
      if (cmd === 'import_config') throw new Error('invalid JSON');
      return undefined;
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText(/No CA certificate found/i)).toBeInTheDocument(),
    );

    const fileInput = screen.getByTestId('import-config-file') as HTMLInputElement;
    const file = new File(['not-json'], 'proxie.json', { type: 'application/json' });
    await user.upload(fileInput, file);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Import$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Error: .*invalid JSON/);
    });
  });

  it('alert close button dismisses the status banner', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_cert_info') return null;
      if (cmd === 'get_proxy_config') return makeConfig();
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
});
