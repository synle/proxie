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
  Chip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import { invoke } from '@tauri-apps/api/core';

interface HostRule {
  id: string;
  host: string;
  enabled: boolean;
  ignore_paths: string[];
}

export default function HostRulesPage() {
  const [rules, setRules] = useState<HostRule[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<HostRule | null>(null);
  const [formHost, setFormHost] = useState('');
  const [formIgnorePaths, setFormIgnorePaths] = useState('');

  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    try {
      const data = await invoke<HostRule[]>('get_host_rules');
      setRules(data);
    } catch (e) {
      console.error('Failed to load host rules:', e);
    }
  };

  const handleAdd = () => {
    setEditingRule(null);
    setFormHost('');
    setFormIgnorePaths('');
    setDialogOpen(true);
  };

  const handleEdit = (rule: HostRule) => {
    setEditingRule(rule);
    setFormHost(rule.host);
    setFormIgnorePaths(rule.ignore_paths.join('\n'));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const ignorePaths = formIgnorePaths
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);

    try {
      if (editingRule) {
        const updated: HostRule = {
          ...editingRule,
          host: formHost,
          ignore_paths: ignorePaths,
        };
        const data = await invoke<HostRule[]>('update_host_rule', { rule: updated });
        setRules(data);
      } else {
        const newRule: HostRule = {
          id: crypto.randomUUID(),
          host: formHost,
          enabled: true,
          ignore_paths: ignorePaths,
        };
        const data = await invoke<HostRule[]>('add_host_rule', { rule: newRule });
        setRules(data);
      }
      setDialogOpen(false);
    } catch (e) {
      console.error('Failed to save rule:', e);
    }
  };

  const handleToggle = async (rule: HostRule) => {
    try {
      const updated = { ...rule, enabled: !rule.enabled };
      const data = await invoke<HostRule[]>('update_host_rule', { rule: updated });
      setRules(data);
    } catch (e) {
      console.error('Failed to toggle rule:', e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const data = await invoke<HostRule[]>('delete_host_rule', { id });
      setRules(data);
    } catch (e) {
      console.error('Failed to delete rule:', e);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant='h5'>Host Rules</Typography>
        <Button variant='contained' startIcon={<AddIcon />} onClick={handleAdd}>
          Add Rule
        </Button>
      </Box>

      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Define which hosts to track through the proxy. Use wildcards like{' '}
        <code>*.example.com</code> to match subdomains.
      </Typography>

      <Card>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <Table size='small'>
            <TableHead>
              <TableRow>
                <TableCell>Enabled</TableCell>
                <TableCell>Host Pattern</TableCell>
                <TableCell>Ignore Paths</TableCell>
                <TableCell align='right'>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align='center' sx={{ py: 4 }}>
                    <Typography variant='body2' color='text.secondary'>
                      No host rules configured. Add one to start tracking traffic.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Switch checked={rule.enabled} onChange={() => handleToggle(rule)} size='small' />
                  </TableCell>
                  <TableCell>
                    <code>{rule.host}</code>
                  </TableCell>
                  <TableCell>
                    {rule.ignore_paths.map((p) => (
                      <Chip key={p} label={p} size='small' sx={{ mr: 0.5, mb: 0.5 }} />
                    ))}
                  </TableCell>
                  <TableCell align='right'>
                    <IconButton size='small' onClick={() => handleEdit(rule)}>
                      <EditIcon fontSize='small' />
                    </IconButton>
                    <IconButton size='small' onClick={() => handleDelete(rule.id)}>
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
        <DialogTitle>{editingRule ? 'Edit Host Rule' : 'Add Host Rule'}</DialogTitle>
        <DialogContent>
          <TextField
            label='Host Pattern'
            placeholder='api.example.com or *.example.com'
            value={formHost}
            onChange={(e) => setFormHost(e.target.value)}
            fullWidth
            margin='normal'
            size='small'
          />
          <TextField
            label='Ignore Paths (one per line)'
            placeholder={'/health\n/metrics'}
            value={formIgnorePaths}
            onChange={(e) => setFormIgnorePaths(e.target.value)}
            fullWidth
            multiline
            rows={4}
            margin='normal'
            size='small'
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant='contained' onClick={handleSave} disabled={!formHost.trim()}>
            {editingRule ? 'Update' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
