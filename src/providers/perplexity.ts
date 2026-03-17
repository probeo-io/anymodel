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
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const PERPLEXITY_API_BASE = 'https://api.perplexity.ai';

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty',
  'stream', 'stop', 'response_format', 'tools', 'tool_choice',
]);

// Perplexity models — static list since there is no /models endpoint
const MODELS: Array<{
  id: string;
  name: string;
  context: number;
  maxOutput: number;
  modality: string;
  inputModalities: string[];
}> = [
  { id: 'sonar', name: 'Sonar', context: 128000, maxOutput: 4096, modality: 'text->text', inputModalities: ['text'] },
  { id: 'sonar-pro', name: 'Sonar Pro', context: 200000, maxOutput: 8192, modality: 'text->text', inputModalities: ['text'] },
  { id: 'sonar-reasoning', name: 'Sonar Reasoning', context: 128000, maxOutput: 8192, modality: 'text->text', inputModalities: ['text'] },
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', context: 128000, maxOutput: 16384, modality: 'text->text', inputModalities: ['text'] },
  { id: 'sonar-deep-research', name: 'Sonar Deep Research', context: 128000, maxOutput: 16384, modality: 'text->text', inputModalities: ['text'] },
  { id: 'r1-1776', name: 'R1 1776', context: 128000, maxOutput: 16384, modality: 'text->text', inputModalities: ['text'] },
];

export function createPerplexityAdapter(apiKey: string): ProviderAdapter {
  async function makeRequest(path: string, body?: unknown, method = 'POST'): Promise<Response> {
    const res = await fetchWithTimeout(`${PERPLEXITY_API_BASE}${path}`, {
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
        provider_name: 'perplexity',
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

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.stream !== undefined) body.stream = request.stream;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    return body;
  }

  const adapter: ProviderAdapter = {
    name: 'perplexity',

    translateRequest(request: ChatCompletionRequest): unknown {
      return buildRequestBody(request);
    },

    translateResponse(response: unknown): ChatCompletion {
      const r = response as any;
      const result: ChatCompletion = {
        id: rePrefixId(r.id),
        object: 'chat.completion',
        created: r.created,
        model: `perplexity/${r.model}`,
        choices: r.choices,
        usage: r.usage,
      };

      // Preserve citations in metadata if present
      if (r.citations && result.choices?.[0]?.message) {
        (result as any).citations = r.citations;
      }

      return result;
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
              json.model = `perplexity/${json.model}`;
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
        message: err?.message || 'Unknown Perplexity error',
        metadata: { provider_name: 'perplexity', raw: error },
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      return MODELS.map((m) => ({
        id: `perplexity/${m.id}`,
        name: m.name,
        created: 0,
        description: '',
        context_length: m.context,
        pricing: { prompt: '0', completion: '0' },
        architecture: {
          modality: m.modality,
          input_modalities: m.inputModalities,
          output_modalities: ['text'],
          tokenizer: 'unknown',
        },
        top_provider: {
          context_length: m.context,
          max_completion_tokens: m.maxOutput,
          is_moderated: false,
        },
        supported_parameters: Array.from(SUPPORTED_PARAMS),
      }));
    },

    supportsParameter(param: string): boolean {
      return SUPPORTED_PARAMS.has(param);
    },

    supportsBatch(): boolean {
      return false;
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
          provider_name: 'perplexity',
        });
      }
      return adapter.translateStream(res.body);
    },
  };

  return adapter;
}
