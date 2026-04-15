import { useEffect, useState, useCallback, useRef } from 'react';
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
} from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import RefreshIcon from '@mui/icons-material/Refresh';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionLog[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ConnectionLog | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConnections = useCallback(async () => {
    try {
      const data = await invoke<ConnectionLog[]>('get_connections');
      setConnections(data ?? []);
    } catch (e) {
      console.error('Failed to load connections:', e);
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

  const filtered = connections.filter((c) => {
    if (!filter) return true;
    const term = filter.toLowerCase();
    return (
      c.url.toLowerCase().includes(term) ||
      c.host.toLowerCase().includes(term) ||
      c.method.toLowerCase().includes(term) ||
      String(c.status).includes(term)
    );
  });

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 80px)' }}>
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant='h5' sx={{ flexGrow: 1 }}>
            Connections
          </Typography>
          <TextField
            placeholder='Filter by URL, host, method, status...'
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            size='small'
            sx={{ width: 300 }}
          />
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
        </Box>

        <Card sx={{ flexGrow: 1, overflow: 'auto' }}>
          <Table size='small' stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell width={70}>Method</TableCell>
                <TableCell>URL</TableCell>
                <TableCell width={70}>Status</TableCell>
                <TableCell width={140}>Duration</TableCell>
                <TableCell width={80}>Size</TableCell>
                <TableCell width={80}>Time</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align='center' sx={{ py: 4 }}>
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
                  <TableCell>
                    <Chip label={conn.method} size='small' variant='outlined' />
                  </TableCell>
                  <TableCell
                    sx={{
                      maxWidth: 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                    {conn.url}
                  </TableCell>
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
                  <TableCell>
                    <DurationBar ms={conn.duration_ms} />
                  </TableCell>
                  <TableCell>
                    <Typography variant='caption'>{formatBytes(conn.response_size)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant='caption'>
                      {new Date(conn.timestamp).toLocaleTimeString()}
                    </Typography>
                  </TableCell>
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
        sx={{ '& .MuiDrawer-paper': { width: 420, p: 2 } }}>
        {selected && (
          <Box>
            <Typography variant='h6' gutterBottom>
              {selected.method} {selected.path}
            </Typography>
            <Chip
              label={selected.status ?? 'pending'}
              color={statusColor(selected.status)}
              sx={{ mb: 2 }}
            />

            <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
              General
            </Typography>
            <DetailRow label='URL' value={selected.url} />
            <DetailRow label='Host' value={selected.host} />
            <DetailRow label='Duration' value={formatDuration(selected.duration_ms)} />
            <DetailRow label='Request Size' value={formatBytes(selected.request_size)} />
            <DetailRow label='Response Size' value={formatBytes(selected.response_size)} />
            <DetailRow label='Content-Type' value={selected.content_type ?? '-'} />
            <DetailRow label='Timestamp' value={new Date(selected.timestamp).toLocaleString()} />

            {selected.request_headers.length > 0 && (
              <>
                <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
                  Request Headers
                </Typography>
                {selected.request_headers.map(([k, v], i) => (
                  <DetailRow key={i} label={k} value={v} />
                ))}
              </>
            )}

            {selected.response_headers.length > 0 && (
              <>
                <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
                  Response Headers
                </Typography>
                {selected.response_headers.map(([k, v], i) => (
                  <DetailRow key={i} label={k} value={v} />
                ))}
              </>
            )}

            {selected.request_body && (
              <>
                <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
                  Request Body
                </Typography>
                <Card variant='outlined'>
                  <CardContent>
                    <pre style={{ margin: 0, fontSize: '0.8em', whiteSpace: 'pre-wrap' }}>
                      {selected.request_body}
                    </pre>
                  </CardContent>
                </Card>
              </>
            )}

            {selected.response_body && (
              <>
                <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
                  Response Body
                </Typography>
                <Card variant='outlined'>
                  <CardContent>
                    <pre style={{ margin: 0, fontSize: '0.8em', whiteSpace: 'pre-wrap' }}>
                      {selected.response_body}
                    </pre>
                  </CardContent>
                </Card>
              </>
            )}
          </Box>
        )}
      </Drawer>
    </Box>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Typography variant='caption' sx={{ width: 120, flexShrink: 0, color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography
        variant='caption'
        sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.8em' }}>
        {value}
      </Typography>
    </Box>
  );
}
