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
  ToggleButton,
  ToggleButtonGroup,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { invoke } from '@tauri-apps/api/core';

interface HarHeader {
  name: string;
  value: string;
}

interface HarContent {
  size: number;
  mime_type: string;
  text: string | null;
}

interface HarResponse {
  status: number;
  status_text: string;
  headers: HarHeader[];
  content: HarContent;
}

interface MockAction {
  type: 'mock';
  response: HarResponse;
}

interface RerouteAction {
  type: 'reroute';
  target_url: string;
}

type InterceptAction = MockAction | RerouteAction;

interface InterceptRule {
  id: string;
  name: string;
  enabled: boolean;
  match_host: string;
  match_path: string;
  match_method: string | null;
  action: InterceptAction;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const STATUS_CODES = [
  { code: 200, text: 'OK' },
  { code: 201, text: 'Created' },
  { code: 204, text: 'No Content' },
  { code: 301, text: 'Moved Permanently' },
  { code: 302, text: 'Found' },
  { code: 304, text: 'Not Modified' },
  { code: 400, text: 'Bad Request' },
  { code: 401, text: 'Unauthorized' },
  { code: 403, text: 'Forbidden' },
  { code: 404, text: 'Not Found' },
  { code: 500, text: 'Internal Server Error' },
  { code: 502, text: 'Bad Gateway' },
  { code: 503, text: 'Service Unavailable' },
];

export default function InterceptorPage() {
  const [rules, setRules] = useState<InterceptRule[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<InterceptRule | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formMethod, setFormMethod] = useState<string | null>(null);
  const [formActionType, setFormActionType] = useState<'mock' | 'reroute'>('mock');
  const [formStatus, setFormStatus] = useState(200);
  const [formStatusText, setFormStatusText] = useState('OK');
  const [formContentType, setFormContentType] = useState('application/json');
  const [formBody, setFormBody] = useState('{}');
  const [formTargetUrl, setFormTargetUrl] = useState('');

  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    try {
      const data = await invoke<InterceptRule[]>('get_intercept_rules');
      setRules(data ?? []);
    } catch (e) {
      console.error('Failed to load intercept rules:', e);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormHost('');
    setFormPath('');
    setFormMethod(null);
    setFormActionType('mock');
    setFormStatus(200);
    setFormStatusText('OK');
    setFormContentType('application/json');
    setFormBody('{}');
    setFormTargetUrl('');
    setImportError(null);
  };

  const handleAdd = () => {
    setEditingRule(null);
    resetForm();
    setDialogOpen(true);
  };

  const handleEdit = (rule: InterceptRule) => {
    setEditingRule(rule);
    setFormName(rule.name);
    setFormHost(rule.match_host);
    setFormPath(rule.match_path);
    setFormMethod(rule.match_method);
    if (rule.action.type === 'mock') {
      setFormActionType('mock');
      setFormStatus(rule.action.response.status);
      setFormStatusText(rule.action.response.status_text);
      const ct =
        rule.action.response.headers.find(
          (h) => h.name.toLowerCase() === 'content-type',
        )?.value ?? rule.action.response.content.mime_type;
      setFormContentType(ct);
      setFormBody(rule.action.response.content.text ?? '');
    } else {
      setFormActionType('reroute');
      setFormTargetUrl(rule.action.target_url);
    }
    setImportError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const action: InterceptAction =
      formActionType === 'mock'
        ? {
            type: 'mock',
            response: {
              status: formStatus,
              status_text: formStatusText,
              headers: [{ name: 'Content-Type', value: formContentType }],
              content: {
                size: formBody.length,
                mime_type: formContentType,
                text: formBody,
              },
            },
          }
        : {
            type: 'reroute',
            target_url: formTargetUrl,
          };

    try {
      if (editingRule) {
        const updated: InterceptRule = {
          ...editingRule,
          name: formName,
          match_host: formHost,
          match_path: formPath,
          match_method: formMethod,
          action,
        };
        const data = await invoke<InterceptRule[]>('update_intercept_rule', { rule: updated });
        setRules(data);
      } else {
        const newRule: InterceptRule = {
          id: crypto.randomUUID(),
          name: formName,
          enabled: true,
          match_host: formHost,
          match_path: formPath,
          match_method: formMethod,
          action,
        };
        const data = await invoke<InterceptRule[]>('add_intercept_rule', { rule: newRule });
        setRules(data);
      }
      setDialogOpen(false);
    } catch (e) {
      console.error('Failed to save rule:', e);
    }
  };

  const handleToggle = async (rule: InterceptRule) => {
    try {
      const updated = { ...rule, enabled: !rule.enabled };
      const data = await invoke<InterceptRule[]>('update_intercept_rule', { rule: updated });
      setRules(data);
    } catch (e) {
      console.error('Failed to toggle rule:', e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const data = await invoke<InterceptRule[]>('delete_intercept_rule', { id });
      setRules(data);
    } catch (e) {
      console.error('Failed to delete rule:', e);
    }
  };

  const handleDuplicate = async (rule: InterceptRule) => {
    const newRule: InterceptRule = {
      ...rule,
      id: crypto.randomUUID(),
      name: `${rule.name} (copy)`,
    };
    try {
      const data = await invoke<InterceptRule[]>('add_intercept_rule', { rule: newRule });
      setRules(data);
    } catch (e) {
      console.error('Failed to duplicate rule:', e);
    }
  };

  const handleImportHar = () => {
    try {
      const parsed = JSON.parse(formBody);
      // Check if it looks like a HAR response object
      if (parsed.status && parsed.content) {
        setFormStatus(parsed.status);
        setFormStatusText(parsed.statusText || STATUS_CODES.find((s) => s.code === parsed.status)?.text || 'OK');
        if (parsed.headers && Array.isArray(parsed.headers)) {
          const ct = parsed.headers.find(
            (h: HarHeader) => h.name.toLowerCase() === 'content-type',
          );
          if (ct) setFormContentType(ct.value);
        }
        if (parsed.content.text) {
          setFormBody(parsed.content.text);
        }
        if (parsed.content.mimeType) {
          setFormContentType(parsed.content.mimeType);
        }
        setImportError(null);
      } else {
        setImportError('Paste a HAR response object with "status" and "content" fields');
      }
    } catch {
      setImportError('Invalid JSON — paste a HAR response object');
    }
  };

  const handleStatusChange = (code: number) => {
    setFormStatus(code);
    const found = STATUS_CODES.find((s) => s.code === code);
    if (found) setFormStatusText(found.text);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant='h5'>Interceptor</Typography>
        <Button variant='contained' startIcon={<AddIcon />} onClick={handleAdd}>
          Add Rule
        </Button>
      </Box>

      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Define intercept rules to mock responses or reroute requests. Rules are matched in order —
        the first match wins. You can access the request body, headers, and method for dynamic
        behavior.
      </Typography>

      <Card>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <Table size='small'>
            <TableHead>
              <TableRow>
                <TableCell width={60}>On</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Match</TableCell>
                <TableCell>Action</TableCell>
                <TableCell align='right'>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align='center' sx={{ py: 4 }}>
                    <Typography variant='body2' color='text.secondary'>
                      No intercept rules. Add one to mock responses or reroute requests.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Switch
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                      size='small'
                    />
                  </TableCell>
                  <TableCell>{rule.name}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {rule.match_method && (
                        <Chip label={rule.match_method} size='small' color='primary' />
                      )}
                      <Chip label={rule.match_host} size='small' variant='outlined' />
                      <Chip label={rule.match_path} size='small' variant='outlined' />
                    </Box>
                  </TableCell>
                  <TableCell>
                    {rule.action.type === 'mock' ? (
                      <Chip
                        label={`Mock ${rule.action.response.status}`}
                        size='small'
                        color='secondary'
                      />
                    ) : (
                      <Chip label={`Reroute`} size='small' color='warning' />
                    )}
                  </TableCell>
                  <TableCell align='right'>
                    <IconButton size='small' onClick={() => handleDuplicate(rule)}>
                      <ContentCopyIcon fontSize='small' />
                    </IconButton>
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
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth='md'
        fullWidth>
        <DialogTitle>{editingRule ? 'Edit Intercept Rule' : 'Add Intercept Rule'}</DialogTitle>
        <DialogContent>
          <TextField
            label='Rule Name'
            placeholder='e.g., Mock /api/users response'
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            fullWidth
            margin='normal'
            size='small'
          />

          <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
            Match Criteria
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              label='Host'
              placeholder='api.example.com or *.example.com'
              value={formHost}
              onChange={(e) => setFormHost(e.target.value)}
              size='small'
              sx={{ flex: 1 }}
            />
            <TextField
              label='Path'
              placeholder='/api/users or /api/*'
              value={formPath}
              onChange={(e) => setFormPath(e.target.value)}
              size='small'
              sx={{ flex: 1 }}
            />
            <FormControl size='small' sx={{ minWidth: 120 }}>
              <InputLabel>Method</InputLabel>
              <Select
                value={formMethod ?? ''}
                onChange={(e) => setFormMethod(e.target.value || null)}
                label='Method'>
                <MenuItem value=''>Any</MenuItem>
                {HTTP_METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
            Action
          </Typography>
          <ToggleButtonGroup
            value={formActionType}
            exclusive
            onChange={(_, v) => v && setFormActionType(v)}
            size='small'
            sx={{ mb: 2 }}>
            <ToggleButton value='mock'>Mock Response</ToggleButton>
            <ToggleButton value='reroute'>Reroute</ToggleButton>
          </ToggleButtonGroup>

          {formActionType === 'mock' ? (
            <Box>
              <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                <FormControl size='small' sx={{ minWidth: 160 }}>
                  <InputLabel>Status Code</InputLabel>
                  <Select
                    value={formStatus}
                    onChange={(e) => handleStatusChange(Number(e.target.value))}
                    label='Status Code'>
                    {STATUS_CODES.map((s) => (
                      <MenuItem key={s.code} value={s.code}>
                        {s.code} {s.text}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  label='Content-Type'
                  value={formContentType}
                  onChange={(e) => setFormContentType(e.target.value)}
                  size='small'
                  sx={{ flex: 1 }}
                />
              </Box>
              <TextField
                label='Response Body'
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                fullWidth
                multiline
                rows={8}
                size='small'
                sx={{
                  '& .MuiInputBase-root': { fontFamily: 'monospace', fontSize: '0.85em' },
                }}
              />
              <Box sx={{ mt: 1, display: 'flex', gap: 1, alignItems: 'center' }}>
                <Button size='small' variant='outlined' onClick={handleImportHar}>
                  Import from HAR Response
                </Button>
                <Typography variant='caption' color='text.secondary'>
                  Paste a HAR response JSON in the body field, then click import
                </Typography>
              </Box>
              {importError && (
                <Alert severity='error' sx={{ mt: 1 }} onClose={() => setImportError(null)}>
                  {importError}
                </Alert>
              )}
            </Box>
          ) : (
            <TextField
              label='Target URL'
              placeholder='https://staging.example.com/api/users'
              value={formTargetUrl}
              onChange={(e) => setFormTargetUrl(e.target.value)}
              fullWidth
              margin='normal'
              size='small'
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant='contained'
            onClick={handleSave}
            disabled={!formName.trim() || !formHost.trim() || !formPath.trim()}>
            {editingRule ? 'Update' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
