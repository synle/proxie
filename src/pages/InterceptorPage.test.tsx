import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import InterceptorPage from './InterceptorPage';

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

type InterceptAction =
  | { type: 'mock'; response: HarResponse }
  | { type: 'reroute'; target_url: string };

interface InterceptRule {
  id: string;
  name: string;
  enabled: boolean;
  match_host: string;
  match_path: string;
  match_method: string | null;
  action: InterceptAction;
}

/**
 * Build a minimal mock-action intercept rule.
 *
 * @param overrides - Field overrides for the synthesized rule.
 * @returns A complete `InterceptRule` with a `mock` action.
 */
function makeMockRule(overrides: Partial<InterceptRule> = {}): InterceptRule {
  return {
    id: 'rule-mock',
    name: 'Mock /api/users',
    enabled: true,
    match_host: 'api.example.com',
    match_path: '/api/users',
    match_method: 'GET',
    action: {
      type: 'mock',
      response: {
        status: 200,
        status_text: 'OK',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        content: { size: 11, mime_type: 'application/json', text: '{"ok":true}' },
      },
    },
    ...overrides,
  };
}

/**
 * Build a minimal reroute intercept rule.
 *
 * @param overrides - Field overrides for the synthesized rule.
 * @returns A complete `InterceptRule` with a `reroute` action.
 */
function makeRerouteRule(overrides: Partial<InterceptRule> = {}): InterceptRule {
  return {
    id: 'rule-reroute',
    name: 'Reroute to staging',
    enabled: true,
    match_host: 'api.example.com',
    match_path: '/api/*',
    match_method: null,
    action: { type: 'reroute', target_url: 'https://staging.example.com/api' },
    ...overrides,
  };
}

