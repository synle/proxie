import { render, screen } from '@testing-library/react';
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
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'dev');

    renderLayout();

    expect(screen.getByText('Proxie DEV v0.1.10 2026-05-16')).toBeInTheDocument();
  });

  it('renders the beta-format title with the short SHA when channel is beta', () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.10');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'beta');

    renderLayout();

    expect(screen.getByText('Proxie Beta v0.1.10 2026-05-16 deadbee')).toBeInTheDocument();
  });

  it('renders the official-format title without any tag when channel is official', () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.10');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'deadbee');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'official');

    renderLayout();

    expect(screen.getByText('Proxie v0.1.10 2026-05-16')).toBeInTheDocument();
  });
});
