import { describe, it, expect } from 'vitest';
import { CODEGEN, CODEGEN_LANGS, generateBundle, type CodegenConn } from './codegen';

function conn(overrides: Partial<CodegenConn> = {}): CodegenConn {
  return {
    method: 'GET',
    url: 'https://api.example.com/v1/users',
    request_headers: [
      ['Accept', 'application/json'],
      ['Authorization', 'Bearer redacted'],
    ],
    request_body: null,
    ...overrides,
  };
}

describe('codegen registry', () => {
  it('exposes the documented languages in CODEGEN_LANGS', () => {
    // The page renders dropdown items from CODEGEN_LANGS — pin the order
    // so a future re-ordering doesn't quietly shuffle the menu.
    expect(CODEGEN_LANGS).toEqual(['curl', 'python', 'node']);
    for (const lang of CODEGEN_LANGS) {
      expect(CODEGEN[lang]).toBeDefined();
      expect(typeof CODEGEN[lang].generate).toBe('function');
      expect(CODEGEN[lang].label.length).toBeGreaterThan(0);
      expect(CODEGEN[lang].ext.length).toBeGreaterThan(0);
    }
  });

  it('curl generator emits a properly-quoted multi-line invocation', () => {
    const out = CODEGEN.curl.generate(conn());
    expect(out).toContain('curl -X GET');
    expect(out).toContain("'https://api.example.com/v1/users'");
    expect(out).toContain('Accept: application/json');
    expect(out).toContain('Authorization: Bearer redacted');
    expect(out).toContain(' \\\n');
  });

  it("curl single-quotes embedded single quotes", () => {
    const out = CODEGEN.curl.generate(
      conn({ url: "https://example.com/o'reilly" }),
    );
    // POSIX-shell escape for a literal apostrophe: '\''
    expect(out).toContain("'\\''");
  });

  it('python generator imports requests and uses requests.request', () => {
    const out = CODEGEN.python.generate(
      conn({ method: 'POST', request_body: '{"x":1}' }),
    );
    expect(out).toContain('import requests');
    expect(out).toContain('requests.request("POST"');
    expect(out).toContain('data = "{\\"x\\":1}"');
  });

  it('node generator emits a fetch() call with method + headers', () => {
    const out = CODEGEN.node.generate(conn({ method: 'PUT', request_body: 'hi' }));
    expect(out).toContain('await fetch(');
    expect(out).toContain('method: "PUT"');
    expect(out).toContain('body: "hi"');
  });

  it('omits request body for GET/HEAD even when request_body is set', () => {
    const out = CODEGEN.curl.generate(conn({ method: 'GET', request_body: 'leaked' }));
    expect(out).not.toContain('--data-raw');
  });

  it('placeholders out binary (data:) bodies in every language', () => {
    const c = conn({ method: 'POST', request_body: 'data:image/png;base64,iVBOR...' });
    for (const lang of CODEGEN_LANGS) {
      const out = CODEGEN[lang].generate(c);
      expect(out).toContain('<binary body');
      expect(out).not.toContain('iVBOR');
    }
  });

  it('generateBundle joins per-connection snippets with a separator', () => {
    const conns = [conn({ url: 'https://a.example.com/' }), conn({ url: 'https://b.example.com/' })];
    const out = generateBundle('curl', conns);
    expect(out).toContain('https://a.example.com/');
    expect(out).toContain('https://b.example.com/');
    expect(out).toContain('# ---');
  });

  it('generateBundle returns empty string for unknown languages', () => {
    // Defensive: callers should validate against CODEGEN_LANGS, but the
    // exporter must never throw on a stale key.
    expect(generateBundle('java', [conn()])).toBe('');
  });
});
