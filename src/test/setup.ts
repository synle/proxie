import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Build-time constants injected by Vite's `define` block in production.
// Vitest does NOT apply `define` to test source, so we seed sensible
// defaults here. Individual tests can override via `vi.stubGlobal`.
// Keep these in sync with the declarations in `src/vite-env.d.ts`.
(globalThis as Record<string, unknown>).__APP_VERSION__ ??= '0.0.0-test';
(globalThis as Record<string, unknown>).__BUILD_DATE__ ??= '2026-01-01';
(globalThis as Record<string, unknown>).__GIT_SHA__ ??= 'testsha';
(globalThis as Record<string, unknown>).__RELEASE_CHANNEL__ ??= 'dev';

// Polyfill ResizeObserver for jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/api/event
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Mock @tauri-apps/api/window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setSize: vi.fn(),
  }),
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));
