import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, vi } from 'vitest';
import Layout from './Layout';

/**
 * Render a `Layout` inside a `MemoryRouter` so the nav items mount
 * without a real history stack.
 */
function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout>
        <div>child</div>
      </Layout>
    </MemoryRouter>,
  );
}

describe('Layout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the dev-format AppBar title by default', () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.10');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__BUILD_TIME__', '14:32 UTC');
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'dev');

    renderLayout();

    expect(screen.getByText('Proxie DEV v0.1.10 2026-05-16 14:32 UTC')).toBeInTheDocument();
  });

  it('renders the beta-format title with the short SHA when channel is beta', () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.10');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__BUILD_TIME__', '14:32 UTC');
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'beta');

    renderLayout();

    expect(
      screen.getByText('Proxie Beta v0.1.10 2026-05-16 14:32 UTC deadbee'),
    ).toBeInTheDocument();
  });

  it('renders the official-format title without any tag when channel is official', () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.10');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__BUILD_TIME__', '14:32 UTC');
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'official');

    renderLayout();

    expect(screen.getByText('Proxie v0.1.10 2026-05-16 14:32 UTC')).toBeInTheDocument();
  });

  it('renders all nav items and clicking one is non-throwing', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderLayout();
    const user = userEvent.setup();
    // All five nav labels are visible.
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.getByText('Host Rules')).toBeInTheDocument();
    expect(screen.getByText('Interceptor')).toBeInTheDocument();
    expect(screen.getByText('Block Rules')).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
    // Clicking exercises the navigate(item.path) handler.
    await user.click(screen.getByText('Setup'));
    await user.click(screen.getByText('Block Rules'));
  });

  it('toggles the proxy chip via stop_proxy / start_proxy', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const { invoke } = await import('@tauri-apps/api/core');
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);

    renderLayout();
    const user = userEvent.setup();

    // Start.
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    const btn = screen.getAllByRole('button').find((b) =>
      b.querySelector('[data-testid="PlayArrowIcon"]'),
    )!;
    await user.click(btn);
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('start_proxy');

    // Stop.
    const stopBtn = screen.getAllByRole('button').find((b) =>
      b.querySelector('[data-testid="StopIcon"]'),
    )!;
    await user.click(stopBtn);
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('stop_proxy');
  });

  it('logs an error and keeps the chip when toggleProxy rejects', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const { invoke } = await import('@tauri-apps/api/core');
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error('proxy boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderLayout();
    const user = userEvent.setup();

    const btn = screen.getAllByRole('button').find((b) =>
      b.querySelector('[data-testid="PlayArrowIcon"]'),
    )!;
    await user.click(btn);

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Proxy toggle failed:', expect.any(Error));
    });
    // Chip remains Stopped because state was not flipped on failure.
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    err.mockRestore();
  });
});