describe('InterceptorPage', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
  });

  it('renders the empty state when no rules are configured', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);

    await waitFor(() => {
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument();
    });
  });

  it('renders a mock rule with status chip and a reroute rule with warning chip', async () => {
    const rules = [
      makeMockRule({ id: 'r-mock', name: 'Mock OK' }),
      makeRerouteRule({ id: 'r-reroute', name: 'Send to staging' }),
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return rules;
      return undefined;
    });

    render(<InterceptorPage />);

    await waitFor(() => {
      expect(screen.getByText('Mock OK')).toBeInTheDocument();
      expect(screen.getByText('Send to staging')).toBeInTheDocument();
    });
    // The mock action chip surfaces the status code.
    expect(screen.getByText('Mock 200')).toBeInTheDocument();
    // The reroute action chip renders with a warning palette.
    expect(screen.getByText('Reroute')).toBeInTheDocument();
    // The host / path / method chips show in the Match column.
    expect(screen.getByText('GET')).toBeInTheDocument();
    expect(screen.getAllByText('api.example.com').length).toBeGreaterThan(0);
  });

  it('logs an error when get_intercept_rules rejects but still renders the empty table', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') throw new Error('boom');
      return undefined;
    });

    render(<InterceptorPage />);

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('opens the Add dialog and disables Save until required fields are filled', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument());

    // Header "Add Rule" button (first button in the header) opens the dialog.
    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    expect(screen.getByText('Add Intercept Rule')).toBeInTheDocument();

    // The dialog primary "Add" button starts disabled because name/host/path are empty.
    const dialog = screen.getByRole('dialog');
    const addBtn = within(dialog).getByRole('button', { name: 'Add' });
    expect(addBtn).toBeDisabled();

    // Fill the three required fields. After that Save should be enabled.
    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'My Rule');
    await user.type(within(dialog).getByLabelText(/Host/i), 'api.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/i), '/x');

    await waitFor(() => expect(addBtn).not.toBeDisabled());
  });

  it('adds a new mock rule via the dialog with correct request payload', async () => {
    const user = userEvent.setup();
    let added: InterceptRule | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') {
        added = args?.rule as InterceptRule;
        return [added];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'New Mock');
    await user.type(within(dialog).getByLabelText(/Host/i), 'api.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/i), '/api/x');

    // Default formActionType is 'mock' and defaults yield status=200, content=application/json,
    // body='{}'. Hit Save.
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            id: '00000000-0000-0000-0000-000000000001',
            name: 'New Mock',
            enabled: true,
            match_host: 'api.example.com',
            match_path: '/api/x',
            action: expect.objectContaining({
              type: 'mock',
              response: expect.objectContaining({
                status: 200,
                status_text: 'OK',
                headers: expect.arrayContaining([
                  expect.objectContaining({ name: 'Content-Type', value: 'application/json' }),
                ]),
                content: expect.objectContaining({
                  mime_type: 'application/json',
                  text: '{}',
                }),
              }),
            }),
          }),
        }),
      );
    });
    expect(added).not.toBeNull();
  });

  it('switches the action to reroute and posts a reroute payload on save', async () => {
    const user = userEvent.setup();
    let added: InterceptRule | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') {
        added = args?.rule as InterceptRule;
        return [added];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'Reroute Rule');
    await user.type(within(dialog).getByLabelText(/Host/i), 'api.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/i), '/api/x');

    // Flip the action toggle button group to Reroute.
    await user.click(within(dialog).getByRole('button', { name: /Reroute/i }));
    // Target URL field is only visible in reroute mode.
    await user.type(
      within(dialog).getByLabelText(/Target URL/i),
      'https://staging.example.com/api/x',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            action: expect.objectContaining({
              type: 'reroute',
              target_url: 'https://staging.example.com/api/x',
            }),
          }),
        }),
      );
    });
    expect(added).not.toBeNull();
  });

  it('opens edit dialog pre-filled and calls update_intercept_rule', async () => {
    const user = userEvent.setup();
    const rule = makeMockRule({ id: 'r-edit', name: 'Original' });
    let updated: InterceptRule | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [rule];
      if (cmd === 'update_intercept_rule') {
        updated = args?.rule as InterceptRule;
        return [updated];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument());

    // First edit icon button — there's one per row.
    const editButtons = screen.getAllByTestId('EditIcon');
    await user.click(editButtons[0].closest('button')!);

    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('Edit Intercept Rule')).toBeInTheDocument();
    // Name field is pre-filled with the rule's name.
    const nameField = within(dialog).getByLabelText(/Rule Name/i) as HTMLInputElement;
    expect(nameField.value).toBe('Original');

    // Change the name and save.
    await user.clear(nameField);
    await user.type(nameField, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'r-edit', name: 'Renamed' }),
        }),
      );
    });
    expect(updated?.name).toBe('Renamed');
  });

  it('pre-fills edit dialog with reroute fields for a reroute rule', async () => {
    const user = userEvent.setup();
    const rule = makeRerouteRule({ id: 'r-edit-rr' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [rule];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText('Reroute to staging')).toBeInTheDocument(),
    );

    await user.click(screen.getAllByTestId('EditIcon')[0].closest('button')!);
    const dialog = screen.getByRole('dialog');
    // The Target URL textfield should be visible with the stored URL.
    const tgt = within(dialog).getByLabelText(/Target URL/i) as HTMLInputElement;
    expect(tgt.value).toBe('https://staging.example.com/api');
  });

  it('toggles a rule via update_intercept_rule', async () => {
    const user = userEvent.setup();
    const rule = makeMockRule({ id: 'r-toggle', enabled: true });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [rule];
      if (cmd === 'update_intercept_rule') return [args?.rule];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText('Mock /api/users')).toBeInTheDocument());

    await user.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'update_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'r-toggle', enabled: false }),
        }),
      );
    });
  });

  it('deletes a rule via delete_intercept_rule', async () => {
    const user = userEvent.setup();
    const rule = makeMockRule({ id: 'r-del' });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [rule];
      if (cmd === 'delete_intercept_rule') {
        expect(args).toEqual({ id: 'r-del' });
        return [];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText('Mock /api/users')).toBeInTheDocument());

    await user.click(screen.getAllByTestId('DeleteIcon')[0].closest('button')!);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_intercept_rule', { id: 'r-del' });
    });
  });

  it('duplicates a rule with " (copy)" suffix and a fresh id', async () => {
    const user = userEvent.setup();
    const rule = makeMockRule({ id: 'r-dup', name: 'Original' });
    let added: InterceptRule | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [rule];
      if (cmd === 'add_intercept_rule') {
        added = args?.rule as InterceptRule;
        return [rule, added];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument());

    await user.click(screen.getAllByTestId('ContentCopyIcon')[0].closest('button')!);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Original (copy)',
          }),
        }),
      );
    });
    expect(added?.id).not.toBe('r-dup');
  });

  it('handles save / toggle / delete / duplicate failures without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const rule = makeMockRule({ id: 'r-err' });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [rule];
      // Every mutating call rejects.
      throw new Error(`fail-${cmd}`);
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText('Mock /api/users')).toBeInTheDocument());

    // Toggle (update fails).
    await user.click(screen.getByRole('switch'));
    // Duplicate (add fails).
    await user.click(screen.getAllByTestId('ContentCopyIcon')[0].closest('button')!);
    // Delete (delete fails).
    await user.click(screen.getAllByTestId('DeleteIcon')[0].closest('button')!);

    await waitFor(() => {
      // At least three errors logged — one per failing mutation.
      expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    errSpy.mockRestore();
  });

  it('imports a HAR response object via the Import button', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() => expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');

    // Replace the response body with a valid HAR fragment, then click Import.
    const bodyField = within(dialog).getByLabelText(/Response Body/i) as HTMLTextAreaElement;
    await user.clear(bodyField);
    const harResponse = {
      status: 404,
      statusText: 'Not Found',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      content: { text: 'missing', mimeType: 'text/plain' },
    };
    // userEvent.type is slow for long strings — use the more direct paste.
    await user.click(bodyField);
    await user.paste(JSON.stringify(harResponse));

    await user.click(within(dialog).getByRole('button', { name: /Import from HAR Response/i }));

    // After import: status text + body + content-type updated.
    await waitFor(() => {
      expect((bodyField as HTMLTextAreaElement).value).toBe('missing');
    });
    const ct = within(dialog).getByLabelText(/Content-Type/i) as HTMLInputElement;
    expect(ct.value).toBe('text/plain');
  });

  it('shows an alert on invalid HAR JSON', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');

    const bodyField = within(dialog).getByLabelText(/Response Body/i) as HTMLTextAreaElement;
    await user.clear(bodyField);
    await user.click(bodyField);
    await user.paste('not-json');

    await user.click(within(dialog).getByRole('button', { name: /Import from HAR Response/i }));

    await waitFor(() => {
      expect(screen.getByText(/Invalid JSON/i)).toBeInTheDocument();
    });
  });

  it('shows an alert when HAR JSON is valid but missing required fields', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');

    const bodyField = within(dialog).getByLabelText(/Response Body/i) as HTMLTextAreaElement;
    await user.clear(bodyField);
    await user.click(bodyField);
    await user.paste('{"foo":"bar"}');

    await user.click(within(dialog).getByRole('button', { name: /Import from HAR Response/i }));

    await waitFor(() => {
      expect(screen.getByText(/Paste a HAR response object/i)).toBeInTheDocument();
    });
  });

  it('changing the status code dropdown updates the status text', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await user.click(screen.getByRole('button', { name: 'Add Rule' }));
    const dialog = screen.getByRole('dialog');

    // Fill required fields so we can later inspect the persisted body.
    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'Status Switch');
    await user.type(within(dialog).getByLabelText(/Host/i), 'api.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/i), '/api/x');

    // Open the Status Code MUI select. MUI Select renders as a button
    // whose accessible name is its current value text (e.g., "200 OK"),
    // so we locate it by that visible value.
    const comboboxes = within(dialog).getAllByRole('combobox');
    const statusSelect = comboboxes.find((el) => /200/.test(el.textContent ?? ''));
    if (!statusSelect) throw new Error('status-code combobox not found');
    await user.click(statusSelect);
    // Pick "404 Not Found".
    await user.click(await screen.findByRole('option', { name: /404 Not Found/i }));

    // Save and check the persisted payload reflects the new status / text.
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') return [args?.rule];
      return undefined;
    });

    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'add_intercept_rule',
        expect.objectContaining({
          rule: expect.objectContaining({
            action: expect.objectContaining({
              type: 'mock',
              response: expect.objectContaining({ status: 404, status_text: 'Not Found' }),
            }),
          }),
        }),
      );
    });
  });

  it('changing Content-Type in the mock action is reflected in the saved payload', async () => {
    const user = userEvent.setup();
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') {
        captured = args?.rule as Record<string, unknown>;
        return [captured];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'ct test');
    await user.type(within(dialog).getByLabelText(/^Host$/), 'api.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/), '/x');

    const ct = within(dialog).getByLabelText(/Content-Type/i);
    await user.clear(ct);
    await user.type(ct, 'text/plain');

    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    const action = (captured as { action: { response: { headers: { name: string; value: string }[] } } }).action;
    const ctHeader = action.response.headers.find((h) => h.name === 'Content-Type');
    expect(ctHeader?.value).toBe('text/plain');
  });

  it('Cancel button closes the dialog without invoking add/update', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Cancel/i }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invokeMock.mock.calls.some((c) => c[0] === 'add_intercept_rule')).toBe(false);
    expect(invokeMock.mock.calls.some((c) => c[0] === 'update_intercept_rule')).toBe(false);
  });

  it('HAR import error alert can be dismissed via its close button', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    const dialog = screen.getByRole('dialog');

    // Trigger an import error via clearly-invalid JSON.
    const body = within(dialog).getByLabelText(/Response Body/i);
    await user.type(body, 'not-json-at-all');
    await user.click(within(dialog).getByRole('button', { name: /Import from HAR Response/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toBeInTheDocument();

    // The Alert's close button has aria-label "Close".
    await user.click(within(alert).getByRole('button', { name: /^Close$/i }));

    await waitFor(() => {
      expect(within(dialog).queryByRole('alert')).toBeNull();
    });
  });

  it('logs an error when add_intercept_rule rejects (save error path)', async () => {
    const user = userEvent.setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') throw new Error('save boom');
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'fail-save');
    await user.type(within(dialog).getByLabelText(/^Host$/), 'fail.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/), '/x');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(err).toHaveBeenCalledWith('Failed to save rule:', expect.any(Error));
    });
    // Dialog stays open on failure.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    err.mockRestore();
  });

  it('Method "Any" submits match_method=null', async () => {
    const user = userEvent.setup();
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_intercept_rules') return [];
      if (cmd === 'add_intercept_rule') {
        captured = args?.rule as Record<string, unknown>;
        return [captured];
      }
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText(/Rule Name/i), 'any-method');
    await user.type(within(dialog).getByLabelText(/^Host$/), 'any.example.com');
    await user.type(within(dialog).getByLabelText(/^Path$/), '/any');
    // Default method is null/'Any' — saving without picking should produce null.

    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured).toMatchObject({ match_method: null });
  });

  it('pressing Escape closes the dialog (Dialog onClose path)', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_intercept_rules') return [];
      return undefined;
    });

    render(<InterceptorPage />);
    await waitFor(() =>
      expect(screen.getByText(/No intercept rules/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Add Rule/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

});
