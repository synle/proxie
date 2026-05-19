import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';

/**
 * Comparison operator for a single URL filter clause.
 *
 * - `contains` — substring match anywhere in the URL.
 * - `exact` — full-string equality.
 * - `startsWith` — prefix match (case-insensitive).
 * - `endsWith` — suffix match (case-insensitive).
 */
export type UrlFilterOp = 'contains' | 'exact' | 'startsWith' | 'endsWith';

/**
 * A single clause inside a `UrlFilters` group.
 *
 * The `id` is a stable identifier used as a React key so clauses can be reordered
 * or removed without re-mounting unrelated rows.
 */
export interface UrlFilterClause {
  id: string;
  op: UrlFilterOp;
  value: string;
}

/**
 * Top-level URL filter container — N clauses combined by an AND/OR combinator.
 *
 * An empty `clauses` array means the URL filter is inactive (no rows are
 * excluded based on URL).
 */
export interface UrlFilters {
  combinator: 'AND' | 'OR';
  clauses: UrlFilterClause[];
}

/**
 * Default URL filter — OR combinator and no clauses (i.e. "match anything").
 */
export const DEFAULT_URL_FILTERS: UrlFilters = {
  combinator: 'OR',
  clauses: [],
};

const OP_LABELS: Record<UrlFilterOp, string> = {
  contains: 'contains',
  exact: 'exact match',
  startsWith: 'begins with',
  endsWith: 'ends with',
};

/**
 * Evaluate a single clause against a URL. Empty clause values are treated as
 * non-matching so users can type incrementally without blanking out the table.
 *
 * @param url - The full URL of the connection row being tested.
 * @param clause - The clause whose operator + value drives the test.
 * @returns `true` when the URL satisfies the clause; `false` for empty values
 *   or unsatisfied operators.
 */
export function evalUrlClause(url: string, clause: UrlFilterClause): boolean {
  const v = clause.value.trim();
  if (!v) return false;
  const u = url.toLowerCase();
  const needle = v.toLowerCase();
  switch (clause.op) {
    case 'contains':
      return u.includes(needle);
    case 'exact':
      return u === needle;
    case 'startsWith':
      return u.startsWith(needle);
    case 'endsWith':
      return u.endsWith(needle);
    default:
      return false;
  }
}

/**
 * Apply the configured URL filter set to a single URL.
 *
 * - Empty clause list → returns `true` (no URL constraint).
 * - `OR` → at least one clause must match.
 * - `AND` → every clause must match.
 *
 * @param url - Full URL of the connection row.
 * @param filters - Current URL filter configuration from the dialog.
 * @returns `true` when the URL passes the filter.
 */
export function matchesUrlFilters(url: string, filters: UrlFilters): boolean {
  if (filters.clauses.length === 0) return true;
  if (filters.combinator === 'AND') {
    return filters.clauses.every((c) => evalUrlClause(url, c));
  }
  return filters.clauses.some((c) => evalUrlClause(url, c));
}

/**
 * Counts only the clauses that have a non-empty trimmed value — used to drive
 * the active-count badge on the column-header trigger button.
 *
 * @param filters - Current URL filter configuration.
 * @returns Number of clauses that will actually influence filtering.
 */
export function activeClauseCount(filters: UrlFilters): number {
  return filters.clauses.filter((c) => c.value.trim().length > 0).length;
}

let CLAUSE_ID_COUNTER = 0;
function newClauseId(): string {
  CLAUSE_ID_COUNTER += 1;
  return `clause-${CLAUSE_ID_COUNTER}-${Date.now()}`;
}

/**
 * Build a new empty clause with the default operator (`contains`).
 *
 * @returns A fresh `UrlFilterClause` ready to be appended to a clause list.
 */
export function newClause(): UrlFilterClause {
  return { id: newClauseId(), op: 'contains', value: '' };
}

