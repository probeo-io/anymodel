import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { createAnyModelServer, startServer } from '../src/server.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  servers.length = 0; vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function listen(apiKey?: string) {
  vi.stubEnv('ANYMODEL_SERVER_API_KEY', '');
  const server = createAnyModelServer({ apiKey, config: { openai: { apiKey: 'fixture-provider-key' } } });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
  return address.port;
}
function call(port: number, path: string, token?: string, method = 'GET', body?: string, origin?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(token ? { Authorization: token } : {}), ...(origin ? { Origin: origin } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
}
describe('optional HTTP server access boundary', () => {
  it('retains local-only access without a server key', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] })); vi.stubGlobal('fetch', fetcher);
    const res = await call(await listen(), '/api/v1/models?provider=openai');
    expect(res.status).toBe(200); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects missing/wrong/malformed auth before body parsing or provider calls', async () => {
    const fetcher = vi.fn(() => { throw Error('Provider must not be called'); }); vi.stubGlobal('fetch', fetcher);
    const port = await listen('fixture-server-key');
    for (const token of [undefined, 'Bearer wrong', 'Basic fixture-server-key', 'Bearer fixture-provider-key']) {
      const res = await call(port, '/api/v1/chat/completions', token, 'POST', 'not json');
      expect(res.status).toBe(401); expect(res.body).not.toContain('fixture-server-key');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts the separate server key while provider requests retain their provider key', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] })); vi.stubGlobal('fetch', fetcher);
    const res = await call(await listen('fixture-server-key'), '/api/v1/models?provider=openai', 'Bearer fixture-server-key');
    expect(res.status).toBe(200); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fixture-provider-key' } });
  });
  it('rejects external browser origins in keyless local mode', async () => {
    const fetcher = vi.fn(() => { throw Error('Provider must not be called'); }); vi.stubGlobal('fetch', fetcher);
    const port = await listen();
    for (const origin of ['https://external.example', 'null', 'https://localhost.evil.test']) {
      expect((await call(port, '/api/v1/chat/completions', undefined, 'POST', 'not json', origin)).status).toBe(403);
    }
    expect((await call(port, '/missing', undefined, 'GET', undefined, 'http://localhost:4322')).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('supports environment-provided server credentials', async () => {
    vi.stubEnv('ANYMODEL_SERVER_API_KEY', 'fixture-env-key');
    const server = createAnyModelServer(); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
    expect((await call(address.port, '/missing')).status).toBe(401);
    expect((await call(address.port, '/missing', 'Bearer fixture-env-key')).status).toBe(404);
  });
  it('keeps nonspending health and preflight probes available', async () => {
    const port = await listen('fixture-server-key');
    expect((await call(port, '/health')).status).toBe(200);
    expect((await call(port, '/api/v1/chat/completions', undefined, 'OPTIONS')).status).toBe(204);
  });
  it('rejects unkeyed remote binding before opening a listener', () => {
    vi.stubEnv('ANYMODEL_SERVER_API_KEY', '');
    expect(() => startServer({ host: '0.0.0.0' })).toThrow('Non-loopback binding');
    expect(() => startServer({ host: '::' })).toThrow('Non-loopback binding');
  });
  it('embedded servers reject non-loopback peers regardless of a forged Host header', async () => {
    vi.stubEnv('ANYMODEL_SERVER_API_KEY', ''); const server = createAnyModelServer();
    const fetcher = vi.fn(() => { throw Error('Provider must not be called'); }); vi.stubGlobal('fetch', fetcher);
    const result = await new Promise<{ status: number; body: string }>(resolve => {
      let status = 0;
      server.emit('request', { method: 'POST', url: '/api/v1/chat/completions', headers: { host: 'localhost' }, socket: { remoteAddress: '198.51.100.1' } } as IncomingMessage,
        { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { resolve({ status, body }); } } as unknown as ServerResponse);
    });
    expect(result.status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });
});
