/**
 * Per-language code generators for replaying a captured connection.
 *
 * The single `CODEGEN` registry is the source of truth for the Connections
 * page: per-row dropdowns iterate over `CODEGEN_LANGS`, the page-level
 * "Export > <lang>" menu items reuse the same `generate` functions, and
 * adding a new language (java, c#, ...) is a single registry entry — no
 * switch statements anywhere in the page.
 */

/**
 * Minimal shape of a connection log row consumed by codegen.
 *
 * Mirrors the subset of fields the renderers actually read from the
 * full backend `ConnectionLog` type so this module stays import-free of
 * the Tauri layer.
 */
export interface CodegenConn {
  method: string;
  url: string;
  request_headers: [string, string][];
  request_body: string | null;
}

/**
 * Function signature every code generator implements.
 *
 * @param conn - Connection log row (subset used by codegen).
 * @returns The generated source snippet, ready to copy into a file or
 *   terminal. Never throws — binary bodies are placeholder-stubbed
 *   inside each renderer so callers can pass any row.
 */
export type CodegenFn = (conn: CodegenConn) => string;

/**
 * Single registry entry. `label` is what the UI renders in the
 * dropdown, `ext` is the file extension for export downloads, and
 * `generate` produces the snippet.
 */
export interface CodegenEntry {
  label: string;
  ext: string;
  generate: CodegenFn;
}

// ---------------------------------------------------------------------------
// Internal quoting helpers — kept module-private; renderers are pure.
// ---------------------------------------------------------------------------

/**
 * POSIX-shell single-quote a value, escaping embedded single quotes.
 *
 * @param s - Arbitrary input string.
 * @returns The value wrapped in single quotes, safe to paste into a
 *   `bash`/`zsh` command line.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * JSON-quote a value for embedding in Python source. JSON strings are
 * a valid Python literal subset, so this is the cheapest correct quoter.
 *
 * @param s - Arbitrary input string.
 * @returns A double-quoted Python string literal.
 */
function pyQuote(s: string): string {
  return JSON.stringify(s);
}

/**
 * Resolve the request body and a binary flag.
 *
 * Binary bodies arrive as `data:<mime>;base64,...` URIs (see
 * `ConnectionsPage.tsx` / `parse_response` in `proxy.rs`). Echoing the
 * base64 back into a generated curl command would just confuse anyone
 * pasting it into a terminal — we placeholder-stub it instead so the
 * snippet still parses but obviously needs a binary file.
 *
 * @param conn - Connection log row.
 * @returns `[bodyForCode, hasBody]` where `hasBody` is `false` for
 *   GET/HEAD or empty payloads.
 */
function resolveBody(conn: CodegenConn): [string, boolean] {
  const body = conn.request_body ?? '';
  const hasBody = body.length > 0 && conn.method !== 'GET' && conn.method !== 'HEAD';
  const isBinary = body.startsWith('data:');
  const bodyForCode = isBinary ? '<binary body — see request in Proxie>' : body;
  return [bodyForCode, hasBody];
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Emit a multi-line `curl` invocation with explicit method and headers.
 *
 * Long lines are split on `\` continuations so the snippet stays
 * legible in a narrow terminal pane.
 */
const curlGenerate: CodegenFn = (conn) => {
  const [body, hasBody] = resolveBody(conn);
  const lines = [`curl -X ${conn.method} ${shellQuote(conn.url)}`];
  for (const [k, v] of conn.request_headers ?? []) {
    lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (hasBody) {
    lines.push(`  --data-raw ${shellQuote(body)}`);
  }
  return lines.join(' \\\n');
};

/**
 * Emit a Python snippet using the `requests` library — the de-facto
 * standard HTTP client for one-off scripts.
 */
const pythonGenerate: CodegenFn = (conn) => {
  const [body, hasBody] = resolveBody(conn);
  const headers = conn.request_headers ?? [];
  const hdrEntries = headers.map(([k, v]) => `    ${pyQuote(k)}: ${pyQuote(v)},`).join('\n');
  const lines = [
    'import requests',
    '',
    `url = ${pyQuote(conn.url)}`,
    `headers = {\n${hdrEntries}\n}`,
  ];
  if (hasBody) {
    lines.push(`data = ${pyQuote(body)}`);
    lines.push(
      `resp = requests.request(${pyQuote(conn.method)}, url, headers=headers, data=data)`,
    );
  } else {
    lines.push(`resp = requests.request(${pyQuote(conn.method)}, url, headers=headers)`);
  }
  lines.push('print(resp.status_code)');
  lines.push('print(resp.text)');
  return lines.join('\n');
};

/**
 * Emit a Node snippet using the global `fetch` (available since Node 18).
 */
const nodeGenerate: CodegenFn = (conn) => {
  const [body, hasBody] = resolveBody(conn);
  const headers = conn.request_headers ?? [];
  const hdrLines = headers
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n');
  const initLines: string[] = [`  method: ${JSON.stringify(conn.method)},`];
  initLines.push(`  headers: {\n${hdrLines}\n  },`);
  if (hasBody) initLines.push(`  body: ${JSON.stringify(body)},`);
  return [
    `const url = ${JSON.stringify(conn.url)};`,
    `const resp = await fetch(url, {`,
    initLines.join('\n'),
    `});`,
    `console.log(resp.status);`,
    `console.log(await resp.text());`,
  ].join('\n');
};

/**
 * The single source of truth for available codegen languages.
 *
 * To add a new language (e.g. java, c#) drop one new entry here — the
 * Connections page reads `CODEGEN_LANGS` to render dropdown items and
 * dispatches via `CODEGEN[lang].generate(conn)`.
 */
export const CODEGEN: Record<string, CodegenEntry> = {
  curl: { label: 'curl', ext: 'sh', generate: curlGenerate },
  python: { label: 'python (requests)', ext: 'py', generate: pythonGenerate },
  node: { label: 'node (fetch)', ext: 'js', generate: nodeGenerate },
};

/**
 * Stable iteration order for UI menus. `Object.keys` happens to be
 * insertion-ordered in modern engines but we pin it explicitly so a
 * future re-ordering of `CODEGEN` doesn't quietly shuffle the menu.
 */
export const CODEGEN_LANGS: readonly string[] = ['curl', 'python', 'node'];

/**
 * Generate a multi-connection bundle: one snippet per connection
 * separated by a language-appropriate hard divider.
 *
 * @param lang - Registry key (e.g. `'curl'`, `'python'`).
 * @param conns - Connections to render.
 * @returns A single text blob suitable for writing to a file. Unknown
 *   languages return an empty string (callers should validate against
 *   `CODEGEN_LANGS` first).
 */
export function generateBundle(lang: string, conns: CodegenConn[]): string {
  const entry = CODEGEN[lang];
  if (!entry) return '';
  const sep = lang === 'python' || lang === 'node' ? '\n\n# ---\n\n' : '\n\n# ---\n\n';
  return conns.map((c) => entry.generate(c)).join(sep);
}
