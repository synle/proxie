/**
 * Build-time version stamp helpers.
 *
 * The five `__*__` identifiers are substituted by Vite's `define`
 * (see `vite.config.ts`) — they are literal compile-time constants,
 * not runtime variables. Tests stub them via `vi.stubGlobal`.
 */

/**
 * Format the AppBar title for the current build.
 *
 * Three channels, three formats (all include build date + HH:MM UTC time):
 * - `official` → `Proxie v<version> <YYYY-MM-DD> <HH:MM> UTC`
 * - `beta`     → `Proxie Beta v<version> <YYYY-MM-DD> <HH:MM> UTC <shortsha>`
 * - `dev`      → `Proxie DEV v<version> <YYYY-MM-DD> <HH:MM> UTC`
 *
 * The `dev` branch is also used as the safe fallback for any unknown
 * channel value, so a misconfigured CI env never produces a blank title.
 *
 * @returns Title string ready to drop into the MUI `Typography` slot.
 */
export function buildTitle(): string {
  const v = __APP_VERSION__;
  const d = __BUILD_DATE__;
  const t = __BUILD_TIME__;
  const s = __GIT_SHA__;
  switch (__RELEASE_CHANNEL__) {
    case 'official':
      return `Proxie v${v} ${d} ${t}`;
    case 'beta':
      return `Proxie Beta v${v} ${d} ${t} ${s}`;
    case 'dev':
    default:
      return `Proxie DEV v${v} ${d} ${t}`;
  }
}