/**
 * Multi-clause URL filter editor rendered inside a MUI Dialog.
 *
 * The dialog owns a local draft of the filter state so users can add / edit /
 * remove clauses without affecting the table until they hit "Save". Cancel
 * discards the draft and reverts to the originally-applied filter.
 *
 * @param open - Whether the dialog is currently visible.
 * @param value - The currently-applied filter set (the source of the draft).
 * @param onClose - Called with no args when the dialog should close (Cancel or
 *   backdrop click).
 * @param onSave - Called with the new filter set when the user clicks Save.
 */
export default function UrlFilterDialog({
  open,
  value,
  onClose,
  onSave,
}: {
  open: boolean;
  value: UrlFilters;
  onClose: () => void;
  onSave: (next: UrlFilters) => void;
}) {
  const [draft, setDraft] = useState<UrlFilters>(value);

  // Re-sync the draft whenever the dialog (re-)opens. Editing happens against
  // a local copy so Cancel can discard cleanly.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const updateClause = (id: string, patch: Partial<UrlFilterClause>) => {
    setDraft((d) => ({
      ...d,
      clauses: d.clauses.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const removeClause = (id: string) => {
    setDraft((d) => ({ ...d, clauses: d.clauses.filter((c) => c.id !== id) }));
  };

  const addClause = () => {
    setDraft((d) => ({ ...d, clauses: [...d.clauses, newClause()] }));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth='sm'>
      <DialogTitle>URL filters</DialogTitle>
      <DialogContent dividers>
        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
          Build one or more clauses to filter the URL column. Use the combinator
          at the bottom to require all clauses (AND) or any clause (OR).
        </Typography>
        <Stack spacing={1} sx={{ mt: 1 }}>
          {draft.clauses.length === 0 && (
            <Typography
              data-testid='url-filter-empty-hint'
              variant='caption'
              color='text.secondary'>
              No clauses yet — click "Add clause" to start filtering.
            </Typography>
          )}
          {draft.clauses.map((c, idx) => (
            <Box
              key={c.id}
              data-testid={`url-filter-clause-${idx}`}
              sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <FormControl size='small' sx={{ minWidth: 140 }}>
                <Select
                  data-testid='url-filter-clause-op'
                  value={c.op}
                  onChange={(e) => updateClause(c.id, { op: e.target.value as UrlFilterOp })}>
                  {(Object.keys(OP_LABELS) as UrlFilterOp[]).map((op) => (
                    <MenuItem key={op} value={op}>
                      {OP_LABELS[op]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                size='small'
                fullWidth
                placeholder='URL fragment…'
                value={c.value}
                onChange={(e) => updateClause(c.id, { value: e.target.value })}
                slotProps={{ htmlInput: { 'data-testid': 'url-filter-clause-value' } }}
              />
              <IconButton
                data-testid='url-filter-clause-remove'
                size='small'
                aria-label='remove clause'
                onClick={() => removeClause(c.id)}>
                <DeleteIcon fontSize='small' />
              </IconButton>
            </Box>
          ))}
          <Box>
            <Button
              size='small'
              data-testid='url-filter-add-clause'
              startIcon={<AddIcon />}
              onClick={addClause}>
              Add clause
            </Button>
          </Box>
        </Stack>
        <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant='body2' sx={{ flexGrow: 1 }}>
            Combine clauses with:
          </Typography>
          <ToggleButtonGroup
            size='small'
            exclusive
            value={draft.combinator}
            onChange={(_e, v) => {
              if (v === 'AND' || v === 'OR') {
                setDraft((d) => ({ ...d, combinator: v }));
              }
            }}>
            <ToggleButton data-testid='url-filter-combinator-OR' value='OR'>
              OR
            </ToggleButton>
            <ToggleButton data-testid='url-filter-combinator-AND' value='AND'>
              AND
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button data-testid='url-filter-cancel' onClick={onClose}>
          Cancel
        </Button>
        <Button
          data-testid='url-filter-save'
          variant='contained'
          onClick={() => onSave(draft)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
