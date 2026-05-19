import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConnectionsPage from './ConnectionsPage';

/**
 * Build a minimal ConnectionLog stub. Mirrors the shape persisted by
 * the Rust backend so tests don't drift from the IPC contract.
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

describe('ConnectionsPage — body previews', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders a <video> element for video/mp4 data URI bodies', async () => {
    const row = makeConn({
      content_type: 'video/mp4',
      response_headers: [['Content-Type', 'video/mp4']] as [string, string][],
      response_body: 'data:video/mp4;base64,AAAA',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument());
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const video = await screen.findByTestId('body-preview-video');
    expect(video.tagName.toLowerCase()).toBe('video');
  });

  it('renders an <audio> element for audio/mpeg data URI bodies', async () => {
    const row = makeConn({
      content_type: 'audio/mpeg',
      response_headers: [['Content-Type', 'audio/mpeg']] as [string, string][],
      response_body: 'data:audio/mpeg;base64,AAAA',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument());
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const audio = await screen.findByTestId('body-preview-audio');
    expect(audio.tagName.toLowerCase()).toBe('audio');
  });

  it('renders an <iframe> for application/pdf data URI bodies', async () => {
    const row = makeConn({
      content_type: 'application/pdf',
      response_headers: [['Content-Type', 'application/pdf']] as [string, string][],
      response_body: 'data:application/pdf;base64,JVBERi0=',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument());
    await userEvent.click(screen.getByText('https://api.example.com/foo'));

    const pdf = await screen.findByTestId('body-preview-pdf');
    expect(pdf.tagName.toLowerCase()).toBe('iframe');
  });
});

describe('ConnectionsPage — detail drawer headers', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders both request and response header rows', async () => {
    const row = makeConn({
      request_headers: [
        ['Accept', '*/*'],
        ['X-Trace', 'abc'],
      ] as [string, string][],
      response_headers: [
        ['Content-Type', 'application/json'],
        ['X-Cache', 'HIT'],
      ] as [string, string][],
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

    expect(await screen.findByText('Request Headers')).toBeInTheDocument();
    expect(screen.getByText('Response Headers')).toBeInTheDocument();
    expect(screen.getByText('X-Trace')).toBeInTheDocument();
    expect(screen.getByText('X-Cache')).toBeInTheDocument();
    expect(screen.getByText('HIT')).toBeInTheDocument();
  });

  it('formats duration in seconds for slow requests and size in MB for large bodies', async () => {
    const row = makeConn({
      duration_ms: 12500,
      response_size: 2 * 1024 * 1024,
      request_size: 50 * 1024,
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

    // The drawer DetailRow values show formatted size & duration. The
    // duration also appears in the table row (DurationBar), so we get
    // at least one match for "12.50s".
    await waitFor(() => {
      expect(screen.getAllByText('12.50s').length).toBeGreaterThan(0);
    });
    // 2 MiB -> "2.0 MB" (appears in table row + detail drawer)
    expect(screen.getAllByText('2.0 MB').length).toBeGreaterThan(0);
    // 50 KiB -> "50.0 KB"
    expect(screen.getAllByText('50.0 KB').length).toBeGreaterThan(0);
  });
});

