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
    blocked: false,
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
    const row = makeConn({ id: 'c-4', intercepted: false, blocked: false });
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
    // Two "no" texts now (Intercepted: no, Blocked: no).
    expect(screen.getAllByText('no')).toHaveLength(2);
  });
});

describe('ConnectionsPage — blocked badge', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders a red BLOCKED chip only on rows where blocked === true', async () => {
    const blockedRow = makeConn({
      id: 'b-1',
      url: 'https://ads.doubleclick.net/banner',
      host: 'ads.doubleclick.net',
      path: '/banner',
      status: 204,
      blocked: true,
    });
    const normalRow = makeConn({
      id: 'b-2',
      url: 'https://api.example.com/normal',
      path: '/normal',
      blocked: false,
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [blockedRow, normalRow];
      return undefined;
    });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(screen.getByText('https://ads.doubleclick.net/banner')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/normal')).toBeInTheDocument();
    });

    const badges = screen.getAllByTestId('blocked-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('BLOCKED');
    // The blocked badge must use MUI's "error" color (red palette).
    expect(badges[0].className).toMatch(/colorError/);

    const blockedRowEl = screen.getByText('https://ads.doubleclick.net/banner').closest('tr');
    const normalRowEl = screen.getByText('https://api.example.com/normal').closest('tr');
    expect(blockedRowEl).not.toBeNull();
    expect(normalRowEl).not.toBeNull();
    expect(within(blockedRowEl as HTMLElement).getByTestId('blocked-badge')).toBeTruthy();
    expect(within(normalRowEl as HTMLElement).queryByTestId('blocked-badge')).toBeNull();
  });

  it('shows "Blocked: yes" highlighted in the detail drawer for blocked rows', async () => {
    const row = makeConn({ id: 'b-3', blocked: true, intercepted: false });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    // Only the Blocked row should be highlighted (Intercepted stays plain).
    const highlighted = await screen.findAllByTestId('detail-row-highlighted');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('Blocked');
    expect(highlighted[0]).toHaveTextContent('yes');
  });
});

