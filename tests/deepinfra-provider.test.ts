import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeepInfraAdapter } from '../src/providers/deepinfra.js';
import { createDeepInfraBatchAdapter } from '../src/providers/deepinfra-batch.js';
import { AnyModelError } from '../src/types.js';
import type { BatchRequestItem, ChatCompletionRequest } from '../src/types.js';

const API_BASE = 'https://api.deepinfra.com/v1/openai';

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    messages: [{ role: 'user', content: 'Summarize Texas LLC filing fees.' }],
    ...overrides,
  };
}

/** A `/models` entry in the shape DeepInfra returns, metadata and all. */
function model(id: string, tags: string[], meta: Record<string, unknown> = {}) {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'deepinfra',
    root: id,
    parent: null,
    metadata: { description: '', pricing: {}, tags, ...meta },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Stub global fetch and record every call made against it. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepInfra adapter', () => {
  const adapter = createDeepInfraAdapter('test-key');

  it('builds an OpenAI-shaped chat body and keeps the namespaced model id intact', () => {
    const body = adapter.translateRequest(request({ temperature: 0.2, max_tokens: 512 })) as any;

    expect(body.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarize Texas LLC filing fees.' }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('sends only the cache partition key — DeepInfra has no retention controls', () => {
    const body = adapter.translateRequest(request({
      cache: { key: 'texas-llc', mode: 'explicit', ttl: '24h' },
    })) as any;

    expect(body.prompt_cache_key).toBe('texas-llc');
    expect(body.prompt_cache_options).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it('strips cacheBreakpoint from messages', () => {
    const body = adapter.translateRequest(request({
      messages: [{ role: 'user', content: 'hello', cacheBreakpoint: true }],
    })) as any;

    expect(body.messages[0].cacheBreakpoint).toBeUndefined();
    expect(body.messages[0].content).toBe('hello');
  });

  it('prefixes the model and normalizes the generation id', () => {
    const completion = adapter.translateResponse({
      id: 'chatcmpl-abc123',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      created: 1711471533,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });

    expect(completion.id).toBe('gen-abc123');
    expect(completion.model).toBe('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(completion.usage.total_tokens).toBe(12);
  });

  it('passes cached-token usage details through untouched', () => {
    const completion = adapter.translateResponse({
      id: 'chatcmpl-1',
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      choices: [],
      usage: { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010, prompt_tokens_details: { cached_tokens: 4800 } },
    }) as any;

    expect(completion.usage.prompt_tokens_details.cached_tokens).toBe(4800);
  });

  it('reports batch support', () => {
    expect(adapter.supportsBatch()).toBe(true);
  });

  it('keeps only models tagged for the chat surface', async () => {
    stubFetch(() => jsonResponse({
      data: [
        model('meta-llama/Llama-3.3-70B-Instruct-Turbo', ['chat'], { context_length: 131072 }),
        // Nothing in these ids marks them as non-chat — only the tag does.
        model('BAAI/bge-large-en-v1.5', ['embed']),
        model('hexgrad/Kokoro-82M', ['tts']),
        model('google/nano-banana-pro', ['image-gen']),
        model('openai/whisper-large-v3', ['stt']),
        model('google/veo-3.1-fast', ['video-gen']),
      ],
    }));

    const models = await adapter.listModels();

    expect(models.map(m => m.id)).toEqual(['deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo']);
    expect(models[0]!.context_length).toBe(131072);
  });

  it('includes a model with no metadata rather than silently dropping it', async () => {
    stubFetch(() => jsonResponse({ data: [{ id: 'some/new-model', created: 0 }] }));

    const models = await adapter.listModels();

    expect(models.map(m => m.id)).toEqual(['deepinfra/some/new-model']);
    expect(models[0]!.context_length).toBe(128000);
  });

  it('converts per-million pricing to the per-token figures ModelInfo carries', async () => {
    stubFetch(() => jsonResponse({
      data: [model('deepseek-ai/DeepSeek-V4-Pro', ['chat', 'prompt_cache'], {
        context_length: 1048576,
        max_tokens: 1048576,
        pricing: { input_tokens: 1.3, output_tokens: 2.6, cache_read_tokens: 0.1 },
      })],
    }));

    const [info] = await adapter.listModels();

    expect(info!.pricing).toEqual({ prompt: '0.0000013', completion: '0.0000026' });
    expect(info!.top_provider.max_completion_tokens).toBe(1048576);
  });

  it('advertises cache and reasoning only for the models tagged with them', async () => {
    stubFetch(() => jsonResponse({
      data: [
        model('a/plain', ['chat']),
        model('b/cached', ['chat', 'prompt_cache']),
        model('c/thinker', ['chat', 'reasoning']),
      ],
    }));

    const [plain, cached, thinker] = await adapter.listModels();

    expect(plain!.supported_parameters).not.toContain('cache');
    expect(plain!.supported_parameters).not.toContain('reasoning');
    expect(cached!.supported_parameters).toContain('cache');
    expect(thinker!.supported_parameters).toContain('reasoning');
    // The adapter itself still accepts both, whatever a given model advertises.
    expect(adapter.supportsParameter('cache')).toBe(true);
    expect(adapter.supportsParameter('reasoning')).toBe(true);
  });

  it('marks vision-tagged models as multimodal', async () => {
    stubFetch(() => jsonResponse({
      data: [model('a/seer', ['chat', 'vlm', 'vision']), model('b/plain', ['chat'])],
    }));

    const [seer, plain] = await adapter.listModels();

    expect(seer!.architecture.input_modalities).toEqual(['text', 'image']);
    expect(plain!.architecture.input_modalities).toEqual(['text']);
  });

  it('forwards the reasoning object DeepInfra accepts on chat completions', () => {
    const body = adapter.translateRequest(request({ reasoning: { effort: 'high' } })) as any;
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('translates a streamed response and re-prefixes each chunk', async () => {
    const chunks: string[] = [];
    const stream = sseStream([
      'data: {"id":"chatcmpl-1","model":"meta-llama/Llama-3.3-70B-Instruct-Turbo","choices":[{"index":0,"delta":{"content":"He"}}]}\n',
      'data: {"id":"chatcmpl-1","model":"meta-llama/Llama-3.3-70B-Instruct-Turbo","choices":[{"index":0,"delta":{"content":"llo"}}]}\n',
      'data: [DONE]\n',
      'data: {"id":"chatcmpl-1","model":"ignored"}\n',
    ]);

    for await (const chunk of adapter.translateStream(stream)) {
      chunks.push(JSON.stringify(chunk));
    }

    expect(chunks).toHaveLength(2);
    const first = JSON.parse(chunks[0]!);
    expect(first.id).toBe('gen-1');
    expect(first.model).toBe('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo');
  });

  it('maps DeepInfra HTTP failures onto anymodel error codes', async () => {
    stubFetch(() => jsonResponse({ detail: 'rate limited' }, 429));

    await expect(adapter.sendRequest(request())).rejects.toMatchObject({
      code: 429,
      message: 'rate limited',
      metadata: { provider_name: 'deepinfra' },
    });
  });

  it('normalizes 403 to 401 and 5xx to 502', async () => {
    const { code: forbidden } = adapter.translateError(new AnyModelError(403, 'nope', { provider_name: 'deepinfra' }));
    expect(forbidden).toBe(403);
    stubFetch(() => jsonResponse({ detail: 'boom' }, 503));
    await expect(adapter.sendRequest(request())).rejects.toMatchObject({ code: 502 });
  });

  it('posts chat completions to the OpenAI-compatible path', async () => {
    const calls = stubFetch(() => jsonResponse({
      id: 'chatcmpl-9',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    await adapter.sendRequest(request());

    expect(calls[0]!.url).toBe(`${API_BASE}/chat/completions`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });
});

describe('DeepInfra batch adapter', () => {
  const batchAdapter = createDeepInfraBatchAdapter('test-key');

  const requests: BatchRequestItem[] = [
    { custom_id: 'req-1', messages: [{ role: 'user', content: 'one' }], max_tokens: 64 },
    { custom_id: 'req-2', messages: [{ role: 'user', content: 'two' }], temperature: 0.5 },
  ];

  it('uploads JSONL and creates a 24h batch against the chat completions endpoint', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/files')) return jsonResponse({ id: 'file_abc123' });
      return jsonResponse({ id: 'batch_abc123', status: 'validating' });
    });

    const result = await batchAdapter.createBatch('meta-llama/Llama-3.3-70B-Instruct-Turbo', requests, {
      metadata: { description: 'nightly eval run' },
    });

    expect(result.providerBatchId).toBe('batch_abc123');
    expect(result.metadata).toEqual({ input_file_id: 'file_abc123', deepinfra_status: 'validating' });

    expect(calls[0]!.url).toBe(`${API_BASE}/files`);
    const uploaded = calls[0]!.init.body as FormData;
    expect(uploaded.get('purpose')).toBe('batch');

    const lines = (await (uploaded.get('file') as Blob).text()).split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].custom_id).toBe('req-1');
    expect(lines[0].url).toBe('/v1/chat/completions');
    expect(lines[0].body.max_tokens).toBe(64);
    // Unspecified max_tokens is resolved rather than left off.
    expect(lines[1].body.max_tokens).toBeGreaterThan(0);
    expect(lines[1].body.temperature).toBe(0.5);

    expect(calls[1]!.url).toBe(`${API_BASE}/batches`);
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({
      input_file_id: 'file_abc123',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { description: 'nightly eval run' },
    });
  });

  it('maps in-flight DeepInfra statuses onto processing', async () => {
    stubFetch(() => jsonResponse({ status: 'in_progress', request_counts: { total: 10, completed: 4, failed: 1 } }));

    await expect(batchAdapter.pollBatch('batch_abc123')).resolves.toEqual({
      status: 'processing',
      total: 10,
      completed: 4,
      failed: 1,
    });
  });

  it('treats an expired batch as failed so partial results are still collected', async () => {
    stubFetch(() => jsonResponse({ status: 'expired', request_counts: { total: 10, completed: 7, failed: 0 } }));

    const status = await batchAdapter.pollBatch('batch_abc123');
    expect(status.status).toBe('failed');
    expect(status.completed).toBe(7);
  });

  it('reads both the output and error files, without duplicating a custom_id', async () => {
    stubFetch((url) => {
      if (url.endsWith('/batches/batch_abc123')) {
        return jsonResponse({ output_file_id: 'file_out', error_file_id: 'file_err' });
      }
      if (url.includes('file_out')) {
        return textResponse([
          JSON.stringify({
            custom_id: 'req-1',
            response: {
              status_code: 200,
              body: {
                id: 'chatcmpl-1',
                model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
                created: 1711471533,
                choices: [{ index: 0, message: { role: 'assistant', content: 'one' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
              },
            },
          }),
          JSON.stringify({ custom_id: 'req-2', response: { status_code: 400, body: { error: { message: 'bad input' } } } }),
        ].join('\n'));
      }
      return textResponse(JSON.stringify({ custom_id: 'req-2', error: { message: 'duplicate line' } }));
    });

    const results = await batchAdapter.getBatchResults('batch_abc123');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ custom_id: 'req-1', status: 'success' });
    expect(results[0]!.response!.id).toBe('gen-1');
    expect(results[0]!.response!.model).toBe('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(results[1]).toMatchObject({
      custom_id: 'req-2',
      status: 'error',
      error: { code: 400, message: 'bad input' },
    });
  });

  it('cancels via the OpenAI-compatible cancel path', async () => {
    const calls = stubFetch(() => jsonResponse({ id: 'batch_abc123', status: 'cancelling' }));

    await batchAdapter.cancelBatch('batch_abc123');

    expect(calls[0]!.url).toBe(`${API_BASE}/batches/batch_abc123/cancel`);
    expect(calls[0]!.init.method).toBe('POST');
  });
});