describe('ConnectionsPage — codegen languages', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('switches to python and emits a requests-based snippet', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      method: 'POST',
      url: 'https://api.example.com/login',
      request_headers: [['Content-Type', 'application/json']] as [string, string][],
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
    await user.click(screen.getByText('https://api.example.com/login'));

    // Open the codegen language dropdown by clicking the visible combobox.
    const codegen = await screen.findByTestId('codegen-lang');
    const combobox = within(codegen).getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: /python/i }));

    const output = await screen.findByTestId('codegen-output');
    expect(output.textContent).toContain('import requests');
    expect(output.textContent).toContain('headers = {');
    expect(output.textContent).toContain('data = ');
    expect(output.textContent).toContain('requests.request("POST"');
  });

  it('switches to node fetch and emits a fetch-based snippet', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      method: 'PUT',
      url: 'https://api.example.com/update',
      request_headers: [['Authorization', 'Bearer x']] as [string, string][],
      request_body: '{}',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/update')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/update'));

    const codegen = await screen.findByTestId('codegen-lang');
    const combobox = within(codegen).getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: /node/i }));

    const output = await screen.findByTestId('codegen-output');
    expect(output.textContent).toContain('const url = ');
    expect(output.textContent).toContain('await fetch(url');
    // Object literal in the fetch init uses unquoted keys (`method: ...`).
    expect(output.textContent).toContain('method: "PUT"');
  });

  it('skips request body in curl when method is GET', async () => {
    const row = makeConn({
      method: 'GET',
      url: 'https://api.example.com/get',
      request_body: 'ignored',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/get')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/get'));

    const output = await screen.findByTestId('codegen-output');
    // No --data-raw line because method is GET even though a request body exists.
    expect(output.textContent).not.toContain('--data-raw');
  });

  it('replaces a binary (data:) request body with a placeholder in curl', async () => {
    const row = makeConn({
      method: 'POST',
      url: 'https://api.example.com/upload',
      request_body: 'data:application/octet-stream;base64,AAAA',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/upload')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('https://api.example.com/upload'));

    const output = await screen.findByTestId('codegen-output');
    expect(output.textContent).toContain('<binary body');
  });

  it('copies the generated code to clipboard via the copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // navigator.clipboard is a read-only getter in jsdom — install via defineProperty.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const row = makeConn({ method: 'GET', url: 'https://api.example.com/cp' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/cp')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/cp'));

    await user.click(await screen.findByTestId('codegen-copy'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(writeText.mock.calls[0][0]).toMatch(/^curl -X GET/);
    });
    // Success toast appears.
    expect(await screen.findByText(/Copied to clipboard/i)).toBeInTheDocument();
  });
});

describe('ConnectionsPage — formatters', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('pretty-prints XML when Format is clicked on an xml body', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      content_type: 'application/xml',
      response_headers: [['Content-Type', 'application/xml']] as [string, string][],
      response_body: '<a><b>hi</b><c/></a>',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('response-body-format'));

    const pre = screen.getByTestId('body-preview-text');
    // Re-indented to multiline.
    expect(pre.textContent).toContain('\n');
    expect(pre.textContent).toContain('<b>hi</b>');
    expect(await screen.findByText('Body formatted.')).toBeInTheDocument();
  });

  it('pretty-prints CSS when Format is clicked on a css body', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      content_type: 'text/css',
      response_headers: [['Content-Type', 'text/css']] as [string, string][],
      response_body: 'body{color:red;margin:0}',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('response-body-format'));

    const pre = screen.getByTestId('body-preview-text');
    expect(pre.textContent).toMatch(/\{\n/);
    expect(pre.textContent).toContain('color:red;');
  });

  it('errors with a toast when the JSON body is unparseable', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      content_type: 'application/json',
      response_headers: [['Content-Type', 'application/json']] as [string, string][],
      response_body: 'not-json',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('response-body-format'));
    expect(await screen.findByText(/No formatter available/i)).toBeInTheDocument();
  });

  it('does not show a Format button for plain text bodies', async () => {
    const row = makeConn({
      content_type: 'text/plain',
      response_headers: [['Content-Type', 'text/plain']] as [string, string][],
      response_body: 'just text',
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

    // Expand the response body card (default-collapsed for the new feature).
    await userEvent.click(await screen.findByTestId('response-body-toggle'));

    // Body preview text rendered, but no format button for this MIME.
    expect(await screen.findByTestId('body-preview-text')).toBeInTheDocument();
    expect(screen.queryByTestId('response-body-format')).toBeNull();
  });
});

describe('ConnectionsPage — save body', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('triggers a browser download via Blob when saving a text body', async () => {
    const user = userEvent.setup();
    const row = makeConn({
      url: 'https://api.example.com/api/data.json',
      content_type: 'application/json',
      response_headers: [['Content-Type', 'application/json']] as [string, string][],
      response_body: '{"k":1}',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    // Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't ship them.
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/api/data.json')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/api/data.json'));

    await user.click(await screen.findByTestId('response-body-save'));

    expect(createObjectURL).toHaveBeenCalled();
    expect(await screen.findByText(/Saving /i)).toBeInTheDocument();
  });
});

