import { describe, it, expect } from 'vitest';
import { connectionsToHar, type HarConn } from './har';

function conn(overrides: Partial<HarConn> = {}): HarConn {
  return {
    method: 'GET',
    url: 'https://api.example.com/v1/users?page=2',
    status: 200,
    duration_ms: 42,
    request_size: 0,
    response_size: 11,
    timestamp: '2026-05-18T10:00:00Z',
    request_headers: [['Accept', 'application/json']],
    response_headers: [['Content-Type', 'application/json']],
    request_body: null,
    response_body: '{"ok":true}',
    content_type: 'application/json',
    ...overrides,
  };
}

describe('connectionsToHar — HAR 1.2 shape', () => {
  it('produces the canonical root structure', () => {
    const har = connectionsToHar([], '1.2.3');
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Proxie');
    expect(har.log.creator.version).toBe('1.2.3');
    expect(Array.isArray(har.log.entries)).toBe(true);
    expect(har.log.entries).toHaveLength(0);
  });

  it('serializes a text body in entry.response.content.text', () => {
    const har = connectionsToHar([conn()]);
    const e = har.log.entries[0];
    expect(e.time).toBe(42);
    expect(e.request.method).toBe('GET');
    expect(e.request.url).toBe('https://api.example.com/v1/users?page=2');
    expect(e.request.queryString).toEqual([{ name: 'page', value: '2' }]);
    expect(e.response.status).toBe(200);
    expect(e.response.content.mimeType).toBe('application/json');
    expect(e.response.content.text).toBe('{"ok":true}');
    expect(e.response.content.encoding).toBeUndefined();
  });

  it('marks binary (data:) bodies as base64-encoded and strips the prefix', () => {
    const c = conn({
      response_body: 'data:image/png;base64,iVBORw0KGgo=',
      content_type: 'image/png',
      response_size: 8,
    });
    const har = connectionsToHar([c]);
    const content = har.log.entries[0].response.content;
    expect(content.encoding).toBe('base64');
    expect(content.text).toBe('iVBORw0KGgo=');
    expect(content.mimeType).toBe('image/png');
  });

  it('emits a postData block for non-empty request bodies', () => {
    const har = connectionsToHar([
      conn({ method: 'POST', request_body: '{"q":1}', content_type: 'application/json' }),
    ]);
    const req = har.log.entries[0].request;
    expect(req.postData).toEqual({ mimeType: 'application/json', text: '{"q":1}' });
  });

  it('omits postData when there is no request body', () => {
    const har = connectionsToHar([conn()]);
    expect(har.log.entries[0].request.postData).toBeUndefined();
  });

  it('round-trips through JSON.stringify cleanly', () => {
    // Ensure no functions / undefineds leak — HAR consumers parse JSON.
    const har = connectionsToHar([conn()]);
    const json = JSON.stringify(har);
    const back = JSON.parse(json);
    expect(back.log.version).toBe('1.2');
    expect(back.log.entries[0].response.status).toBe(200);
  });
});
