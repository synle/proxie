import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
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
