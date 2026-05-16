import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import Layout from '../../components/Layout';

/**
 * Proxy-toggle integration coverage — start_proxy + stop_proxy flows
 * through the AppBar play/stop button. Asserts both the IPC call shape
 * and the UI state chip (Stopped → Running → Stopped).
 */

describe('Proxy toggle workflow — integration', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  /** Render the AppBar shell inside a MemoryRouter so nav links resolve. */
  function renderLayout() {
    return render(
      <MemoryRouter>
        <Layout>
          <div>main child</div>
        </Layout>
      </MemoryRouter>,
    );
  }

  it('toggles Stopped → Running → Stopped via start/stop invokes', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_proxy') return { running: true, port: 39871, listen_addr: '127.0.0.1' };
      if (cmd === 'stop_proxy') return { running: false, port: null, listen_addr: null };
      return undefined;
    });

    renderLayout();

    // Initial state.
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    // Find the play/stop button — it's the only icon button in the AppBar.
    const button = screen.getAllByRole('button').find((b) => b.querySelector('svg'));
    if (!button) throw new Error('proxy toggle button not found');
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText('Running')).toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith('start_proxy');

    // Click again to stop.
    await user.click(button);
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith('stop_proxy');
  });

  it('keeps the chip in Stopped state if start_proxy throws', async () => {
    const user = userEvent.setup();
    // Silence the expected console.error from the catch branch.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_proxy') throw new Error('port in use');
      return undefined;
    });

    renderLayout();
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    const button = screen.getAllByRole('button').find((b) => b.querySelector('svg'));
    if (!button) throw new Error('proxy toggle button not found');
    await user.click(button);

    // Still Stopped — the catch branch swallowed the error.
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
