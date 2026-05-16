import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildTitle } from './version';

/**
 * `buildTitle()` reads four compile-time globals injected by Vite's
 * `define` block. In the test environment those globals are seeded in
 * `src/test/setup.ts`; each test overrides them with `vi.stubGlobal`
 * and `vi.unstubAllGlobals()` restores them between cases.
 */
describe('buildTitle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the official channel title without a SHA', () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'abcdef1');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'official');

    expect(buildTitle()).toBe('Proxie v1.2.3 2026-05-16');
  });

  it('renders the beta channel title with version, date, and short SHA', () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'abcdef1');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'beta');

    expect(buildTitle()).toBe('Proxie Beta v1.2.3 2026-05-16 abcdef1');
  });

  it('renders the dev channel title (default) without a SHA', () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'abcdef1');
    vi.stubGlobal('__RELEASE_CHANNEL__', 'dev');

    expect(buildTitle()).toBe('Proxie DEV v1.2.3 2026-05-16');
  });

  it('falls back to the dev format for unknown channel values', () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3');
    vi.stubGlobal('__BUILD_DATE__', '2026-05-16');
    vi.stubGlobal('__GIT_SHA__', 'abcdef1');
    // Intentionally an unknown channel to exercise the default branch.
    vi.stubGlobal('__RELEASE_CHANNEL__', 'nightly');

    expect(buildTitle()).toBe('Proxie DEV v1.2.3 2026-05-16');
  });
});
