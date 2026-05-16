import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  TextField,
  IconButton,
  Switch,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import { invoke } from '@tauri-apps/api/core';

/**
 * Persisted block rule shape. Mirrors `src-tauri/src/types.rs::BlockRule`.
 */
interface BlockRule {
  id: string;
  host_pattern: string;
  /** When null, the rule matches every path on the host. */
  path_pattern: string | null;
  enabled: boolean;
  note: string;
}

/**
 * Bundled opt-in seed list. Small and curated on purpose — we explicitly
 * do NOT ship EasyList (size + licensing). Users click "Seed defaults"
 * to add these as disabled-by-default rules they can then toggle.
 */
const SEED_DEFAULTS: Array<{ host_pattern: string; note: string }> = [
  { host_pattern: '*.doubleclick.net', note: 'Google ad serving' },
  { host_pattern: '*.googlesyndication.com', note: 'Google ads' },
  { host_pattern: '*.googletagmanager.com', note: 'Google Tag Manager (tracking)' },
  { host_pattern: '*.google-analytics.com', note: 'Google Analytics' },
  { host_pattern: '*.adsystem.amazon.com', note: 'Amazon ads' },
  { host_pattern: '*.facebook.net', note: 'Facebook pixel / SDK' },
  { host_pattern: '*.scorecardresearch.com', note: 'comScore tracking' },
  { host_pattern: '*.hotjar.com', note: 'Hotjar session recording' },
];

/**
 * Pi-hole style block-rules CRUD page. Matching rules short-circuit
 * requests with 204 No Content (HTTP / decrypted HTTPS) or 403 on the
 * raw CONNECT path. See `src-tauri/src/proxy.rs::serve_block_*`.
 */