describe('ConnectionsPage — body preview', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders an <img> when the response body is a data: image URI', async () => {
    const row = makeConn({
      id: 'preview-1',
      content_type: 'image/png',
      response_headers: [['Content-Type', 'image/png']] as [string, string][],
      // 1x1 transparent PNG (data URI).
      response_body:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const img = await screen.findByTestId('body-preview-image');
    expect(img.tagName.toLowerCase()).toBe('img');
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // Should NOT render the corrupted-text fallback.
    expect(screen.queryByTestId('body-preview-text')).toBeNull();
  });

  it('renders a binary placeholder for non-previewable mime types', async () => {
    const row = makeConn({
      id: 'preview-2',
      content_type: 'application/octet-stream',
      response_headers: [['Content-Type', 'application/octet-stream']] as [string, string][],
      response_body: 'data:application/octet-stream;base64,AAECAwQFBgcICQ==',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const placeholder = await screen.findByTestId('body-preview-binary-placeholder');
    expect(placeholder).toHaveTextContent(/Binary content/i);
    expect(placeholder).toHaveTextContent('application/octet-stream');
  });

  it('renders text bodies in a <pre> block', async () => {
    const row = makeConn({
      id: 'preview-3',
      response_body: '{"ok":true}',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const pre = await screen.findByTestId('body-preview-text');
    expect(pre).toHaveTextContent('{"ok":true}');
  });
});

describe('ConnectionsPage — format / codegen', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('pretty-prints a JSON response body when Format is clicked', async () => {
    const row = makeConn({
      id: 'fmt-1',
      response_body: '{"a":1,"b":[2,3]}',
      content_type: 'application/json',
      response_headers: [['Content-Type', 'application/json']] as [string, string][],
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const fmtBtn = await screen.findByTestId('response-body-format');
    await userEvent.click(fmtBtn);

    const pre = screen.getByTestId('body-preview-text');
    // Multi-line + indented JSON output.
    expect(pre.textContent).toMatch(/\{\n {2}"a": 1,/);
    expect(pre.textContent).toMatch(/"b": \[\n {4}2,\n {4}3\n {2}\]\n\}/);
  });

  it('generates a curl command by default in the codegen panel', async () => {
    const row = makeConn({
      id: 'cg-1',
      method: 'POST',
      url: 'https://api.example.com/login',
      request_headers: [
        ['Content-Type', 'application/json'],
        ['X-Trace', 'abc'],
      ] as [string, string][],
      request_body: '{"u":"x"}',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/login')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/login'));

    const output = await screen.findByTestId('codegen-output');
    expect(output.textContent).toMatch(/^curl -X POST/);
    expect(output.textContent).toContain("https://api.example.com/login");
    expect(output.textContent).toContain('-H ');
    expect(output.textContent).toContain('Content-Type: application/json');
    expect(output.textContent).toContain('--data-raw');
  });
});

describe('ConnectionsPage — column filters', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('filters rows by URL-contains via the multi-clause URL filter modal', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'cf-1', url: 'https://api.alpha.com/x' }),
      makeConn({ id: 'cf-2', url: 'https://api.beta.com/y' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.alpha.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.beta.com/y')).toBeInTheDocument();
    });

    // Trigger button shows "any" when no clauses are configured.
    const trigger = screen.getByTestId('url-filter-button');
    expect(trigger).toHaveTextContent(/any/i);
    await user.click(trigger);

    // First clause row should already exist after Add.
    await user.click(screen.getByTestId('url-filter-add-clause'));
    const valueInput = within(screen.getByTestId('url-filter-clause-0')).getByTestId(
      'url-filter-clause-value',
    );
    await user.type(valueInput, 'beta');
    await user.click(screen.getByTestId('url-filter-save'));

    await waitFor(() => {
      expect(screen.queryByText('https://api.alpha.com/x')).toBeNull();
      expect(screen.getByText('https://api.beta.com/y')).toBeInTheDocument();
    });
    // Trigger button now reflects active count.
    expect(screen.getByTestId('url-filter-button')).toHaveTextContent(/1 filter/i);
  });

  it('combines two URL clauses with OR (default) and shows count badge on trigger', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'or-1', url: 'https://api.foo.com/x' }),
      makeConn({ id: 'or-2', url: 'https://api.example.com/bar' }),
      makeConn({ id: 'or-3', url: 'https://nope.example.com/y' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.foo.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/bar')).toBeInTheDocument();
      expect(screen.getByText('https://nope.example.com/y')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('url-filter-button'));
    // Add first clause: contains 'foo'.
    await user.click(screen.getByTestId('url-filter-add-clause'));
    const v0 = within(screen.getByTestId('url-filter-clause-0')).getByTestId(
      'url-filter-clause-value',
    );
    await user.type(v0, 'foo');
    // Add second clause: startsWith 'https://api'.
    await user.click(screen.getByTestId('url-filter-add-clause'));
    const row1 = screen.getByTestId('url-filter-clause-1');
    await user.click(within(row1).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /begins with/i }));
    const v1 = within(row1).getByTestId('url-filter-clause-value');
    await user.type(v1, 'https://api');

    // Confirm OR is the default top-level combinator.
    const orBtn = screen.getByTestId('url-filter-combinator-OR');
    expect(orBtn).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('url-filter-save'));

    await waitFor(() => {
      expect(screen.getByText('https://api.foo.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/bar')).toBeInTheDocument();
      expect(screen.queryByText('https://nope.example.com/y')).toBeNull();
    });

    expect(screen.getByTestId('url-filter-button')).toHaveTextContent(/2 filter/i);
  });

  it('switches combinator to AND — only rows matching every clause appear', async () => {
    const user = userEvent.setup();
    const rows = [
      // Matches "foo" contains AND startsWith "https://api".
      makeConn({ id: 'and-1', url: 'https://api.foo.com/x' }),
      // Matches contains "foo" only.
      makeConn({ id: 'and-2', url: 'https://other.com/foo' }),
      // Matches startsWith "https://api" only.
      makeConn({ id: 'and-3', url: 'https://api.example.com/bar' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.foo.com/x')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('url-filter-button'));
    await user.click(screen.getByTestId('url-filter-add-clause'));
    const v0 = within(screen.getByTestId('url-filter-clause-0')).getByTestId(
      'url-filter-clause-value',
    );
    await user.type(v0, 'foo');
    await user.click(screen.getByTestId('url-filter-add-clause'));
    const row1 = screen.getByTestId('url-filter-clause-1');
    await user.click(within(row1).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /begins with/i }));
    await user.type(within(row1).getByTestId('url-filter-clause-value'), 'https://api');

    await user.click(screen.getByTestId('url-filter-combinator-AND'));
    await user.click(screen.getByTestId('url-filter-save'));

    await waitFor(() => {
      expect(screen.getByText('https://api.foo.com/x')).toBeInTheDocument();
      expect(screen.queryByText('https://other.com/foo')).toBeNull();
      expect(screen.queryByText('https://api.example.com/bar')).toBeNull();
    });
  });

  it('adding then removing a clause leaves an empty list — no URL filter applied', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'rm-1', url: 'https://api.alpha.com/x' }),
      makeConn({ id: 'rm-2', url: 'https://api.beta.com/y' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.alpha.com/x')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('url-filter-button'));
    await user.click(screen.getByTestId('url-filter-add-clause'));
    await user.type(
      within(screen.getByTestId('url-filter-clause-0')).getByTestId('url-filter-clause-value'),
      'beta',
    );
    // Remove the only clause.
    await user.click(
      within(screen.getByTestId('url-filter-clause-0')).getByTestId('url-filter-clause-remove'),
    );
    await user.click(screen.getByTestId('url-filter-save'));

    // Both rows remain visible — empty clause list means no URL filter.
    await waitFor(() => {
      expect(screen.getByText('https://api.alpha.com/x')).toBeInTheDocument();
      expect(screen.getByText('https://api.beta.com/y')).toBeInTheDocument();
    });
    expect(screen.getByTestId('url-filter-button')).toHaveTextContent(/any/i);
  });

  it('filters rows by duration with the >= operator', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'cf-3', url: 'https://api.slow.com/a', duration_ms: 1500 }),
      makeConn({ id: 'cf-4', url: 'https://api.fast.com/b', duration_ms: 50 }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.slow.com/a')).toBeInTheDocument();
      expect(screen.getByText('https://api.fast.com/b')).toBeInTheDocument();
    });

    const durationInput = within(screen.getByTestId('duration-value')).getByRole('textbox');
    await user.type(durationInput, '500');

    await waitFor(() => {
      expect(screen.getByText('https://api.slow.com/a')).toBeInTheDocument();
      expect(screen.queryByText('https://api.fast.com/b')).toBeNull();
    });
  });
});
