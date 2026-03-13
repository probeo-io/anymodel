import type { ProviderAdapter } from './adapter.js';
import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty',
  'seed', 'stop', 'stream', 'logprobs', 'top_logprobs', 'response_format',
  'tools', 'tool_choice', 'user', 'logit_bias',
]);

export function createOpenAIAdapter(apiKey: string, baseURL?: string): ProviderAdapter {
  const base = baseURL || OPENAI_API_BASE;

  async function makeRequest(path: string, body?: unknown, method = 'POST'): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(mapErrorCode(res.status), msg, {
        provider_name: 'openai',
        raw: errorBody,
      });
    }

    return res;
  }

  function mapErrorCode(status: number): number {
    if (status === 401 || status === 403) return 401;
    if (status === 429) return 429;
    if (status === 400 || status === 422) return 400;
    if (status >= 500) return 502;
    return status;
  }

  function rePrefixId(id: string): string {
    if (id && id.startsWith('chatcmpl-')) {
      return `gen-${id.substring(9)}`;
    }
    return id.startsWith('gen-') ? id : `gen-${id}`;
  }

  function buildRequestBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };

    // Copy over optional params
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

    return body;
  }

  const adapter: ProviderAdapter = {
    name: 'openai',

    translateRequest(request: ChatCompletionRequest): unknown {
      return buildRequestBody(request);
    },

    translateResponse(response: unknown): ChatCompletion {
      const r = response as any;
      return {
        id: rePrefixId(r.id),
        object: 'chat.completion',
        created: r.created,
        model: `openai/${r.model}`,
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
              json.model = `openai/${json.model}`;
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
        message: err?.message || 'Unknown OpenAI error',
        metadata: { provider_name: 'openai', raw: error },
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await makeRequest('/models', undefined, 'GET');
      const data = await res.json() as any;
      return (data.data || [])
        .filter((m: any) => m.id.startsWith('gpt-') || m.id.startsWith('o') || m.id.startsWith('chatgpt-'))
        .map((m: any) => ({
          id: `openai/${m.id}`,
          name: m.id,
          created: m.created,
          description: '',
          context_length: 128000,
          pricing: { prompt: '0', completion: '0' },
          architecture: {
            modality: 'text+image->text',
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            tokenizer: 'o200k_base',
          },
          top_provider: {
            context_length: 128000,
            max_completion_tokens: 16384,
            is_moderated: true,
          },
          supported_parameters: Array.from(SUPPORTED_PARAMS),
        }));
    },

    supportsParameter(param: string): boolean {
      return SUPPORTED_PARAMS.has(param);
    },

    async sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion> {
      const body = buildRequestBody(request);
      const res = await makeRequest('/chat/completions', body);
      const json = await res.json();
      return adapter.translateResponse(json);
    },

    async sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      const body = buildRequestBody({ ...request, stream: true });
      const res = await makeRequest('/chat/completions', body);
      if (!res.body) {
        throw new AnyModelError(502, 'No response body for streaming request', {
          provider_name: 'openai',
        });
      }
      return adapter.translateStream(res.body);
    },
  };

  return adapter;
}