describe('ConnectionsPage — column filters', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('filters by status bucket and offers a reset button to clear all filters', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'st-1', url: 'https://api.example.com/ok', status: 200 }),
      makeConn({ id: 'st-2', url: 'https://api.example.com/notfound', status: 404 }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/ok')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/notfound')).toBeInTheDocument();
    });

    // Open the status-bucket multi-select and pick "4xx".
    const statusFilter = screen.getByTestId('status-filter');
    const combobox = within(statusFilter).getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: '4xx' }));
    // Close the listbox so subsequent queries don't pick options.
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText('https://api.example.com/ok')).toBeNull();
      expect(screen.getByText('https://api.example.com/notfound')).toBeInTheDocument();
    });

    // The reset button appears now that a filter is active.
    const resetBtn = screen.getByTestId('reset-filters');
    await user.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/ok')).toBeInTheDocument();
    });
  });

  it('filters by method bucket', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'm-1', url: 'https://api.example.com/g', method: 'GET' }),
      makeConn({ id: 'm-2', url: 'https://api.example.com/p', method: 'POST' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/g')).toBeInTheDocument();
    });

    const methodFilter = screen.getByTestId('method-filter');
    const combobox = within(methodFilter).getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: 'POST' }));
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText('https://api.example.com/g')).toBeNull();
      expect(screen.getByText('https://api.example.com/p')).toBeInTheDocument();
    });
  });

  it('filters by size (>= bytes)', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'sz-1', url: 'https://api.example.com/big', response_size: 4096 }),
      makeConn({ id: 'sz-2', url: 'https://api.example.com/small', response_size: 100 }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/big')).toBeInTheDocument();
    });

    const sizeInput = within(screen.getByTestId('size-value')).getByRole('textbox');
    await user.type(sizeInput, '1000');

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/big')).toBeInTheDocument();
      expect(screen.queryByText('https://api.example.com/small')).toBeNull();
    });
  });

  it('uses the <= operator when toggled', async () => {
    const user = userEvent.setup();
    const rows = [
      makeConn({ id: 'op-1', url: 'https://api.example.com/big', response_size: 4096 }),
      makeConn({ id: 'op-2', url: 'https://api.example.com/small', response_size: 100 }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/big')).toBeInTheDocument(),
    );

    // Flip the size operator to <=.
    const sizeOp = screen.getByTestId('size-op');
    const opCombo = within(sizeOp).getByRole('combobox');
    await user.click(opCombo);
    // The <= label is rendered as "≤".
    await user.click(await screen.findByRole('option', { name: '≤' }));

    const sizeInput = within(screen.getByTestId('size-value')).getByRole('textbox');
    await user.type(sizeInput, '500');

    await waitFor(() => {
      expect(screen.queryByText('https://api.example.com/big')).toBeNull();
      expect(screen.getByText('https://api.example.com/small')).toBeInTheDocument();
    });
  });

  it('filters by time window (Last 5 min)', async () => {
    const user = userEvent.setup();
    // One row dated "now", one dated 1 hour ago.
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const rows = [
      makeConn({
        id: 'tw-fresh',
        url: 'https://api.example.com/fresh',
        timestamp: now.toISOString(),
      }),
      makeConn({
        id: 'tw-stale',
        url: 'https://api.example.com/stale',
        timestamp: oneHourAgo.toISOString(),
      }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/fresh')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/stale')).toBeInTheDocument();
    });

    const timeWindow = screen.getByTestId('time-window');
    const combobox = within(timeWindow).getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: 'Last 5 min' }));

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/fresh')).toBeInTheDocument();
      expect(screen.queryByText('https://api.example.com/stale')).toBeNull();
    });
  });
});

