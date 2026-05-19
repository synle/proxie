import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import BlockRulesPage from './BlockRulesPage';

/**
 * Build a minimal BlockRule for tests. Field shape mirrors the Rust struct.
 */
function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'br-default',
    host_pattern: '*.doubleclick.net',
    path_pattern: null,
    enabled: true,
    note: 'ads',
    ...overrides,
  };
}

describe('BlockRulesPage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    // Stub crypto.randomUUID for deterministic ids.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
  });

  it('renders the empty state when no rules are configured', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [];
      return undefined;
    });

    render(<BlockRulesPage />);

    await waitFor(() => {
      expect(screen.getByText(/No block rules configured/i)).toBeInTheDocument();
    });
    // No rule rows.
    expect(screen.queryByTestId(/block-rule-row-/)).toBeNull();
  });

  it('renders existing rules from get_block_rules', async () => {
    const rules = [
      makeRule({ id: 'r1', host_pattern: '*.tracker.com' }),
      makeRule({ id: 'r2', host_pattern: 'ads.example.com', enabled: false }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return rules;
      return undefined;
    });

    render(<BlockRulesPage />);

    await waitFor(() => {
      expect(screen.getByText('*.tracker.com')).toBeInTheDocument();
      expect(screen.getByText('ads.example.com')).toBeInTheDocument();
    });
    expect(screen.getByTestId('block-rule-row-r1')).toBeInTheDocument();
    expect(screen.getByTestId('block-rule-row-r2')).toBeInTheDocument();
  });

  it('adds a new rule via the dialog', async () => {
    const user = userEvent.setup();
    let saved: unknown = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_block_rules') return [];
      if (cmd === 'add_block_rule') {
        saved = args?.rule;
        return [args?.rule];
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText(/No block rules configured/i)).toBeInTheDocument());

    await user.click(screen.getByText('Add Rule'));
    await user.type(screen.getByTestId('host-pattern-input'), '*.ads.example');
    await user.type(screen.getByTestId('path-pattern-input'), '/banner/*');
    await user.type(screen.getByTestId('note-input'), 'banner ads');
    await user.click(screen.getByTestId('save-block-rule'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_block_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            host_pattern: '*.ads.example',
            path_pattern: '/banner/*',
            enabled: true,
            note: 'banner ads',
          }),
        }),
      );
    });
    expect(saved).toMatchObject({ host_pattern: '*.ads.example' });
  });

  it('opens a confirmation dialog before deleting a rule', async () => {
    const user = userEvent.setup();
    const rule = makeRule({ id: 'to-delete', host_pattern: 'gone.example.com' });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_block_rules') return [rule];
      if (cmd === 'delete_block_rule') {
        // Caller passed the rule id.
        expect(args).toEqual({ id: 'to-delete' });
        return [];
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('gone.example.com')).toBeInTheDocument());

    await user.click(screen.getByLabelText('delete gone.example.com'));

    // Confirm dialog appears.
    expect(screen.getByText(/Delete this block rule/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_block_rule', { id: 'to-delete' });
    });
  });

  it('does not delete when the user cancels the confirmation', async () => {
    const user = userEvent.setup();
    const rule = makeRule({ id: 'keep-me', host_pattern: 'keep.example.com' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [rule];
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('keep.example.com')).toBeInTheDocument());

    await user.click(screen.getByLabelText('delete keep.example.com'));
    await user.click(screen.getByText('Cancel'));

    // delete_block_rule should not have been called.
    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === 'delete_block_rule');
    expect(deleteCalls).toHaveLength(0);
  });

  it('toggling a rule calls update_block_rule with the flipped enabled flag', async () => {
    const user = userEvent.setup();
    const rule = makeRule({ id: 'toggle-me', enabled: true });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_block_rules') return [rule];
      if (cmd === 'update_block_rule') {
        return [args?.rule];
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('*.doubleclick.net')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'toggle *.doubleclick.net' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_block_rule',
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'toggle-me', enabled: false }),
        }),
      );
    });
  });

  it('Seed Defaults inserts the curated host list as disabled rules', async () => {
    const user = userEvent.setup();
    const added: unknown[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_block_rules') return [];
      if (cmd === 'add_block_rule') {
        added.push(args?.rule);
        return added;
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText(/No block rules configured/i)).toBeInTheDocument());

    await user.click(screen.getByTestId('seed-defaults'));

    await waitFor(() => {
      expect(added.length).toBeGreaterThan(0);
    });
    // Every seeded rule must start disabled — Proxie never enables block
    // rules by default.
    for (const r of added) {
      expect(r).toMatchObject({ enabled: false });
    }
  });
});
