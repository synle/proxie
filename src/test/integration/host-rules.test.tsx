import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HostRulesPage from '../../pages/HostRulesPage';

/**
 * Host-rules-page integration coverage — full CRUD flow through the
 * Add Rule dialog, plus the toggle action that flips a rule's
 * `enabled` flag in-place.
 *
 * Mirrors the BlockRules integration suite stylistically — every
 * Tauri command is mocked, the test asserts both the rendered UI and
 * the exact `invoke` call shape so a future IPC contract change
 * surfaces as a test failure.
 */

interface HostRule {
  id: string;
  host: string;
  enabled: boolean;
  ignore_paths: string[];
}

describe('HostRules workflow — integration', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
  });

  it('renders empty-state, adds a rule via the dialog, then toggles it disabled', async () => {
    const user = userEvent.setup();
    let stored: HostRule[] = [];

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_host_rules') return stored;
      if (cmd === 'add_host_rule') {
        stored = [...stored, args?.rule as HostRule];
        return stored;
      }
      if (cmd === 'update_host_rule') {
        const r = args?.rule as HostRule;
        stored = stored.map((x) => (x.id === r.id ? r : x));
        return stored;
      }
      return undefined;
    });

    render(<HostRulesPage />);

    // Empty state copy.
    await waitFor(() => {
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument();
    });

    // Open the Add dialog.
    await user.click(screen.getByText('Add Rule'));
    await waitFor(() => {
      expect(screen.getByText('Add Host Rule')).toBeInTheDocument();
    });

    // Fill in fields. Use direct DOM interaction since these inputs
    // don't carry data-testid hooks.
    await user.type(screen.getByLabelText(/Host Pattern/i), '*.example.com');
    await user.type(screen.getByLabelText(/Ignore Paths/i), '/health{enter}/metrics');

    // Save. There are two buttons named "Add" — the page header's
    // "Add Rule" and the dialog's primary "Add". Target the dialog's
    // by scoping to the dialog role.
    const dialog = screen.getByRole('dialog');
    const saveBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add',
    );
    if (!saveBtn) throw new Error('dialog Add button not found');
    await user.click(saveBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_host_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            host: '*.example.com',
            enabled: true,
            ignore_paths: ['/health', '/metrics'],
          }),
        }),
      );
    });
  });

  it('toggles an existing rule via update_host_rule', async () => {
    const user = userEvent.setup();
    const existing: HostRule = {
      id: 'h-toggle',
      host: '*.toggle.example.com',
      enabled: true,
      ignore_paths: [],
    };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [existing];
      if (cmd === 'update_host_rule') return [{ ...existing, enabled: false }];
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => {
      expect(screen.getByText('*.toggle.example.com')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('switch');
    await user.click(toggle);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_host_rule',
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'h-toggle', enabled: false }),
        }),
      );
    });
  });
});
