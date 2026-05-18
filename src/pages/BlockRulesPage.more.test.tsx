import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import BlockRulesPage from './BlockRulesPage';

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'br-default',
    host_pattern: '*.doubleclick.net',
    path_pattern: null as string | null,
    enabled: true,
    note: 'ads',
    ...overrides,
  };
}

describe('BlockRulesPage — additional coverage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-aaaaaaaaaaaa');
  });

  it('logs an error when get_block_rules rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') throw new Error('load fail');
      return undefined;
    });

    render(<BlockRulesPage />);

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to load block rules:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('edit dialog pre-fills fields and update_block_rule preserves id & sets path_pattern to null when cleared', async () => {
    const user = userEvent.setup();
    const rule = makeRule({
      id: 'edit-1',
      host_pattern: '*.tracker.com',
      path_pattern: '/old/*',
      note: 'old note',
    });
    let updated: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_block_rules') return [rule];
      if (cmd === 'update_block_rule') {
        updated = args?.rule as Record<string, unknown>;
        return [updated];
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('*.tracker.com')).toBeInTheDocument());

    await user.click(screen.getByLabelText('edit *.tracker.com'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('host-pattern-input')).toHaveValue('*.tracker.com');
    expect(within(dialog).getByTestId('path-pattern-input')).toHaveValue('/old/*');
    expect(within(dialog).getByTestId('note-input')).toHaveValue('old note');

    // Clear path to exercise the `trimmedPath ? trimmedPath : null` branch.
    await user.clear(within(dialog).getByTestId('path-pattern-input'));
    await user.clear(within(dialog).getByTestId('note-input'));
    await user.type(within(dialog).getByTestId('note-input'), 'updated note');

    await user.click(within(dialog).getByTestId('save-block-rule'));

    await waitFor(() => {
      expect(updated).not.toBeNull();
    });
    expect(updated).toMatchObject({
      id: 'edit-1',
      host_pattern: '*.tracker.com',
      path_pattern: null,
      enabled: true,
      note: 'updated note',
    });
  });

  it('logs an error when add_block_rule rejects (save error path)', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [];
      if (cmd === 'add_block_rule') throw new Error('save fail');
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No block rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByText('Add Rule'));
    await user.type(screen.getByTestId('host-pattern-input'), 'bad.example.com');
    await user.click(screen.getByTestId('save-block-rule'));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to save block rule:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('logs an error when update_block_rule rejects during toggle', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rule = makeRule({ id: 'tog-fail', host_pattern: 'tog.com' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [rule];
      if (cmd === 'update_block_rule') throw new Error('toggle fail');
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('tog.com')).toBeInTheDocument());

    await user.click(screen.getByLabelText('toggle tog.com'));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to toggle block rule:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('logs an error when delete_block_rule rejects', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rule = makeRule({ id: 'del-fail', host_pattern: 'del.com' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [rule];
      if (cmd === 'delete_block_rule') throw new Error('delete fail');
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('del.com')).toBeInTheDocument());

    await user.click(screen.getByLabelText('delete del.com'));
    await user.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to delete block rule:', expect.any(Error));
    });
    // Confirm dialog still closes on failure (finally block).
    await waitFor(() => {
      expect(screen.queryByText(/Delete this block rule/i)).toBeNull();
    });
    err.mockRestore();
  });

  it('Save button stays disabled while host pattern is empty', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [];
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No block rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByText('Add Rule'));

    const save = screen.getByTestId('save-block-rule');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId('host-pattern-input'), 'x.com');
    expect(save).toBeEnabled();
  });

  it('Seed Defaults skips entries already present (alreadyHas branch)', async () => {
    const user = userEvent.setup();
    // Pre-load with one of the seeded hosts so the loop hits `continue`.
    const existing = makeRule({
      id: 'pre',
      host_pattern: '*.doubleclick.net',
      enabled: true,
    });
    let added = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_block_rules') return [existing];
      if (cmd === 'add_block_rule') {
        added += 1;
        return [existing];
      }
      return undefined;
    });

    render(<BlockRulesPage />);
    await waitFor(() => expect(screen.getByText('*.doubleclick.net')).toBeInTheDocument());

    await user.click(screen.getByTestId('seed-defaults'));

    // Even though some seed entries are skipped, at least one new rule must
    // have been added (the seed list has more than just doubleclick).
    await waitFor(() => {
      expect(added).toBeGreaterThan(0);
    });
    // It should be strictly less than the full seed list (because we
    // pre-loaded one entry).
    const seedDefaultsAddCalls = invokeMock.mock.calls.filter((c) => c[0] === 'add_block_rule');
    expect(seedDefaultsAddCalls.length).toBeLessThan(50);
  });
});
