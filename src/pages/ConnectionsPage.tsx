import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  TextField,
  Tooltip,
  Card,
  CardContent,
  Drawer,
  Select,
  MenuItem,
  FormControl,
  OutlinedInput,
  Stack,
  Button,
  Snackbar,
  Alert,
  InputAdornment,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SearchIcon from '@mui/icons-material/Search';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ColumnsButton,
  loadVisibleColumns,
  saveVisibleColumns,
  bodyPreview,
  pickContentType,
  type ColumnSpec,
} from '../components/ConnectionsColumnPicker';

interface ConnectionLog {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
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
  intercepted: boolean;
  /** True when the request was short-circuited by a block rule. */
  blocked?: boolean;
}

function statusColor(status: number | null): 'success' | 'warning' | 'error' | 'default' {
  if (!status) return 'default';
  if (status < 300) return 'success';
  if (status < 400) return 'warning';
  return 'error';
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function DurationBar({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const maxMs = 5000;
  const width = Math.min((ms / maxMs) * 100, 100);
  const color = ms < 200 ? '#4caf50' : ms < 1000 ? '#ff9800' : '#f44336';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{ width: 60, height: 6, bgcolor: 'grey.800', borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ width: `${width}%`, height: '100%', bgcolor: color, borderRadius: 1 }} />
      </Box>
      <Typography variant='caption'>{formatDuration(ms)}</Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Body decoding — server sends either plain UTF-8 text OR a
// `data:<mime>;base64,<payload>` URI for non-text content.
// ---------------------------------------------------------------------------

interface DecodedBody {
  isDataUri: boolean;
  mime: string;
  /** When isDataUri = false this is the original text. */
  text: string;
  /** When isDataUri = true this is the full `data:` URI (suitable for src=). */
  dataUri: string;
  /** Decoded byte length for binary, or text byte length. */
  byteLength: number;
}

function decodeBody(body: string | null, contentTypeHint: string | null): DecodedBody | null {
  if (body == null) return null;
  if (body.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(body);
    if (match) {
      const mime = match[1].trim() || contentTypeHint || 'application/octet-stream';
      const b64 = match[2];
      let byteLength = 0;
      try {
        const bin = atob(b64);
        byteLength = bin.length;
      } catch {
        byteLength = b64.length;
      }
      return { isDataUri: true, mime, text: '', dataUri: body, byteLength };
    }
  }
  const mime = (contentTypeHint ?? 'text/plain').split(';')[0].trim();
  return {
    isDataUri: false,
    mime: mime || 'text/plain',
    text: body,
    dataUri: '',
    byteLength: body.length,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers — best-effort pretty printers for JSON/XML/HTML/CSS/JS.
// Pure client-side, no external deps. Returns null on failure (caller keeps original).
// ---------------------------------------------------------------------------

function formatJson(s: string): string | null {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

function formatXml(s: string): string | null {
  try {
    // Tag-by-tag re-indent. Naive but adequate for HAR-style payloads.
    const PADDING = '  ';
    const reg = /(>)(<)(\/*)/g;
    let xml = s.replace(/^\s+|\s+$/g, '').replace(reg, '$1\n$2$3');
    let pad = 0;
    const out: string[] = [];
    for (const line of xml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^<\/[^>]+>$/.test(trimmed)) pad = Math.max(pad - 1, 0);
      out.push(PADDING.repeat(pad) + trimmed);
      const isSelfClosing = /^<[^!?][^>]*\/>$/.test(trimmed) || /^<\?/.test(trimmed) || /^<!/.test(trimmed);
      const isOpenAndClose = /^<([^\s/>]+)[^>]*>.*<\/\1>$/.test(trimmed);
      if (/^<[^!?/][^>]*[^/]>$/.test(trimmed) && !isSelfClosing && !isOpenAndClose) pad++;
    }
    return out.join('\n');
  } catch {
    return null;
  }
}

function formatCssOrJs(s: string): string | null {
  try {
    let depth = 0;
    let out = '';
    let inStr: '"' | "'" | '`' | null = null;
    let prev = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        out += ch;
        if (ch === inStr && prev !== '\\') inStr = null;
        prev = ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        out += ch;
        prev = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        out += '{\n' + '  '.repeat(depth);
      } else if (ch === '}') {
        depth = Math.max(depth - 1, 0);
        out = out.replace(/\s+$/, '') + '\n' + '  '.repeat(depth) + '}';
        if (s[i + 1] && s[i + 1] !== ';' && s[i + 1] !== ',' && s[i + 1] !== ')') {
          out += '\n' + '  '.repeat(depth);
        }
      } else if (ch === ';') {
        out += ';\n' + '  '.repeat(depth);
      } else if (ch === '\n' || ch === '\r') {
        // collapse — our own newlines take over.
      } else {
        out += ch;
      }
      prev = ch;
    }
    return out.replace(/\n\s*\n+/g, '\n').trim();
  } catch {
    return null;
  }
}

/**
 * Pick a formatter based on MIME. Returns null when no formatter matches or
 * formatting itself failed (caller should fall back to the original string).
 */
function formatByMime(s: string, mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.includes('json')) return formatJson(s);
  if (m.includes('xml') || m.includes('html')) return formatXml(s);
  if (m.includes('css')) return formatCssOrJs(s);
  if (m.includes('javascript') || m.includes('ecmascript')) return formatCssOrJs(s);
  // Plain text: nothing to do.
  return null;
}

function isFormatterMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m.includes('json') ||
    m.includes('xml') ||
    m.includes('html') ||
    m.includes('css') ||
    m.includes('javascript') ||
    m.includes('ecmascript')
  );
}

// ---------------------------------------------------------------------------
// Save helpers — trigger a browser download from the in-page webview.
// ---------------------------------------------------------------------------

function downloadFromString(text: string, mime: string, filename: string) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadFromDataUri(dataUri: string, filename: string) {
  // <a href="data:..." download> works directly in the webview.
  triggerDownload(dataUri, filename);
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const EXT_BY_MIME: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/css': 'css',
  'text/plain': 'txt',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/octet-stream': 'bin',
};

function inferFilename(url: string, mime: string, suffix: string): string {
  let base = 'body';
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) base = seg.split('?')[0].split('#')[0];
  } catch {
    // Bare URL — keep "body".
  }
  const hasExt = /\.[a-z0-9]+$/i.test(base);
  if (hasExt) return `${base}.${suffix}`.replace(/(\.[^.]+)\.\1?$/, '$1');
  const ext = EXT_BY_MIME[mime.toLowerCase()] || 'txt';
  return `${base}-${suffix}.${ext}`;
}

// ---------------------------------------------------------------------------
// Code generators for curl / python-requests / node fetch.
// ---------------------------------------------------------------------------

type CodegenLang = 'curl' | 'python' | 'node';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pyQuote(s: string): string {
  return JSON.stringify(s);
}

function generateCode(conn: ConnectionLog, lang: CodegenLang): string {
  const headers = conn.request_headers ?? [];
  const body = conn.request_body ?? '';
  const hasBody = body.length > 0 && conn.method !== 'GET' && conn.method !== 'HEAD';
  // For binary bodies we placeholder-out the payload — base64 round-tripping
  // would just confuse the user pasting this into a terminal.
  const isBinaryBody = body.startsWith('data:');
  const bodyForCode = isBinaryBody ? '<binary body — see request in Proxie>' : body;

  if (lang === 'curl') {
    const lines = [`curl -X ${conn.method} ${shellQuote(conn.url)}`];
    for (const [k, v] of headers) {
      lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
    }
    if (hasBody) {
      lines.push(`  --data-raw ${shellQuote(bodyForCode)}`);
    }
    return lines.join(' \\\n');
  }

  if (lang === 'python') {
    const hdrEntries = headers.map(([k, v]) => `    ${pyQuote(k)}: ${pyQuote(v)},`).join('\n');
    const lines = [
      'import requests',
      '',
      `url = ${pyQuote(conn.url)}`,
      `headers = {\n${hdrEntries}\n}` || 'headers = {}',
    ];
    if (hasBody) {
      lines.push(`data = ${pyQuote(bodyForCode)}`);
      lines.push(
        `resp = requests.request(${pyQuote(conn.method)}, url, headers=headers, data=data)`,
      );
    } else {
      lines.push(`resp = requests.request(${pyQuote(conn.method)}, url, headers=headers)`);
    }
    lines.push('print(resp.status_code)');
    lines.push('print(resp.text)');
    return lines.join('\n');
  }

  // node fetch
  const hdrLines = headers.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
  const initLines: string[] = [`  method: ${JSON.stringify(conn.method)},`];
  initLines.push(`  headers: {\n${hdrLines}\n  },`);
  if (hasBody) initLines.push(`  body: ${JSON.stringify(bodyForCode)},`);
  return [
    `const url = ${JSON.stringify(conn.url)};`,
    `const resp = await fetch(url, {`,
    initLines.join('\n'),
    `});`,
    `console.log(resp.status);`,
    `console.log(await resp.text());`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Column-filter state & helpers
// ---------------------------------------------------------------------------

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT'];
const STATUS_BUCKETS = [
  { label: '1xx', test: (s: number) => s >= 100 && s < 200 },
  { label: '2xx', test: (s: number) => s >= 200 && s < 300 },
  { label: '3xx', test: (s: number) => s >= 300 && s < 400 },
  { label: '4xx', test: (s: number) => s >= 400 && s < 500 },
  { label: '5xx', test: (s: number) => s >= 500 && s < 600 },
];
const TIME_WINDOWS: { label: string; ms: number | null }[] = [
  { label: 'Any', ms: null },
  { label: 'Last 5 min', ms: 5 * 60 * 1000 },
  { label: 'Last 15 min', ms: 15 * 60 * 1000 },
  { label: 'Last 1 h', ms: 60 * 60 * 1000 },
  { label: 'Last 6 h', ms: 6 * 60 * 60 * 1000 },
  { label: 'Last 24 h', ms: 24 * 60 * 60 * 1000 },
];

type Op = '>=' | '<=';

interface ColumnFilters {
  methods: string[];
  statusBuckets: string[];
  urlContains: string;
  durationOp: Op;
  durationValue: string;
  sizeOp: Op;
  sizeValue: string;
  timeWindowMs: number | null;
}

const DEFAULT_FILTERS: ColumnFilters = {
  methods: [],
  statusBuckets: [],
  urlContains: '',
  durationOp: '>=',
  durationValue: '',
  sizeOp: '>=',
  sizeValue: '',
  timeWindowMs: null,
};

function matchesColumnFilters(c: ConnectionLog, f: ColumnFilters, now: number): boolean {
  if (f.methods.length > 0 && !f.methods.includes(c.method.toUpperCase())) return false;
  if (f.statusBuckets.length > 0) {
    if (c.status == null) return false;
    const inBucket = STATUS_BUCKETS.some(
      (b) => f.statusBuckets.includes(b.label) && b.test(c.status as number),
    );
    if (!inBucket) return false;
  }
  if (f.urlContains.trim()) {
    if (!c.url.toLowerCase().includes(f.urlContains.toLowerCase().trim())) return false;
  }
  if (f.durationValue.trim()) {
    const v = Number(f.durationValue);
    if (Number.isFinite(v)) {
      const ms = c.duration_ms;
      if (ms == null) return false;
      if (f.durationOp === '>=' && !(ms >= v)) return false;
      if (f.durationOp === '<=' && !(ms <= v)) return false;
    }
  }
  if (f.sizeValue.trim()) {
    const v = Number(f.sizeValue);
    if (Number.isFinite(v)) {
      const sz = c.response_size;
      if (sz == null) return false;
      if (f.sizeOp === '>=' && !(sz >= v)) return false;
      if (f.sizeOp === '<=' && !(sz <= v)) return false;
    }
  }
  if (f.timeWindowMs != null) {
    const t = Date.parse(c.timestamp);
    if (!Number.isFinite(t)) return false;
    if (now - t > f.timeWindowMs) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Column registry — drives both the header row and per-row cell rendering.
// ---------------------------------------------------------------------------

/**
 * Authoritative list of columns the user can show / hide on the connections
 * table. The six original columns default to visible; the four new content
 * preview columns default to hidden so existing users don't see a layout
 * shock on upgrade.
 */
const COLUMNS: ColumnSpec[] = [
  { key: 'method', label: 'Method', defaultVisible: true },
  { key: 'url', label: 'URL', defaultVisible: true },
  { key: 'status', label: 'Status', defaultVisible: true },
  { key: 'duration', label: 'Duration', defaultVisible: true },
  { key: 'size', label: 'Size', defaultVisible: true },
  { key: 'time', label: 'Time', defaultVisible: true },
  { key: 'request_content_type', label: 'Req Content-Type', defaultVisible: false },
  { key: 'response_content_type', label: 'Resp Content-Type', defaultVisible: false },
  { key: 'request_body', label: 'Request Body', defaultVisible: false },
  { key: 'response_body', label: 'Response Body', defaultVisible: false },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionLog[]>([]);
  const [filter, setFilter] = useState('');
  const [colFilters, setColFilters] = useState<ColumnFilters>(DEFAULT_FILTERS);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() =>
    loadVisibleColumns(COLUMNS),
  );
  const [selected, setSelected] = useState<ConnectionLog | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; msg: string } | null>(
    null,
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);

  const loadConnections = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = await invoke<ConnectionLog[]>('get_connections');
      setConnections(data ?? []);
    } catch (e) {
      console.error('Failed to load connections:', e);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadConnections();

    const unlisten = listen<ConnectionLog>('proxy:connection', (event) => {
      setConnections((prev) => [...prev, event.payload]);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadConnections]);

  // Auto-reload when the window regains focus or the document becomes visible
  // again. Users frequently background the app while a request is in flight,
  // and we want them to see the latest connections without having to hit the
  // refresh icon. `inFlightRef` (inside `loadConnections`) coalesces overlapping
  // triggers so focus + visibilitychange firing back-to-back does not double-fetch.
  useEffect(() => {
    const handleFocus = () => {
      loadConnections();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadConnections();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadConnections]);

  useEffect(() => {
    if (bottomRef.current && typeof bottomRef.current.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [connections.length]);

  const handleClear = async () => {
    try {
      await invoke('clear_connections');
      setConnections([]);
    } catch (e) {
      console.error('Failed to clear connections:', e);
    }
  };

  const updateVisibleColumns = useCallback((next: Set<string>) => {
    setVisibleColumns(next);
    saveVisibleColumns(next);
  }, []);

  const isVisible = useCallback((key: string) => visibleColumns.has(key), [visibleColumns]);
  const visibleSpecs = useMemo(
    () => COLUMNS.filter((c) => visibleColumns.has(c.key)),
    [visibleColumns],
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    return connections.filter((c) => {
      if (filter) {
        const term = filter.toLowerCase();
        const hit =
          c.url.toLowerCase().includes(term) ||
          c.host.toLowerCase().includes(term) ||
          c.method.toLowerCase().includes(term) ||
          String(c.status).includes(term);
        if (!hit) return false;
      }
      return matchesColumnFilters(c, colFilters, now);
    });
  }, [connections, filter, colFilters]);

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 80px)' }}>
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant='h5'>Connections</Typography>
          <Box sx={{ flex: 1 }}>
            <TextField
              placeholder='Filter by URL, host, method, status...'
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              size='small'
              fullWidth
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position='start'>
                      <SearchIcon fontSize='small' />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>
          <Tooltip title='Refresh'>
            <IconButton size='small' onClick={loadConnections}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title='Clear all'>
            <IconButton size='small' onClick={handleClear}>
              <DeleteSweepIcon />
            </IconButton>
          </Tooltip>
          <ColumnsButton
            columns={COLUMNS}
            visible={visibleColumns}
            onChange={updateVisibleColumns}
          />
        </Box>

        <Card sx={{ flexGrow: 1, overflow: 'auto' }}>
          <Table size='small' stickyHeader>
            <TableHead>
              <TableRow>
                {isVisible('method') && <TableCell width={120}>Method</TableCell>}
                {isVisible('url') && <TableCell>URL</TableCell>}
                {isVisible('status') && <TableCell width={90}>Status</TableCell>}
                {isVisible('duration') && <TableCell width={170}>Duration</TableCell>}
                {isVisible('size') && <TableCell width={130}>Size</TableCell>}
                {isVisible('time') && <TableCell width={130}>Time</TableCell>}
                {isVisible('request_content_type') && (
                  <TableCell width={160}>Req Content-Type</TableCell>
                )}
                {isVisible('response_content_type') && (
                  <TableCell width={160}>Resp Content-Type</TableCell>
                )}
                {isVisible('request_body') && <TableCell>Request Body</TableCell>}
                {isVisible('response_body') && <TableCell>Response Body</TableCell>}
              </TableRow>
              <FilterRow
                filters={colFilters}
                setFilters={setColFilters}
                onReset={() => setColFilters(DEFAULT_FILTERS)}
                isVisible={isVisible}
              />
            </TableHead>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleSpecs.length || 1} align='center' sx={{ py: 4 }}>
                    <Typography variant='body2' color='text.secondary'>
                      {connections.length === 0
                        ? 'No connections yet. Start the proxy and configure your system to use it.'
                        : 'No connections match the filter.'}
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((conn) => (
                <TableRow
                  key={conn.id}
                  hover
                  selected={selected?.id === conn.id}
                  onClick={() => setSelected(conn)}
                  sx={{ cursor: 'pointer' }}>
                  {isVisible('method') && (
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Chip label={conn.method} size='small' variant='outlined' />
                        {conn.intercepted && (
                          <Tooltip title='Response served by an intercept rule (mock or reroute)'>
                            <Chip
                              label='INTERCEPTED'
                              size='small'
                              color='secondary'
                              data-testid='intercepted-badge'
                              sx={{
                                fontSize: '0.65rem',
                                height: 18,
                                '& .MuiChip-label': { px: 0.75 },
                              }}
                            />
                          </Tooltip>
                        )}
                        {conn.blocked && (
                          <Tooltip title='Request blocked by a block rule (Pi-hole style)'>
                            <Chip
                              label='BLOCKED'
                              size='small'
                              color='error'
                              data-testid='blocked-badge'
                              sx={{
                                fontSize: '0.65rem',
                                height: 18,
                                '& .MuiChip-label': { px: 0.75 },
                              }}
                            />
                          </Tooltip>
                        )}
                      </Box>
                    </TableCell>
                  )}
                  {isVisible('url') && (
                    <TableCell
                      sx={{
                        maxWidth: 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                      {conn.url}
                    </TableCell>
                  )}
                  {isVisible('status') && (
                    <TableCell>
                      {conn.status && (
                        <Chip
                          label={conn.status}
                          size='small'
                          color={statusColor(conn.status)}
                          variant='outlined'
                        />
                      )}
                    </TableCell>
                  )}
                  {isVisible('duration') && (
                    <TableCell>
                      <DurationBar ms={conn.duration_ms} />
                    </TableCell>
                  )}
                  {isVisible('size') && (
                    <TableCell>
                      <Typography variant='caption'>
                        {formatBytes(conn.response_size)}
                      </Typography>
                    </TableCell>
                  )}
                  {isVisible('time') && (
                    <TableCell>
                      <Typography variant='caption'>
                        {new Date(conn.timestamp).toLocaleTimeString()}
                      </Typography>
                    </TableCell>
                  )}
                  {isVisible('request_content_type') && (
                    <TableCell data-testid='cell-request_content_type'>
                      <Typography
                        variant='caption'
                        sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                        {pickContentType(conn.request_headers)}
                      </Typography>
                    </TableCell>
                  )}
                  {isVisible('response_content_type') && (
                    <TableCell data-testid='cell-response_content_type'>
                      <Typography
                        variant='caption'
                        sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                        {pickContentType(conn.response_headers)}
                      </Typography>
                    </TableCell>
                  )}
                  {isVisible('request_body') && (
                    <TableCell
                      data-testid='cell-request_body'
                      sx={{
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                      <Typography
                        variant='caption'
                        sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                        {bodyPreview(conn.request_body)}
                      </Typography>
                    </TableCell>
                  )}
                  {isVisible('response_body') && (
                    <TableCell
                      data-testid='cell-response_body'
                      sx={{
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                      <Typography
                        variant='caption'
                        sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                        {bodyPreview(conn.response_body)}
                      </Typography>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              <tr ref={bottomRef as React.RefObject<HTMLTableRowElement>} style={{ display: 'none' }} />
            </TableBody>
          </Table>
        </Card>
      </Box>

      {/* Detail Drawer */}
      <Drawer
        anchor='right'
        open={!!selected}
        onClose={() => setSelected(null)}
        sx={{ '& .MuiDrawer-paper': { width: 520, p: 2 } }}>
        {selected && (
          <DetailDrawerContent
            conn={selected}
            onToast={(t) => setToast(t)}
          />
        )}
      </Drawer>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? (
          <Alert severity={toast.kind} onClose={() => setToast(null)} sx={{ width: '100%' }}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Filter row (rendered as a TableRow inside TableHead)
// ---------------------------------------------------------------------------

function FilterRow({
  filters,
  setFilters,
  onReset,
  isVisible,
}: {
  filters: ColumnFilters;
  setFilters: (next: ColumnFilters) => void;
  onReset: () => void;
  isVisible: (key: string) => boolean;
}) {
  const onMethods = (e: SelectChangeEvent<string[]>) =>
    setFilters({ ...filters, methods: typeof e.target.value === 'string' ? [] : e.target.value });
  const onStatuses = (e: SelectChangeEvent<string[]>) =>
    setFilters({
      ...filters,
      statusBuckets: typeof e.target.value === 'string' ? [] : e.target.value,
    });
  const hasAnyFilter =
    filters.methods.length +
      filters.statusBuckets.length +
      (filters.urlContains.trim() ? 1 : 0) +
      (filters.durationValue.trim() ? 1 : 0) +
      (filters.sizeValue.trim() ? 1 : 0) +
      (filters.timeWindowMs != null ? 1 : 0) >
    0;

  return (
    <TableRow data-testid='column-filter-row' sx={{ '& > th': { py: 0.5 } }}>
      {isVisible('method') && (
        <TableCell>
          <FormControl size='small' fullWidth>
            <Select
              data-testid='method-filter'
              multiple
              displayEmpty
              value={filters.methods}
              onChange={onMethods}
              input={<OutlinedInput sx={{ fontSize: '0.75rem' }} />}
              renderValue={(s) => (s.length === 0 ? 'Any' : s.join(','))}>
              {METHOD_OPTIONS.map((m) => (
                <MenuItem key={m} value={m}>
                  {m}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </TableCell>
      )}
      {isVisible('url') && (
        <TableCell>
          <TextField
            data-testid='url-filter'
            placeholder='contains...'
            value={filters.urlContains}
            onChange={(e) => setFilters({ ...filters, urlContains: e.target.value })}
            size='small'
            fullWidth
            slotProps={{ htmlInput: { style: { fontSize: '0.75rem', padding: 6 } } }}
          />
          {hasAnyFilter && (
            <Button
              data-testid='reset-filters'
              size='small'
              onClick={onReset}
              sx={{ mt: 0.5, fontSize: '0.65rem', minWidth: 0, py: 0 }}>
              reset filters
            </Button>
          )}
        </TableCell>
      )}
      {isVisible('status') && (
        <TableCell>
          <FormControl size='small' fullWidth>
            <Select
              data-testid='status-filter'
              multiple
              displayEmpty
              value={filters.statusBuckets}
              onChange={onStatuses}
              input={<OutlinedInput sx={{ fontSize: '0.75rem' }} />}
              renderValue={(s) => (s.length === 0 ? 'Any' : s.join(','))}>
              {STATUS_BUCKETS.map((b) => (
                <MenuItem key={b.label} value={b.label}>
                  {b.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </TableCell>
      )}
      {isVisible('duration') && (
        <TableCell>
          <Stack direction='row' spacing={0.5}>
            <Select
              data-testid='duration-op'
              size='small'
              value={filters.durationOp}
              onChange={(e) =>
                setFilters({ ...filters, durationOp: e.target.value as Op })
              }
              sx={{ fontSize: '0.75rem', width: 60 }}>
              <MenuItem value='>='>≥</MenuItem>
              <MenuItem value='<='>≤</MenuItem>
            </Select>
            <TextField
              data-testid='duration-value'
              placeholder='ms'
              size='small'
              value={filters.durationValue}
              onChange={(e) => setFilters({ ...filters, durationValue: e.target.value })}
              slotProps={{
                htmlInput: { inputMode: 'numeric', style: { fontSize: '0.75rem', padding: 6 } },
              }}
            />
          </Stack>
        </TableCell>
      )}
      {isVisible('size') && (
        <TableCell>
          <Stack direction='row' spacing={0.5}>
            <Select
              data-testid='size-op'
              size='small'
              value={filters.sizeOp}
              onChange={(e) => setFilters({ ...filters, sizeOp: e.target.value as Op })}
              sx={{ fontSize: '0.75rem', width: 60 }}>
              <MenuItem value='>='>≥</MenuItem>
              <MenuItem value='<='>≤</MenuItem>
            </Select>
            <TextField
              data-testid='size-value'
              placeholder='B'
              size='small'
              value={filters.sizeValue}
              onChange={(e) => setFilters({ ...filters, sizeValue: e.target.value })}
              slotProps={{
                htmlInput: { inputMode: 'numeric', style: { fontSize: '0.75rem', padding: 6 } },
              }}
            />
          </Stack>
        </TableCell>
      )}
      {isVisible('time') && (
        <TableCell>
          <FormControl size='small' fullWidth>
            <Select
              data-testid='time-window'
              value={filters.timeWindowMs == null ? '' : String(filters.timeWindowMs)}
              onChange={(e) => {
                const v = e.target.value;
                setFilters({ ...filters, timeWindowMs: v === '' ? null : Number(v) });
              }}
              displayEmpty
              sx={{ fontSize: '0.75rem' }}>
              {TIME_WINDOWS.map((w) => (
                <MenuItem key={w.label} value={w.ms == null ? '' : String(w.ms)}>
                  {w.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </TableCell>
      )}
      {isVisible('request_content_type') && <TableCell />}
      {isVisible('response_content_type') && <TableCell />}
      {isVisible('request_body') && <TableCell />}
      {isVisible('response_body') && <TableCell />}
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer content (extracted so we can keep per-drawer local state for
// formatted/raw body toggle and codegen language)
// ---------------------------------------------------------------------------

function DetailDrawerContent({
  conn,
  onToast,
}: {
  conn: ConnectionLog;
  onToast: (t: { kind: 'success' | 'error' | 'info'; msg: string }) => void;
}) {
  const [reqDisplay, setReqDisplay] = useState<string | null>(null);
  const [respDisplay, setRespDisplay] = useState<string | null>(null);
  const [codegenLang, setCodegenLang] = useState<CodegenLang>('curl');
  // Reset overrides when switching rows.
  const connId = conn.id;
  useEffect(() => {
    setReqDisplay(null);
    setRespDisplay(null);
  }, [connId]);

  const reqDecoded = decodeBody(conn.request_body, conn.content_type);
  const respDecoded = decodeBody(
    conn.response_body,
    headerLookup(conn.response_headers, 'content-type') ?? conn.content_type,
  );

  const generatedCode = useMemo(() => generateCode(conn, codegenLang), [conn, codegenLang]);

  return (
    <Box>
      <Typography variant='h6' gutterBottom>
        {conn.method} {conn.path}
      </Typography>
      <Chip label={conn.status ?? 'pending'} color={statusColor(conn.status)} sx={{ mb: 2 }} />

      <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
        General
      </Typography>
      <DetailRow
        label='Intercepted'
        value={conn.intercepted ? 'yes' : 'no'}
        highlight={conn.intercepted}
      />
      <DetailRow
        label='Blocked'
        value={conn.blocked ? 'yes' : 'no'}
        highlight={!!conn.blocked}
      />
      <DetailRow label='URL' value={conn.url} />
      <DetailRow label='Host' value={conn.host} />
      <DetailRow label='Duration' value={formatDuration(conn.duration_ms)} />
      <DetailRow label='Request Size' value={formatBytes(conn.request_size)} />
      <DetailRow label='Response Size' value={formatBytes(conn.response_size)} />
      <DetailRow label='Content-Type' value={conn.content_type ?? '-'} />
      <DetailRow label='Timestamp' value={new Date(conn.timestamp).toLocaleString()} />

      {conn.request_headers.length > 0 && (
        <>
          <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
            Request Headers
          </Typography>
          {conn.request_headers.map(([k, v], i) => (
            <DetailRow key={i} label={k} value={v} />
          ))}
        </>
      )}

      {conn.response_headers.length > 0 && (
        <>
          <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
            Response Headers
          </Typography>
          {conn.response_headers.map(([k, v], i) => (
            <DetailRow key={i} label={k} value={v} />
          ))}
        </>
      )}

      {reqDecoded && (
        <BodySection
          title='Request Body'
          decoded={reqDecoded}
          override={reqDisplay}
          onFormat={() => {
            if (reqDecoded.isDataUri) {
              onToast({ kind: 'info', msg: 'Cannot format a binary body.' });
              return;
            }
            const out = formatByMime(reqDecoded.text, reqDecoded.mime);
            if (out == null) {
              onToast({ kind: 'error', msg: `No formatter available for ${reqDecoded.mime}.` });
              return;
            }
            setReqDisplay(out);
            onToast({ kind: 'success', msg: 'Body formatted.' });
          }}
          onSave={() => {
            const name = inferFilename(conn.url, reqDecoded.mime, 'request');
            if (reqDecoded.isDataUri) downloadFromDataUri(reqDecoded.dataUri, name);
            else downloadFromString(reqDisplay ?? reqDecoded.text, reqDecoded.mime, name);
            onToast({ kind: 'success', msg: `Saving ${name}…` });
          }}
        />
      )}

      {respDecoded && (
        <BodySection
          title='Response Body'
          decoded={respDecoded}
          override={respDisplay}
          onFormat={() => {
            if (respDecoded.isDataUri) {
              onToast({ kind: 'info', msg: 'Cannot format a binary body.' });
              return;
            }
            const out = formatByMime(respDecoded.text, respDecoded.mime);
            if (out == null) {
              onToast({ kind: 'error', msg: `No formatter available for ${respDecoded.mime}.` });
              return;
            }
            setRespDisplay(out);
            onToast({ kind: 'success', msg: 'Body formatted.' });
          }}
          onSave={() => {
            const name = inferFilename(conn.url, respDecoded.mime, 'response');
            if (respDecoded.isDataUri) downloadFromDataUri(respDecoded.dataUri, name);
            else downloadFromString(respDisplay ?? respDecoded.text, respDecoded.mime, name);
            onToast({ kind: 'success', msg: `Saving ${name}…` });
          }}
        />
      )}

      <Typography variant='subtitle2' sx={{ mt: 3, mb: 1 }}>
        Generate code
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <FormControl size='small'>
          <Select
            data-testid='codegen-lang'
            value={codegenLang}
            onChange={(e) => setCodegenLang(e.target.value as CodegenLang)}
            sx={{ fontSize: '0.8rem' }}>
            <MenuItem value='curl'>curl</MenuItem>
            <MenuItem value='python'>python (requests)</MenuItem>
            <MenuItem value='node'>node (fetch)</MenuItem>
          </Select>
        </FormControl>
        <Tooltip title='Copy to clipboard'>
          <IconButton
            size='small'
            data-testid='codegen-copy'
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(generatedCode);
                onToast({ kind: 'success', msg: 'Copied to clipboard.' });
              } catch (e) {
                onToast({ kind: 'error', msg: `Copy failed: ${String(e)}` });
              }
            }}>
            <ContentCopyIcon fontSize='small' />
          </IconButton>
        </Tooltip>
      </Box>
      <Card variant='outlined' data-testid='codegen-output'>
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <pre style={{ margin: 0, fontSize: '0.75em', whiteSpace: 'pre-wrap' }}>
            {generatedCode}
          </pre>
        </CardContent>
      </Card>
    </Box>
  );
}

function headerLookup(headers: [string, string][], name: string): string | null {
  const lower = name.toLowerCase();
  const match = headers.find(([k]) => k.toLowerCase() === lower);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// BodySection — renders preview (text vs image/video/audio/iframe) + actions.
// ---------------------------------------------------------------------------

function BodySection({
  title,
  decoded,
  override,
  onFormat,
  onSave,
}: {
  title: string;
  decoded: DecodedBody;
  override: string | null;
  onFormat: () => void;
  onSave: () => void;
}) {
  const showText = !decoded.isDataUri;
  const canFormat = showText && isFormatterMime(decoded.mime);

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', mt: 2, mb: 1, gap: 1 }}>
        <Typography variant='subtitle2' sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        {canFormat && (
          <Tooltip title='Pretty-print this body'>
            <Button
              size='small'
              data-testid={`${title.toLowerCase().replace(' ', '-')}-format`}
              startIcon={<AutoFixHighIcon fontSize='small' />}
              onClick={onFormat}>
              Format
            </Button>
          </Tooltip>
        )}
        <Tooltip title='Save to a local file'>
          <Button
            size='small'
            data-testid={`${title.toLowerCase().replace(' ', '-')}-save`}
            startIcon={<DownloadIcon fontSize='small' />}
            onClick={onSave}>
            Save
          </Button>
        </Tooltip>
      </Box>
      <Card variant='outlined'>
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <BodyPreview decoded={decoded} override={override} />
        </CardContent>
      </Card>
    </>
  );
}

function BodyPreview({
  decoded,
  override,
}: {
  decoded: DecodedBody;
  override: string | null;
}) {
  if (decoded.isDataUri) {
    const m = decoded.mime.toLowerCase();
    if (m.startsWith('image/')) {
      return (
        <img
          data-testid='body-preview-image'
          src={decoded.dataUri}
          alt='response body'
          style={{ maxWidth: '100%', display: 'block' }}
        />
      );
    }
    if (m.startsWith('video/')) {
      return (
        <video
          data-testid='body-preview-video'
          controls
          src={decoded.dataUri}
          style={{ maxWidth: '100%', display: 'block' }}
        />
      );
    }
    if (m.startsWith('audio/')) {
      return (
        <audio
          data-testid='body-preview-audio'
          controls
          src={decoded.dataUri}
          style={{ width: '100%', display: 'block' }}
        />
      );
    }
    if (m === 'application/pdf') {
      return (
        <iframe
          data-testid='body-preview-pdf'
          title='response body'
          src={decoded.dataUri}
          style={{ width: '100%', height: 320, border: 0 }}
        />
      );
    }
    return (
      <Typography
        data-testid='body-preview-binary-placeholder'
        variant='caption'
        color='text.secondary'>
        Binary content — {decoded.mime} ({formatBytes(decoded.byteLength)}). Use "Save" to
        download.
      </Typography>
    );
  }

  // Suppress `<pre>` for opaque binary payloads even when the body wasn't
  // encoded as a `data:` URI — `application/octet-stream` bytes are typically
  // compressed / encrypted noise and render as garbled text.
  if (decoded.mime.toLowerCase().startsWith('application/octet-stream')) {
    return (
      <Typography
        data-testid='body-preview-binary-placeholder'
        variant='caption'
        color='text.secondary'>
        Binary content — {decoded.mime} ({formatBytes(decoded.byteLength)}). Use "Save" to
        download.
      </Typography>
    );
  }

  return (
    <pre
      data-testid='body-preview-text'
      style={{ margin: 0, fontSize: '0.8em', whiteSpace: 'pre-wrap' }}>
      {override ?? decoded.text}
    </pre>
  );
}

/**
 * Render a label / value row in the connection detail drawer.
 *
 * @param label - Field label shown in the gutter.
 * @param value - Field value rendered in monospace.
 * @param highlight - When true, paints a warning-tinted background so the row
 *   stands out (used for the "Intercepted: yes" indicator).
 */
function DetailRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Box
      data-testid={highlight ? 'detail-row-highlighted' : undefined}
      sx={{
        display: 'flex',
        py: 0.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: highlight ? 'warning.dark' : 'transparent',
        px: highlight ? 1 : 0,
        borderRadius: highlight ? 1 : 0,
      }}>
      <Typography variant='caption' sx={{ width: 120, flexShrink: 0, color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography
        variant='caption'
        sx={{
          wordBreak: 'break-all',
          fontFamily: 'monospace',
          fontSize: '0.8em',
          fontWeight: highlight ? 600 : 400,
        }}>
        {value}
      </Typography>
    </Box>
  );
}
