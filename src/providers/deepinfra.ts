import type { ProviderAdapter } from './adapter.js';
import type {
  AnyModelErrorMetadata,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionWithMeta,
  ModelArchitecture,
  ModelInfo,
  ResponseMeta,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const DEEPINFRA_API_BASE = 'https://api.deepinfra.com/v1/openai';

const SUPPORTED_PARAMS = new Set([
  'temperature',
  'max_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'stream',
  'logprobs',
  'top_logprobs',
  'response_format',
  'tools',
  'tool_choice',
  'user',
  'cache',
  'reasoning',
]);

/**
 * `/models` returns every surface DeepInfra serves — chat alongside embed,
 * image-gen, video-gen, tts, and stt. Each entry carries its surface as a tag,
 * so filter on that rather than guessing from the model name: an embedding
 * model like `BAAI/bge-large-en-v1.5` has nothing in its id to key off.
 */
function isChatModel(model: any): boolean {
  const tags = model?.metadata?.tags;
  if (!Array.isArray(tags)) return true;
  return tags.includes('chat');
}

/** DeepInfra quotes pricing in USD per 1M tokens; ModelInfo carries per-token. */
function perToken(perMillion: unknown): string {
  const value = Number(perMillion);
  return Number.isFinite(value) ? String(value / 1_000_000) : '0';
}

function architectureFor(tags: string[]): ModelArchitecture {
  const vision = tags.includes('vision') || tags.includes('vlm');
  return {
    modality: vision ? 'text+image->text' : 'text->text',
    input_modalities: vision ? ['text', 'image'] : ['text'],
    output_modalities: ['text'],
    tokenizer: 'unknown',
  };
}

/**
 * Caching and reasoning are per-model on DeepInfra, so advertise those two only
 * for the models actually tagged with them. The adapter itself still accepts
 * both for every model — only the published capability list narrows.
 */
function supportedParamsFor(tags: string[]): string[] {
  const reasoning = tags.includes('reasoning') || tags.includes('reasoning_effort');
  return Array.from(SUPPORTED_PARAMS).filter(param => {
    if (param === 'cache') return tags.includes('prompt_cache');
    if (param === 'reasoning') return reasoning;
    return true;
  });
}

function mapErrorCode(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  if (status === 400 || status === 422) return 400;
  if (status >= 500) return 502;
  return status;
}

function rePrefixId(id: string | undefined): string {
  const value = id || `deepinfra-${Date.now()}`;
  if (value.startsWith('chatcmpl-')) return `gen-${value.substring(9)}`;
  return value.startsWith('gen-') ? value : `gen-${value}`;
}

export function createDeepInfraAdapter(apiKey: string, baseURL = DEEPINFRA_API_BASE): ProviderAdapter {
  async function makeRequest(path: string, body?: unknown, method = 'POST'): Promise<Response> {
    const res = await fetchWithTimeout(`${baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errorBody: any;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = { message: res.statusText };
      }
      const msg = errorBody?.error?.message || errorBody?.detail || errorBody?.message || res.statusText;
      throw new AnyModelError(mapErrorCode(res.status), msg, {
        provider_name: 'deepinfra',
        raw: errorBody,
      });
    }

    return res;
  }

  function chatContent(message: ChatCompletionRequest['messages'][number]): unknown {
    if (typeof message.content === 'string') return message.content;
    return message.content.map(part => (part.type === 'input_text' ? { ...part, type: 'text' } : part));
  }

  function buildRequestBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(message => {
        const { cacheBreakpoint: _, ...base } = message;
        return { ...base, content: chatContent(message) };
      }),
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.stream !== undefined) body.stream = request.stream;
    if (request.logprobs !== undefined) body.logprobs = request.logprobs;
    if (request.top_logprobs !== undefined) body.top_logprobs = request.top_logprobs;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.user !== undefined) body.user = request.user;
    if (request.reasoning !== undefined) body.reasoning = request.reasoning;
    // DeepInfra caches automatically; prompt_cache_key only partitions the cache.
    // It has no retention/mode controls, so the rest of `cache` is intentionally dropped.
    if (request.cache?.key !== undefined) body.prompt_cache_key = request.cache.key;

    return body;
  }

  const adapter: ProviderAdapter = {
    name: 'deepinfra',

    translateRequest(request: ChatCompletionRequest): unknown {
      return buildRequestBody(request);
    },

    translateResponse(response: unknown): ChatCompletion {
      const r = response as any;
      return {
        id: rePrefixId(r.id),
        object: 'chat.completion',
        created: r.created ?? Math.floor(Date.now() / 1000),
        model: `deepinfra/${r.model}`,
        choices: r.choices,
        usage: r.usage,
      };
    },

    async *translateStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') return;
            if (trimmed.startsWith('data: ')) {
              const json = JSON.parse(trimmed.substring(6));
              json.id = rePrefixId(json.id);
              json.model = `deepinfra/${json.model}`;
              yield json as ChatCompletionChunk;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    translateError(error: unknown): { code: number; message: string; metadata: AnyModelErrorMetadata } {
      if (error instanceof AnyModelError) {
        return { code: error.code, message: error.message, metadata: error.metadata };
      }
      const err = error as any;
      const status = err?.status || err?.code || 500;
      return {
        code: mapErrorCode(status),
        message: err?.message || 'Unknown DeepInfra error',
        metadata: { provider_name: 'deepinfra', raw: error },
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await makeRequest('/models', undefined, 'GET');
      const data = await res.json() as any;
      return (data.data || [])
        .filter((m: any) => typeof m?.id === 'string' && isChatModel(m))
        .map((m: any) => {
          const meta = m.metadata ?? {};
          const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
          const contextLength = Number(meta.context_length) || 128000;
          return {
            id: `deepinfra/${m.id}`,
            name: m.id,
            created: m.created ?? 0,
            description: meta.description ?? '',
            context_length: contextLength,
            pricing: {
              prompt: perToken(meta.pricing?.input_tokens),
              completion: perToken(meta.pricing?.output_tokens),
            },
            architecture: architectureFor(tags),
            top_provider: {
              context_length: contextLength,
              max_completion_tokens: Number(meta.max_tokens) || contextLength,
              is_moderated: false,
            },
            supported_parameters: supportedParamsFor(tags),
          };
        });
    },

    supportsParameter(param: string): boolean {
      return SUPPORTED_PARAMS.has(param);
    },

    supportsBatch(): boolean {
      return true;
    },

    async sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion> {
      const res = await makeRequest('/chat/completions', buildRequestBody(request));
      const json = await res.json();
      return adapter.translateResponse(json);
    },

    async sendRequestWithMeta(request: ChatCompletionRequest): Promise<ChatCompletionWithMeta> {
      const res = await makeRequest('/chat/completions', buildRequestBody(request));
      const meta: ResponseMeta = { headers: {} };
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) meta.headers['retry-after'] = retryAfter;
      const json = await res.json();
      return { completion: adapter.translateResponse(json), meta };
    },

    async sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      const res = await makeRequest('/chat/completions', buildRequestBody({ ...request, stream: true }));
      if (!res.body) {
        throw new AnyModelError(502, 'No response body for streaming request', {
          provider_name: 'deepinfra',
        });
      }
      return adapter.translateStream(res.body);
    },
  };

  return adapter;
}
