/// <reference types="vite/client" />

// Build-time constants injected by Vite's `define` block in
// `vite.config.ts`. These are literal source substitutions, not
// runtime variables — treat them as `const` globals.
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_SHA__: string;
declare const __RELEASE_CHANNEL__: 'dev' | 'beta' | 'official';
