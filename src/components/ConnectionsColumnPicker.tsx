/**
 * ConnectionsColumnPicker — popover + checkbox group that toggles column
 * visibility on the connections page. Selection is persisted by the parent
 * via the `onChange` callback; this component is purely presentational over
 * the supplied state.
 *
 * Kept in its own file so concurrent edits to ConnectionsPage.tsx don't
 * conflict with the column-picker work.
 */

import {
  IconButton,
  Tooltip,
  Popover,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Typography,
  Box,
} from '@mui/material';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import { useState } from 'react';

export interface ColumnSpec {
  key: string;
  label: string;
  defaultVisible: boolean;
}

const STORAGE_KEY = 'proxie:connections:visibleColumns';

/**
 * Load the persisted visible-column keys from localStorage.
 *
 * @param columns - Authoritative column registry. Used to seed defaults when
 *   nothing (or a malformed payload) is stored.
 * @returns A Set of column keys that should be visible at mount.
 */
export function loadVisibleColumns(columns: ColumnSpec[]): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return new Set(parsed);
      }
    }
  } catch {
    // Fall through to defaults.
  }
  return new Set(columns.filter((c) => c.defaultVisible).map((c) => c.key));
}

/**
 * Persist the current visible-column set to localStorage.
 *
 * @param visible - Set of column keys currently shown.
 */
export function saveVisibleColumns(visible: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch {
    // localStorage may be unavailable in some embedded webviews — ignore.
  }
}

/**
 * Build a one-line preview for a request/response body cell.
 *
 * Strips newlines, slices to `max` chars, appends an ellipsis if truncated.
 * Returns `(binary)` for `data:` URI bodies and the empty string for null.
 *
 * @param body - Raw body string (may be null or a `data:` URI).
 * @param max - Maximum character count before truncation (default 80).
 */
export function bodyPreview(body: string | null | undefined, max = 80): string {
  if (body == null || body === '') return '';
  if (body.startsWith('data:')) return '(binary)';
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

/**
 * Look up the Content-Type header from a header pair list, case-insensitively.
 *
 * @param headers - Header pairs as emitted by the proxy backend.
 * @returns The header value or `-` when missing.
 */
export function pickContentType(headers: [string, string][] | undefined): string {
  if (!headers) return '-';
  for (const [k, v] of headers) {
    if (k.toLowerCase() === 'content-type') return v;
  }
  return '-';
}

/**
 * ColumnsButton — IconButton + Popover with one checkbox per column.
 *
 * @param columns - Authoritative column registry.
 * @param visible - Current visible-column set (controlled).
 * @param onChange - Callback fired whenever a checkbox toggles. Receives the
 *   new visible-column Set; callers are responsible for persisting it.
 */
export function ColumnsButton({
  columns,
  visible,
  onChange,
}: {
  columns: ColumnSpec[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <>
      <Tooltip title='Show / hide columns'>
        <IconButton
          size='small'
          data-testid='columns-button'
          onClick={(e) => setAnchorEl(e.currentTarget)}>
          <ViewColumnIcon />
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Box sx={{ p: 2, minWidth: 220 }}>
          <Typography variant='subtitle2' sx={{ mb: 1 }}>
            Columns
          </Typography>
          <FormGroup>
            {columns.map((c) => (
              <FormControlLabel
                key={c.key}
                data-testid={`column-toggle-${c.key}`}
                control={
                  <Checkbox
                    size='small'
                    checked={visible.has(c.key)}
                    onChange={() => toggle(c.key)}
                  />
                }
                label={c.label}
              />
            ))}
          </FormGroup>
        </Box>
      </Popover>
    </>
  );
}
