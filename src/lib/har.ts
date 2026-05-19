/**
 * HAR 1.2 exporter for Proxie connection logs.
 *
 * Produces the canonical HAR root shape
 * (`{ log: { version, creator, entries } }`) so the output can be
 * imported into Chrome DevTools, Charles, Fiddler, mitmproxy, etc.
 *
 * Spec reference: http://www.softwareishard.com/blog/har-12-spec/
 */

/**
 * Minimal subset of `ConnectionLog` used by the HAR exporter.
 * Kept independent of the Tauri-side type so this module has no
 * cross-module dependencies.
 */
export interface HarConn {
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
  request_size: number | null;
  response_size: number | null;
  timestamp: string;
  request_headers: [string, string][];
  response_headers: [string, string][];
  request_body: string | null;
  response_body: string | null;
  content_type: string | null;
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: never[];
  headers: HarHeader[];
  queryString: HarHeader[];
  headersSize: number;
  bodySize: number;
  postData?: { mimeType: string; text: string };
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: never[];
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

export interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

/**
 * Best-effort query-string parser for a connection URL.
 *
 * @param url - Absolute URL captured by the proxy.
 * @returns Array of HAR `queryString` entries. Returns `[]` for an
 *   unparseable URL (treated as a non-error — HAR allows empty arrays).
 */
function queryEntries(url: string): HarHeader[] {
  try {
    const u = new URL(url);
    const out: HarHeader[] = [];
    u.searchParams.forEach((value, name) => {
      out.push({ name, value });
    });
    return out;
  } catch {
    return [];
  }
}

/**
 * Convert a `[name, value][]` tuple list to HAR header objects.
 *
 * @param headers - Header pairs from the connection log.
 * @returns HAR-shaped header objects in the same order.
 */
function toHarHeaders(headers: [string, string][]): HarHeader[] {
  return headers.map(([name, value]) => ({ name, value }));
}

/**
 * Build the HAR `content` block for a response body.
 *
 * Binary bodies arrive from the backend as `data:<mime>;base64,<payload>`
 * URIs (see `parse_response` in `src-tauri/src/proxy.rs`). For those we
 * strip the prefix and mark `encoding: 'base64'` — the HAR spec's
 * canonical way to represent non-text payloads.
 *
 * @param body - Raw `response_body` from the connection log.
 * @param contentType - Best-known MIME (header > content_type field).
 * @param size - Reported response size in bytes.
 * @returns A populated `HarContent`. Missing/empty bodies still emit a
 *   minimal `{ size, mimeType }` object so importers don't choke.
 */
function buildContent(
  body: string | null,
  contentType: string | null,
  size: number | null,
): HarContent {
  const mime = (contentType ?? 'text/plain').split(';')[0].trim() || 'text/plain';
  const sz = size ?? (body ? body.length : 0);
  if (body == null) {
    return { size: sz, mimeType: mime };
  }
  if (body.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(body);
    if (m) {
      return {
        size: sz,
        mimeType: m[1].trim() || mime,
        text: m[2],
        encoding: 'base64',
      };
    }
  }
  return { size: sz, mimeType: mime, text: body };
}

/**
 * Pick the first matching header value (case-insensitive).
 *
 * @param headers - Tuple list of header pairs.
 * @param name - Header name to look up.
 * @returns The header value, or `null` when not present.
 */
function headerLookup(headers: [string, string][], name: string): string | null {
  const lower = name.toLowerCase();
  const hit = headers.find(([k]) => k.toLowerCase() === lower);
  return hit ? hit[1] : null;
}

/**
 * Convert one Proxie connection log to a HAR `entry`.
 *
 * @param c - A captured connection.
 * @returns A fully-populated HAR entry. `time = duration_ms` (or 0 when
 *   the proxy never observed a response) so downstream tools can render
 *   a waterfall.
 */
function connToEntry(c: HarConn): HarEntry {
  const reqHeaders = toHarHeaders(c.request_headers);
  const respHeaders = toHarHeaders(c.response_headers);
  const respContentType =
    headerLookup(c.response_headers, 'content-type') ?? c.content_type;
  const reqContentType =
    headerLookup(c.request_headers, 'content-type') ?? c.content_type ?? 'text/plain';

  const postData =
    c.request_body != null && c.request_body.length > 0
      ? { mimeType: reqContentType, text: c.request_body }
      : undefined;

  const startedDateTime = (() => {
    const d = Date.parse(c.timestamp);
    return Number.isFinite(d) ? new Date(d).toISOString() : c.timestamp;
  })();

  return {
    startedDateTime,
    time: c.duration_ms ?? 0,
    request: {
      method: c.method,
      url: c.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: reqHeaders,
      queryString: queryEntries(c.url),
      headersSize: -1,
      bodySize: c.request_size ?? -1,
      ...(postData ? { postData } : {}),
    },
    response: {
      status: c.status ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: respHeaders,
      content: buildContent(c.response_body, respContentType, c.response_size),
      redirectURL: '',
      headersSize: -1,
      bodySize: c.response_size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: c.duration_ms ?? 0, receive: 0 },
  };
}

/**
 * Convert a list of Proxie connection logs to a HAR 1.2 archive.
 *
 * @param conns - Connections to export. Empty list produces a valid HAR
 *   archive with `entries: []`.
 * @param creatorVersion - Version string to stamp into `log.creator`.
 *   Defaults to `'0.0.0'` so tests don't need to pin a real version.
 * @returns A HAR root object — JSON-stringify and download to ship.
 */
export function connectionsToHar(conns: HarConn[], creatorVersion = '0.0.0'): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Proxie', version: creatorVersion },
      entries: conns.map(connToEntry),
    },
  };
}
