import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConnectionsPage from '../../pages/ConnectionsPage';

/**
 * Connections-page integration coverage — multi-step user flows that
 * span page render, IPC calls, filter input, and the clear-all action.
 *
 * These tests live in `src/test/integration/` rather than next to the
 * component because they exercise multi-step flows end-to-end (render
 * → table → filter → clear → empty state). They share Vitest config
 * with the per-component unit tests but the file naming pattern keeps
 * the two layers visually distinct in PR diffs.
 */

/**
 * Build a minimal ConnectionLog-shaped object for the get_connections
 * invoke mock. Defaults are intentionally boring so each test can
 * override only the fields it cares about.
 *
 * @param overrides - Field overrides applied on top of the defaults.
 * @returns A complete ConnectionLog suitable for the table view.
 */
function makeConn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c-default',
    method: 'GET',
    url: 'https://api.example.com/foo',
    host: 'api.example.com',
    path: '/foo',
    status: 200,
    duration_ms: 42,
    request_size: 0,
    response_size: 11,
    timestamp: '2026-05-16T10:00:00Z',
    request_headers: [] as [string, string][],
    response_headers: [] as [string, string][],
    request_body: null,
    response_body: null,
    content_type: 'application/json',
    intercepted: false,
    blocked: false,
    ...overrides,
  };
}

describe('Connections workflow — integration', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders rows, applies a filter, then clears all', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'c-1', host: 'api.alpha.com', url: 'https://api.alpha.com/x' }),
      makeConn({ id: 'c-2', host: 'api.beta.com', url: 'https://api.beta.com/y' }),
      makeConn({ id: 'c-3', host: 'api.gamma.com', url: 'https://api.gamma.com/z' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      if (cmd === 'clear_connections') return undefined;
      return undefined;
    });

    render(<ConnectionsPage />);

    // 1) All three rows render.
    await waitFor(() => {
      expect(screen.getByText('https://api.alpha.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.beta.com/y')).toBeInTheDocument();
      expect(screen.getByText('https://api.gamma.com/z')).toBeInTheDocument();
    });

    // 2) Filter narrows to one row.
    const filterInput = screen.getByPlaceholderText(/Filter by URL/i);
    await user.type(filterInput, 'beta');
    await waitFor(() => {
      expect(screen.queryByText('https://api.alpha.com/x')).toBeNull();
      expect(screen.getByText('https://api.beta.com/y')).toBeInTheDocument();
      expect(screen.queryByText('https://api.gamma.com/z')).toBeNull();
    });

    // 3) Clear input → all three back.
    await user.clear(filterInput);
    await waitFor(() => {
      expect(screen.getByText('https://api.alpha.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.gamma.com/z')).toBeInTheDocument();
    });

    // 4) Clear-all wipes the table.
    await user.click(screen.getByLabelText('Clear all'));
    await waitFor(() => {
      expect(screen.queryByText('https://api.alpha.com/x')).toBeNull();
      // Empty-state copy appears.
      expect(screen.getByText(/No connections yet/i)).toBeInTheDocument();
    });

    // Backend was asked to clear once.
    const clearCalls = invokeMock.mock.calls.filter((c) => c[0] === 'clear_connections');
    expect(clearCalls).toHaveLength(1);
  });

  it('shows the empty-state when get_connections returns []', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [];
      return undefined;
    });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(screen.getByText(/No connections yet/i)).toBeInTheDocument();
    });
  });
});