export default function BlockRulesPage() {
  const [rules, setRules] = useState<BlockRule[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<BlockRule | null>(null);
  const [formHost, setFormHost] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formNote, setFormNote] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadRules();
  }, []);

  /** Reload rules from the Rust backend. */
  const loadRules = async () => {
    try {
      const data = await invoke<BlockRule[]>('get_block_rules');
      setRules(data ?? []);
    } catch (e) {
      console.error('Failed to load block rules:', e);
    }
  };

  /** Open the dialog in "add" mode with empty fields. */
  const handleAdd = () => {
    setEditingRule(null);
    setFormHost('');
    setFormPath('');
    setFormNote('');
    setDialogOpen(true);
  };

  /** Open the dialog in "edit" mode, pre-filling fields from `rule`. */
  const handleEdit = (rule: BlockRule) => {
    setEditingRule(rule);
    setFormHost(rule.host_pattern);
    setFormPath(rule.path_pattern ?? '');
    setFormNote(rule.note);
    setDialogOpen(true);
  };

  /**
   * Persist the dialog state — creates a new rule when `editingRule` is
   * null, otherwise updates the existing rule by id.
   */
  const handleSave = async () => {
    const trimmedPath = formPath.trim();
    try {
      if (editingRule) {
        const updated: BlockRule = {
          ...editingRule,
          host_pattern: formHost.trim(),
          path_pattern: trimmedPath ? trimmedPath : null,
          note: formNote.trim(),
        };
        const data = await invoke<BlockRule[]>('update_block_rule', { rule: updated });
        setRules(data);
      } else {
        const newRule: BlockRule = {
          id: crypto.randomUUID(),
          host_pattern: formHost.trim(),
          path_pattern: trimmedPath ? trimmedPath : null,
          enabled: true,
          note: formNote.trim(),
        };
        const data = await invoke<BlockRule[]>('add_block_rule', { rule: newRule });
        setRules(data);
      }
      setDialogOpen(false);
    } catch (e) {
      console.error('Failed to save block rule:', e);
    }
  };

  /** Flip the `enabled` flag without opening the dialog. */
  const handleToggle = async (rule: BlockRule) => {
    try {
      const updated = { ...rule, enabled: !rule.enabled };
      const data = await invoke<BlockRule[]>('update_block_rule', { rule: updated });
      setRules(data);
    } catch (e) {
      console.error('Failed to toggle block rule:', e);
    }
  };

  /** Two-step delete — opens the confirm dialog. */
  const handleRequestDelete = (id: string) => {
    setConfirmDeleteId(id);
  };

  /** Execute the confirmed delete. */
  const handleConfirmDelete = async () => {
    if (!confirmDeleteId) return;
    try {
      const data = await invoke<BlockRule[]>('delete_block_rule', { id: confirmDeleteId });
      setRules(data);
    } catch (e) {
      console.error('Failed to delete block rule:', e);
    } finally {
      setConfirmDeleteId(null);
    }
  };

  /**
   * Add the curated default ad/tracker hosts as disabled-by-default rules.
   * Users must explicitly enable each one — we never ship an opt-out list.
   */
  const handleSeedDefaults = async () => {
    try {
      let current = rules;
      for (const seed of SEED_DEFAULTS) {
        const alreadyHas = current.some((r) => r.host_pattern === seed.host_pattern);
        if (alreadyHas) continue;
        const newRule: BlockRule = {
          id: crypto.randomUUID(),
          host_pattern: seed.host_pattern,
          path_pattern: null,
          enabled: false,
          note: seed.note,
        };
        current = await invoke<BlockRule[]>('add_block_rule', { rule: newRule });
      }
      setRules(current);
    } catch (e) {
      console.error('Failed to seed defaults:', e);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant='h5'>
          <BlockIcon sx={{ verticalAlign: 'middle', mr: 1 }} fontSize='small' />
          Block Rules
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant='outlined' onClick={handleSeedDefaults} data-testid='seed-defaults'>
            Seed Defaults
          </Button>
          <Button variant='contained' startIcon={<AddIcon />} onClick={handleAdd}>
            Add Rule
          </Button>
        </Box>
      </Box>

      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Block ad/tracker hosts at the proxy layer (Pi-hole style). Matching requests are
        short-circuited with <code>204 No Content</code> (HTTP / decrypted HTTPS) or
        <code> 403 Forbidden</code> on the raw CONNECT path — no upstream socket opened.
        Use wildcards like <code>*.doubleclick.net</code> for subdomain blocking. Leave the
        path pattern empty to block every path on the host.
      </Typography>

      <Alert severity='info' sx={{ mb: 2 }}>
        <strong>Seed Defaults</strong> adds a small curated list of well-known ad/tracker hosts
        as <em>disabled</em> rules. Review and enable individually — Proxie never ships an
        opt-out block list.
      </Alert>

      <Card>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <Table size='small'>
            <TableHead>
              <TableRow>
                <TableCell>Enabled</TableCell>
                <TableCell>Host Pattern</TableCell>
                <TableCell>Path Pattern</TableCell>
                <TableCell>Note</TableCell>
                <TableCell align='right'>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align='center' sx={{ py: 4 }}>
                    <Typography variant='body2' color='text.secondary'>
                      No block rules configured. Add one or click <strong>Seed Defaults</strong>{' '}
                      to start.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rules.map((rule) => (
                <TableRow key={rule.id} data-testid={`block-rule-row-${rule.id}`}>
                  <TableCell>
                    <Switch
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                      size='small'
                      slotProps={{ input: { 'aria-label': `toggle ${rule.host_pattern}` } }}
                    />
                  </TableCell>
                  <TableCell>
                    <code>{rule.host_pattern}</code>
                  </TableCell>
                  <TableCell>
                    {rule.path_pattern ? <code>{rule.path_pattern}</code> : <em>(any path)</em>}
                  </TableCell>
                  <TableCell>
                    <Typography variant='caption' color='text.secondary'>
                      {rule.note}
                    </Typography>
                  </TableCell>
                  <TableCell align='right'>
                    <IconButton
                      size='small'
                      onClick={() => handleEdit(rule)}
                      aria-label={`edit ${rule.host_pattern}`}>
                      <EditIcon fontSize='small' />
                    </IconButton>
                    <IconButton
                      size='small'
                      onClick={() => handleRequestDelete(rule.id)}
                      aria-label={`delete ${rule.host_pattern}`}>
                      <DeleteIcon fontSize='small' />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth='sm' fullWidth>
        <DialogTitle>{editingRule ? 'Edit Block Rule' : 'Add Block Rule'}</DialogTitle>
        <DialogContent>
          <TextField
            label='Host Pattern'
            placeholder='*.doubleclick.net or ads.example.com'
            value={formHost}
            onChange={(e) => setFormHost(e.target.value)}
            fullWidth
            margin='normal'
            size='small'
            slotProps={{ htmlInput: { 'data-testid': 'host-pattern-input' } }}
          />
          <TextField
            label='Path Pattern (optional)'
            placeholder='/ads/* — leave empty to block every path on the host'
            value={formPath}
            onChange={(e) => setFormPath(e.target.value)}
            fullWidth
            margin='normal'
            size='small'
            slotProps={{ htmlInput: { 'data-testid': 'path-pattern-input' } }}
          />
          <TextField
            label='Note'
            placeholder='ad blocker / tracker / etc.'
            value={formNote}
            onChange={(e) => setFormNote(e.target.value)}
            fullWidth
            margin='normal'
            size='small'
            slotProps={{ htmlInput: { 'data-testid': 'note-input' } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant='contained'
            onClick={handleSave}
            disabled={!formHost.trim()}
            data-testid='save-block-rule'>
            {editingRule ? 'Update' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete-confirmation dialog */}
      <Dialog open={!!confirmDeleteId} onClose={() => setConfirmDeleteId(null)}>
        <DialogTitle>Delete this block rule?</DialogTitle>
        <DialogContent>
          <Typography variant='body2'>This cannot be undone.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
          <Button
            color='error'
            variant='contained'
            onClick={handleConfirmDelete}
            data-testid='confirm-delete'>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