describe('ConnectionsPage — refresh / clear errors', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('refresh button re-invokes get_connections', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => expect(screen.getByText(/No connections yet/i)).toBeInTheDocument());
    const initial = invokeMock.mock.calls.filter((c) => c[0] === 'get_connections').length;

    await user.click(screen.getByLabelText('Refresh'));

    await waitFor(() => {
      const after = invokeMock.mock.calls.filter((c) => c[0] === 'get_connections').length;
      expect(after).toBeGreaterThan(initial);
    });
  });

  it('logs an error when clear_connections rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [makeConn()];
      if (cmd === 'clear_connections') throw new Error('cannot clear');
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText('Clear all'));

    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    errSpy.mockRestore();
  });

  it('logs an error when get_connections rejects on initial load', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') throw new Error('IPC down');
      return undefined;
    });

    render(<ConnectionsPage />);

    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    // Page still renders the empty state since the initial connections
    // state default is [].
    expect(screen.getByText(/No connections yet/i)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('renders a 3xx status with warning color and a 5xx with error color', async () => {
    const rows = [
      makeConn({ id: 's-3', url: 'https://api.example.com/m', status: 301 }),
      makeConn({ id: 's-5', url: 'https://api.example.com/x', status: 500 }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return rows;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() => {
      expect(screen.getByText('301')).toBeInTheDocument();
      expect(screen.getByText('500')).toBeInTheDocument();
    });
    // Pick the chip with text "301" and verify it uses the warning palette.
    const chip301 = screen.getByText('301').closest('.MuiChip-root');
    expect(chip301?.className).toMatch(/colorWarning/);
    const chip500 = screen.getByText('500').closest('.MuiChip-root');
    expect(chip500?.className).toMatch(/colorError/);
  });

  it('streams in new rows via the proxy:connection listen event', async () => {
    // Reset and re-mock the listen helper to capture the handler.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [];
      return undefined;
    });
    const handlerRef: { current: ((p: { payload: unknown }) => void) | null } = {
      current: null,
    };
    const tauriEvent = await import('@tauri-apps/api/event');
    const listenMock = tauriEvent.listen as unknown as ReturnType<typeof vi.fn>;
    listenMock.mockImplementationOnce(async (_evt: string, handler: (p: { payload: unknown }) => void) => {
      handlerRef.current = handler;
      return () => {};
    });

    render(<ConnectionsPage />);
    await waitFor(() => expect(screen.getByText(/No connections yet/i)).toBeInTheDocument());

    // Fire a synthetic event payload through the listen handler.
    expect(handlerRef.current).not.toBeNull();
    fireEvent.scroll(window); // no-op, just ensures jsdom is alive
    handlerRef.current!({ payload: makeConn({ id: 'live-1', url: 'https://api.example.com/live' }) });

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/live')).toBeInTheDocument();
    });
  });
});

describe('ConnectionsPage — body format / clipboard error toasts', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('shows an error toast when clipboard.writeText rejects', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
    });
    const row = makeConn({ method: 'GET', url: 'https://api.example.com/cperr' });
    invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_connections') return [row];
    return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
    expect(screen.getByText('https://api.example.com/cperr')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/cperr'));

    await user.click(await screen.findByTestId('codegen-copy'));

    expect(await screen.findByText(/Copy failed/i)).toBeInTheDocument();
  });

  it('formats a request body via the request-body-format button', async () => {
    const user = userEvent.setup();
    const row = makeConn({
    method: 'POST',
    request_body: '{"a":1,"b":2}',
    request_headers: [['Content-Type', 'application/json']] as [string, string][],
    content_type: 'application/json',
    response_body: null,
    });
    invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_connections') return [row];
    return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
    expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('request-body-format'));

    expect(await screen.findByText(/Body formatted/i)).toBeInTheDocument();
  });

  it('saves a request body via the request-body-save button', async () => {
    const user = userEvent.setup();
    Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:fake-req'),
    revokeObjectURL: vi.fn(),
    });
    const row = makeConn({
    method: 'POST',
    request_body: '{"x":1}',
    request_headers: [['Content-Type', 'application/json']] as [string, string][],
    response_body: null,
    });
    invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_connections') return [row];
    return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
    expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('request-body-save'));

    expect(await screen.findByText(/Saving /i)).toBeInTheDocument();
  });

  it('saves a binary response body via the data URI download path', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:fake-bin');
    Object.assign(URL, {
    createObjectURL,
    revokeObjectURL: vi.fn(),
    });
    const row = makeConn({
    content_type: 'application/octet-stream',
    response_headers: [['Content-Type', 'application/octet-stream']] as [string, string][],
    response_body: 'data:application/octet-stream;base64,QUJDRA==',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_connections') return [row];
    return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
    expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('https://api.example.com/foo'));

    await user.click(await screen.findByTestId('response-body-save'));

    expect(await screen.findByText(/Saving /i)).toBeInTheDocument();
  });
});
