import type { ProviderAdapter } from './adapter.js';
import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionWithMeta,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
  ResponseMeta,
  Tool,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { fetchWithTimeout, getFlexTimeout } from '../utils/fetch-with-timeout.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
type PromptCacheStrategy = 'openai' | 'xai' | 'none';

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty',
  'seed', 'stop', 'stream', 'logprobs', 'top_logprobs', 'response_format',
  'tools', 'tool_choice', 'user', 'logit_bias', 'service_tier', 'cache',
]);

export function createOpenAIAdapter(
  apiKey: string,
  baseURL?: string,
  options: { cacheStrategy?: PromptCacheStrategy } = {},
): ProviderAdapter {
  const base = baseURL || OPENAI_API_BASE;
  const cacheStrategy = options.cacheStrategy ?? 'openai';

  async function makeRequest(
    path: string,
    body?: unknown,
    method = 'POST',
    timeoutMs?: number,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const res = await fetchWithTimeout(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);

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

  const RATE_LIMIT_HEADERS = [
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'retry-after',
  ];

  function extractResponseMeta(res: Response): ResponseMeta {
    const headers: Record<string, string> = {};
    for (const key of RATE_LIMIT_HEADERS) {
      const val = res.headers.get(key);
      if (val) headers[key] = val;
    }
    return { headers };
  }

  // Models that use max_completion_tokens instead of max_tokens
  function usesMaxCompletionTokens(model: string): boolean {
    return /^(o[1-9]|gpt-5|gpt-4o)/.test(model);
  }

  function hasWebSearchTool(tools: Tool[] | undefined): boolean {
    return Array.isArray(tools) && tools.some(tool => tool?.type === 'web_search');
  }

  function responsesInput(request: ChatCompletionRequest): Array<{ role: string; content: unknown }> {
    return request.messages.map(message => ({
      role: message.role,
      content: message.content,
    }));
  }

  function textFromResponses(response: any): string {
    if (typeof response?.output_text === 'string') return response.output_text;
    const chunks: string[] = [];
    for (const item of response?.output ?? []) {
      if (item?.type !== 'message' || !Array.isArray(item?.content)) continue;
      for (const part of item.content) {
        const text = part?.text ?? part?.content;
        if (typeof text === 'string') chunks.push(text);
      }
    }
    return chunks.join('\n').trim();
  }

  function usageFromResponses(response: any): ChatCompletion['usage'] {
    const usage = response?.usage ?? {};
    const prompt = Number(usage.input_tokens ?? 0);
    const completion = Number(usage.output_tokens ?? 0);
    return {
      prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
      completion_tokens: Number.isFinite(completion) ? completion : 0,
      total_tokens: Number(usage.total_tokens ?? prompt + completion) || 0,
    };
  }

  function buildRequestBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };

    // Copy over optional params
    if (request.max_tokens !== undefined) {
      if (usesMaxCompletionTokens(request.model)) {
        body.max_completion_tokens = request.max_tokens;
      } else {
        body.max_tokens = request.max_tokens;
      }
    }
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
    if (request.service_tier !== undefined) body.service_tier = request.service_tier;
    if (cacheStrategy === 'openai' && request.cache?.key !== undefined) body.prompt_cache_key = request.cache.key;
    if (cacheStrategy === 'openai' && request.cache?.ttl !== undefined) {
      body.prompt_cache_retention = request.cache.ttl === '24h' ? '24h' : 'in_memory';
    }

    return body;
  }

  function buildResponsesBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: responsesInput(request),
      tools: request.tools,
      tool_choice: request.tool_choice ?? 'required',
      include: ['web_search_call.action.sources'],
    };
    if (request.max_tokens !== undefined) body.max_output_tokens = request.max_tokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.user !== undefined) body.user = request.user;
    if (request.service_tier !== undefined) body.service_tier = request.service_tier;
    if (cacheStrategy === 'openai' && request.cache?.key !== undefined) body.prompt_cache_key = request.cache.key;
    if (cacheStrategy === 'openai' && request.cache?.ttl !== undefined) {
      body.prompt_cache_retention = request.cache.ttl === '24h' ? '24h' : 'in_memory';
    }
    if (request.response_format?.type === 'json_object') body.text = { format: { type: 'json_object' } };
    return body;
  }

  function buildRequestHeaders(request: ChatCompletionRequest): Record<string, string> {
    if (cacheStrategy === 'xai' && request.cache?.key) {
      return { 'x-grok-conv-id': request.cache.key };
    }
    return {};
  }

  const adapter: ProviderAdapter = {
    name: 'openai',

    translateRequest(request: ChatCompletionRequest): unknown {
      return hasWebSearchTool(request.tools) ? buildResponsesBody(request) : buildRequestBody(request);
    },

    translateResponse(response: unknown): ChatCompletion {
      const r = response as any;
      if (Array.isArray(r?.output)) {
        const result: ChatCompletion = {
          id: rePrefixId(r.id),
          object: 'chat.completion',
          created: r.created_at ?? Math.floor(Date.now() / 1000),
          model: `openai/${r.model}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: textFromResponses(r),
              },
              finish_reason: 'stop',
            },
          ],
          usage: usageFromResponses(r),
        };
        if (r.output) (result as any).output = r.output;
        if (r.usage) (result as any).raw_usage = r.usage;
        if (r.usage?.server_side_tool_usage_details) {
          (result as any).server_side_tool_usage_details = r.usage.server_side_tool_usage_details;
        }
        if (r.citations) (result as any).citations = r.citations;
        return result;
      }
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
        .filter((m: any) => {
          const id = m.id as string;
          // Exclude non-chat models
          if (id.includes('embedding')) return false;
          if (id.includes('whisper')) return false;
          if (id.includes('tts')) return false;
          if (id.includes('dall-e')) return false;
          if (id.includes('davinci')) return false;
          if (id.includes('babbage')) return false;
          if (id.includes('moderation')) return false;
          if (id.includes('realtime')) return false;
          if (id.startsWith('ft:')) return false;
          // Include known chat model prefixes
          return id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('o5') || id.startsWith('chatgpt-');
        })
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

    supportsBatch(): boolean {
      return true;
    },

    async sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion> {
      const body = hasWebSearchTool(request.tools) ? buildResponsesBody(request) : buildRequestBody(request);
      const headers = buildRequestHeaders(request);
      const timeout = request.service_tier === 'flex' ? getFlexTimeout() : undefined;
      const res = await makeRequest(hasWebSearchTool(request.tools) ? '/responses' : '/chat/completions', body, 'POST', timeout, headers);
      const json = await res.json();
      return adapter.translateResponse(json);
    },

    async sendRequestWithMeta(request: ChatCompletionRequest): Promise<ChatCompletionWithMeta> {
      const body = hasWebSearchTool(request.tools) ? buildResponsesBody(request) : buildRequestBody(request);
      const headers = buildRequestHeaders(request);
      const timeout = request.service_tier === 'flex' ? getFlexTimeout() : undefined;
      const res = await makeRequest(hasWebSearchTool(request.tools) ? '/responses' : '/chat/completions', body, 'POST', timeout, headers);
      const meta = extractResponseMeta(res);
      const json = await res.json();
      return { completion: adapter.translateResponse(json), meta };
    },

    async sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      const body = buildRequestBody({ ...request, stream: true });
      const headers = buildRequestHeaders(request);
      const timeout = request.service_tier === 'flex' ? getFlexTimeout() : undefined;
      const res = await makeRequest('/chat/completions', body, 'POST', timeout, headers);
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
