import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AnyModel } from './client.js';
import type { AnyModelConfig, ChatCompletionRequest, ChatCompletionChunk } from './types.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  config?: AnyModelConfig;
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: { code: status, message, metadata: {} } });
}

async function sendSSE(res: ServerResponse, stream: AsyncIterable<ChatCompletionChunk>): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  for await (const chunk of stream) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

export function createAnyModelServer(options: ServerOptions = {}): ReturnType<typeof createServer> {
  const client = new AnyModel(options.config);
  const basePath = '/api/v1';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health check
      if (path === '/health' && req.method === 'GET') {
        sendJSON(res, 200, { status: 'ok' });
        return;
      }

      // Chat completions
      if (path === `${basePath}/chat/completions` && req.method === 'POST') {
        const body = JSON.parse(await parseBody(req)) as ChatCompletionRequest;

        if (body.stream) {
          const stream = await client.chat.completions.create(body) as AsyncIterable<ChatCompletionChunk>;
          await sendSSE(res, stream);
        } else {
          const response = await client.chat.completions.create(body);
          sendJSON(res, 200, response);
        }
        return;
      }

      // Models list
      if (path === `${basePath}/models` && req.method === 'GET') {
        const provider = url.searchParams.get('provider') || undefined;
        const models = await client.models.list({ provider });
        sendJSON(res, 200, { object: 'list', data: models });
        return;
      }

      // Generation stats
      if (path.startsWith(`${basePath}/generation/`) && req.method === 'GET') {
        const id = path.substring(`${basePath}/generation/`.length);
        const stats = client.generation.get(id);
        if (!stats) {
          sendError(res, 404, `Generation ${id} not found`);
          return;
        }
        sendJSON(res, 200, stats);
        return;
      }

      // Batch endpoints
      if (path === `${basePath}/batches` && req.method === 'POST') {
        const body = JSON.parse(await parseBody(req));
        const batch = await client.batches.create(body);
        sendJSON(res, 201, batch);
        return;
      }

      if (path === `${basePath}/batches` && req.method === 'GET') {
        const batches = client.batches.list();
        sendJSON(res, 200, { object: 'list', data: batches });
        return;
      }

      if (path.startsWith(`${basePath}/batches/`) && req.method === 'GET') {
        const parts = path.substring(`${basePath}/batches/`.length).split('/');
        const id = parts[0];

        if (parts[1] === 'results') {
          const results = client.batches.results(id);
          sendJSON(res, 200, results);
          return;
        }

        const batch = client.batches.get(id);
        if (!batch) {
          sendError(res, 404, `Batch ${id} not found`);
          return;
        }
        sendJSON(res, 200, batch);
        return;
      }

      if (path.startsWith(`${basePath}/batches/`) && req.method === 'POST') {
        const parts = path.substring(`${basePath}/batches/`.length).split('/');
        const id = parts[0];

        if (parts[1] === 'cancel') {
          const batch = client.batches.cancel(id);
          sendJSON(res, 200, batch);
          return;
        }
      }

      sendError(res, 404, `Not found: ${path}`);
    } catch (err: any) {
      const code = err?.code || 500;
      const message = err?.message || 'Internal server error';
      sendError(res, code, message);
    }
  });

  return server;
}

export function startServer(options: ServerOptions = {}): void {
  const port = options.port ?? 4141;
  const host = options.host ?? '0.0.0.0';

  const server = createAnyModelServer(options);

  server.listen(port, host, () => {
    console.log(`@probeo/anymodel server running at http://${host}:${port}`);
    console.log(`API base: http://${host}:${port}/api/v1`);
    console.log('');
    console.log('Endpoints:');
    console.log('  POST /api/v1/chat/completions');
    console.log('  GET  /api/v1/models');
    console.log('  GET  /api/v1/generation/:id');
    console.log('  POST /api/v1/batches');
    console.log('  GET  /api/v1/batches');
    console.log('  GET  /api/v1/batches/:id');
    console.log('  GET  /api/v1/batches/:id/results');
    console.log('  POST /api/v1/batches/:id/cancel');
    console.log('  GET  /health');
  });
}
