import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const host = process.env.TAURI_DEV_HOST;

/**
 * Resolve the short git SHA for the build-time version stamp.
 *
 * Prefers the `GIT_SHA` environment variable (set by CI workflows) so a
 * shallow / detached-HEAD checkout still produces a useful value. Falls
 * back to `git rev-parse --short HEAD` for local dev, and finally to
 * `'unknown'` if git isn't available (e.g. running outside a worktree).
 *
 * @returns Short (7-char) git SHA, or `'unknown'` if it can't be resolved.
 */
function resolveGitSha(): string {
  const envSha = process.env.GIT_SHA?.trim();
  if (envSha) return envSha.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve the release channel for the build-time version stamp.
 *
 * Reads `RELEASE_CHANNEL` from the environment. Only the literal values
 * `'beta'` and `'official'` are accepted — anything else (including
 * unset) falls back to `'dev'` so local `npm run dev` / `npx tauri dev`
 * always renders the dev-flavored title.
 *
 * @returns One of `'dev' | 'beta' | 'official'`.
 */
function resolveReleaseChannel(): 'dev' | 'beta' | 'official' {
  const c = process.env.RELEASE_CHANNEL?.trim();
  if (c === 'beta' || c === 'official') return c;
  return 'dev';
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

const APP_VERSION = pkg.version;
const NOW_ISO = new Date().toISOString();
const BUILD_DATE = NOW_ISO.slice(0, 10);
const BUILD_TIME = NOW_ISO.slice(11, 16) + ' UTC';
const GIT_SHA = resolveGitSha();
const RELEASE_CHANNEL = resolveReleaseChannel();

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  // Build-time constants surfaced as global identifiers in the bundle.
  // Each value is JSON-stringified because Vite's `define` performs a
  // literal source substitution (the substituted text is the JS source
  // that ends up in the bundle, not the value itself).
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __GIT_SHA__: JSON.stringify(GIT_SHA),
    __RELEASE_CHANNEL__: JSON.stringify(RELEASE_CHANNEL),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        'src/test/setup.ts',
        'src/main.tsx',
        'src/vite-env.d.ts',
        '**/__tests__/**',
        'dist/**',
        'node_modules/**',
      ],
      // Floored to current baseline measured against src/App.test.tsx
      // (lines 10.87, branches 8.69, functions 11.23, statements 10.63).
      // raise as coverage improves; never lower
      thresholds: {
        lines: 10,
        branches: 8,
        functions: 11,
        statements: 10,
      },
    },
  },
}));
