import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConnectionsPage from './ConnectionsPage';

/**
 * Synthesize a ConnectionLog stub for the export/bookmark tests. Keeps
 * the per-test setup short so assertions can focus on the new
 * behavior. Mirrors the shape used elsewhere in
 * `ConnectionsPage.test.tsx`.
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
    timestamp: '2026-05-18T10:00:00Z',
    request_headers: [['Accept', '*/*']] as [string, string][],
    response_headers: [['Content-Type', 'application/json']] as [string, string][],
    request_body: null,
    response_body: '{"ok":true}',
    content_type: 'application/json',
    intercepted: false,
    blocked: false,
    bookmarked: false,
    ...overrides,
  };
}

/**
 * Capture the blob contents passed through `URL.createObjectURL`.
 * Returns a `lastBlobText()` helper that reads the most recent blob's
 * payload — enough for the HAR / codegen export assertions below.
 */
function installBlobSpy() {
  const blobs: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return `blob:test/${blobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  return {
    async lastBlobText() {
      const b = blobs[blobs.length - 1];
      return b ? await b.text() : '';
    },
    blobs,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

describe('ConnectionsPage — bookmark + export', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('toggles a row bookmark and invokes set_bookmark with the right args', async () => {
    const row = makeConn({ id: 'b-1', bookmarked: false });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      if (cmd === 'set_bookmark') return true;
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );

    const star = await screen.findByTestId('bookmark-b-1');
    await userEvent.click(star);

    // The Tauri command was called exactly once with the right shape.
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'set_bookmark');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ id: 'b-1', bookmarked: true });

    // Aria state flipped on the icon button (optimistic update).
    expect(star).toHaveAttribute('aria-pressed', 'true');
  });

  it('HAR (bookmarked) export contains bookmarked rows and skips others', async () => {
    const flagged = makeConn({
      id: 'flag-1',
      url: 'https://flagged.example.com/api',
      bookmarked: true,
    });
    const unflagged = makeConn({
      id: 'normal-1',
      url: 'https://normal.example.com/api',
      bookmarked: false,
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [flagged, unflagged];
      return undefined;
    });

    const spy = installBlobSpy();
    try {
      render(<ConnectionsPage />);
      await waitFor(() =>
        expect(screen.getByText('https://flagged.example.com/api')).toBeInTheDocument(),
      );

      await userEvent.click(screen.getByTestId('export-menu-button'));
      await userEvent.click(await screen.findByTestId('export-har-bookmarked'));

      const text = await spy.lastBlobText();
      const parsed = JSON.parse(text);
      expect(parsed.log.version).toBe('1.2');
      expect(parsed.log.entries).toHaveLength(1);
      expect(parsed.log.entries[0].request.url).toBe('https://flagged.example.com/api');
      // Unflagged row must NOT leak into the bookmarked export.
      expect(text).not.toContain('https://normal.example.com/api');
    } finally {
      spy.restore();
    }
  });

  it('curl export menu produces a snippet for the visible rows', async () => {
    const row = makeConn({
      id: 'c-1',
      method: 'POST',
      url: 'https://api.example.com/login',
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [row];
      return undefined;
    });

    const spy = installBlobSpy();
    try {
      render(<ConnectionsPage />);
      await waitFor(() =>
        expect(screen.getByText('https://api.example.com/login')).toBeInTheDocument(),
      );

      await userEvent.click(screen.getByTestId('export-menu-button'));
      await userEvent.click(await screen.findByTestId('export-curl-all'));

      const text = await spy.lastBlobText();
      expect(text).toContain('curl -X POST');
      expect(text).toContain('https://api.example.com/login');
    } finally {
      spy.restore();
    }
  });

  it('export menu lists every codegen language in both scopes', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_connections') return [makeConn({ id: 'menu-1' })];
      return undefined;
    });

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText('https://api.example.com/foo')).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId('export-menu-button'));

    // Every language registered in CODEGEN should be reachable via the menu
    // — this is the regression test for the registry-driven Export.
    for (const lang of ['curl', 'python', 'node']) {
      expect(await screen.findByTestId(`export-${lang}-all`)).toBeInTheDocument();
      expect(screen.getByTestId(`export-${lang}-bookmarked`)).toBeInTheDocument();
    }
  });
});
