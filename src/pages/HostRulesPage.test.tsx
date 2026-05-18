import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HostRulesPage from './HostRulesPage';

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'hr-default',
    host: 'api.example.com',
    enabled: true,
    ignore_paths: [] as string[],
    ...overrides,
  };
}

describe('HostRulesPage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000099');
  });

  it('renders empty state when no rules exist', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [];
      return undefined;
    });
    render(<HostRulesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument();
    });
  });

  it('logs an error when get_host_rules rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') throw new Error('load fail');
      return undefined;
    });
    render(<HostRulesPage />);
    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to load host rules:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('renders existing rules with their host pattern and ignore-path chips', async () => {
    const rules = [
      makeRule({ id: 'r1', host: '*.foo.com', ignore_paths: ['/health', '/ping'] }),
      makeRule({ id: 'r2', host: 'bar.com', enabled: false }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return rules;
      return undefined;
    });
    render(<HostRulesPage />);
    await waitFor(() => {
      expect(screen.getByText('*.foo.com')).toBeInTheDocument();
      expect(screen.getByText('bar.com')).toBeInTheDocument();
      expect(screen.getByText('/health')).toBeInTheDocument();
      expect(screen.getByText('/ping')).toBeInTheDocument();
    });
  });

  it('adds a new rule via the dialog with parsed ignore paths', async () => {
    const user = userEvent.setup();
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_host_rules') return [];
      if (cmd === 'add_host_rule') {
        captured = args?.rule as Record<string, unknown>;
        return [captured];
      }
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Host Pattern/i), 'api.new.com');
    await user.type(within(dialog).getByLabelText(/Ignore Paths/i), '/health\n/metrics\n   \n');
    await user.click(within(dialog).getByRole('button', { name: /^Add$/ }));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured).toMatchObject({
      host: 'api.new.com',
      enabled: true,
      ignore_paths: ['/health', '/metrics'],
      id: '00000000-0000-0000-0000-000000000099',
    });
  });

  it('Add button stays disabled until host pattern is non-empty', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [];
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));

    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /^Add$/ });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Host Pattern/i), 'a.com');
    expect(submit).toBeEnabled();
  });

  it('cancel button closes the dialog without saving', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [];
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Neither add nor update was called.
    expect(invokeMock.mock.calls.some((c) => c[0] === 'add_host_rule')).toBe(false);
    expect(invokeMock.mock.calls.some((c) => c[0] === 'update_host_rule')).toBe(false);
  });

  it('edit pre-fills the form and calls update_host_rule (preserves id)', async () => {
    const user = userEvent.setup();
    const rule = makeRule({
      id: 'edit-me',
      host: 'edit.example.com',
      ignore_paths: ['/old'],
    });
    let updated: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_host_rules') return [rule];
      if (cmd === 'update_host_rule') {
        updated = args?.rule as Record<string, unknown>;
        return [updated];
      }
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => expect(screen.getByText('edit.example.com')).toBeInTheDocument());

    // Click the EditIcon's button.
    await user.click(screen.getAllByTestId('EditIcon')[0].closest('button')!);

    const dialog = screen.getByRole('dialog');
    const hostInput = within(dialog).getByLabelText(/Host Pattern/i);
    expect(hostInput).toHaveValue('edit.example.com');
    // Ignore paths textarea is pre-filled with newline-joined paths.
    expect(within(dialog).getByLabelText(/Ignore Paths/i)).toHaveValue('/old');

    // Change the host pattern.
    await user.clear(hostInput);
    await user.type(hostInput, 'edited.example.com');

    await user.click(within(dialog).getByRole('button', { name: /Update/i }));

    await waitFor(() => {
      expect(updated).not.toBeNull();
    });
    expect(updated).toMatchObject({
      id: 'edit-me',
      host: 'edited.example.com',
      enabled: true,
      ignore_paths: ['/old'],
    });
  });

  it('toggle switch flips the enabled flag via update_host_rule', async () => {
    const user = userEvent.setup();
    const rule = makeRule({ id: 'tog', host: 'tog.com', enabled: true });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_host_rules') return [rule];
      if (cmd === 'update_host_rule') return [args?.rule];
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => expect(screen.getByText('tog.com')).toBeInTheDocument());

    await user.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_host_rule',
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'tog', enabled: false }),
        }),
      );
    });
  });

  it('logs an error when toggle fails', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rule = makeRule({ id: 'tog2', host: 'tog2.com' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [rule];
      if (cmd === 'update_host_rule') throw new Error('toggle fail');
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => expect(screen.getByText('tog2.com')).toBeInTheDocument());

    await user.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to toggle rule:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('delete button calls delete_host_rule with the rule id', async () => {
    const user = userEvent.setup();
    const rule = makeRule({ id: 'del-me', host: 'del.com' });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_host_rules') return [rule];
      if (cmd === 'delete_host_rule') {
        expect(args).toEqual({ id: 'del-me' });
        return [];
      }
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => expect(screen.getByText('del.com')).toBeInTheDocument());

    await user.click(screen.getAllByTestId('DeleteIcon')[0].closest('button')!);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_host_rule', { id: 'del-me' });
    });
  });

  it('logs an error when delete fails', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rule = makeRule({ id: 'del-fail', host: 'delf.com' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [rule];
      if (cmd === 'delete_host_rule') throw new Error('boom');
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() => expect(screen.getByText('delf.com')).toBeInTheDocument());

    await user.click(screen.getAllByTestId('DeleteIcon')[0].closest('button')!);

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to delete rule:', expect.any(Error));
    });
    err.mockRestore();
  });

  it('logs an error when add_host_rule fails (save error path)', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_host_rules') return [];
      if (cmd === 'add_host_rule') throw new Error('save fail');
      return undefined;
    });

    render(<HostRulesPage />);
    await waitFor(() =>
      expect(screen.getByText(/No host rules configured/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Host Pattern/i), 'errors.com');
    await user.click(within(dialog).getByRole('button', { name: /^Add$/ }));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to save rule:', expect.any(Error));
    });
    // Dialog stays open on error so the user can retry.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    err.mockRestore();
  });
});
