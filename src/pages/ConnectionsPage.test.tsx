import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConnectionsPage from './ConnectionsPage';

/**
 * Build a minimal ConnectionLog stub for table rendering.
 *
 * @param overrides - Field overrides for the synthesized row.
 * @returns A complete `ConnectionLog`-shaped object suitable for the
 *   `get_connections` invoke mock.
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
    request_headers: [['Accept', '*/*']] as [string, string][],
    response_headers: [['Content-Type', 'application/json']] as [string, string][],
    request_body: null,
    response_body: '{"ok":true}',
    content_type: 'application/json',
    intercepted: false,
    ...overrides,
  };
}

describe('ConnectionsPage — intercepted badge', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('shows the INTERCEPTED chip only on rows where intercepted === true', async () => {
    const interceptedRow = makeConn({
      id: 'c-1',
      url: 'https://api.example.com/mocked',
      path: '/mocked',
      intercepted: true,
    });
    const normalRow = makeConn({
      id: 'c-2',
      url: 'https://api.example.com/normal',
      path: '/normal',
      intercepted: false,
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [interceptedRow, normalRow];
      return undefined;
    });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/mocked')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/normal')).toBeInTheDocument();
    });

    const badges = screen.getAllByTestId('intercepted-badge');
    // Exactly one badge across both rows.
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('INTERCEPTED');

    // Sanity-check it's anchored to the intercepted row, not the normal one.
    const interceptedRowEl = screen.getByText('https://api.example.com/mocked').closest('tr');
    const normalRowEl = screen.getByText('https://api.example.com/normal').closest('tr');
    expect(interceptedRowEl).not.toBeNull();
    expect(normalRowEl).not.toBeNull();
    expect(within(interceptedRowEl as HTMLElement).getByTestId('intercepted-badge')).toBeTruthy();
    expect(
      within(normalRowEl as HTMLElement).queryByTestId('intercepted-badge'),
    ).toBeNull();
  });

  it('shows "Intercepted: yes" highlighted in the detail drawer for intercepted rows', async () => {
    const row = makeConn({ id: 'c-3', intercepted: true });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const highlight = await screen.findByTestId('detail-row-highlighted');
    expect(highlight).toHaveTextContent('Intercepted');
    expect(highlight).toHaveTextContent('yes');
  });

  it('shows "Intercepted: no" without highlight for non-intercepted rows', async () => {
    const row = makeConn({ id: 'c-4', intercepted: false });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    // Drawer should still render the Intercepted row but without the highlight testid.
    await waitFor(() => {
      expect(screen.getByText('Intercepted')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('detail-row-highlighted')).toBeNull();
    expect(screen.getByText('no')).toBeInTheDocument();
  });
});
