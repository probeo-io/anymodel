import type { ProviderAdapter } from './adapter.js';
import type {
  AnyModelErrorMetadata,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionWithMeta,
  ModelInfo,
  ResponseMeta,
  Tool,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const XAI_API_BASE = 'https://api.x.ai/v1';

const SUPPORTED_PARAMS = new Set([
  'temperature',
  'max_tokens',
  'top_p',
  'seed',
  'stop',
  'stream',
  'response_format',
  'tools',
  'tool_choice',
  'cache',
]);

const MODELS = [
  { id: 'grok-4.5', name: 'Grok 4.5', context: 256000, maxOutput: 128000 },
  { id: 'grok-4.3', name: 'Grok 4.3', context: 256000, maxOutput: 128000 },
  { id: 'grok-4.20', name: 'Grok 4.20', context: 256000, maxOutput: 128000 },
];

function hasWebSearchTool(tools: Tool[] | undefined): boolean {
  return Array.isArray(tools) && tools.some(tool => tool?.type === 'web_search');
}

function responseInput(request: ChatCompletionRequest): Array<{ role: string; content: unknown }> {
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

function mapErrorCode(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  if (status === 400 || status === 422) return 400;
  if (status >= 500) return 502;
  return status;
}

function rePrefixId(id: string | undefined): string {
  const value = id || `xai-${Date.now()}`;
  return value.startsWith('gen-') ? value : `gen-${value}`;
}

export function createXAIAdapter(apiKey: string, baseURL = XAI_API_BASE): ProviderAdapter {
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
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(mapErrorCode(res.status), msg, {
        provider_name: 'xai',
        raw: errorBody,
      });
    }

    return res;
  }

  function buildChatBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.stream !== undefined) body.stream = request.stream;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.cache?.key !== undefined) body.prompt_cache_key = request.cache.key;
    return body;
  }

  function buildResponsesBody(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: responseInput(request),
      tools: request.tools,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.cache?.key !== undefined) body.prompt_cache_key = request.cache.key;
    if (request.response_format?.type === 'json_object') body.text = { format: { type: 'json_object' } };
    return body;
  }

  function translateChatResponse(response: unknown): ChatCompletion {
    const r = response as any;
    const result: ChatCompletion = {
      id: rePrefixId(r.id),
      object: 'chat.completion',
      created: r.created ?? Math.floor(Date.now() / 1000),
      model: `xai/${r.model}`,
      choices: r.choices,
      usage: r.usage,
    };
    if (r.citations) (result as any).citations = r.citations;
    return result;
  }

  function translateResponsesResponse(response: unknown, model?: string): ChatCompletion {
    const r = response as any;
    const result: ChatCompletion = {
      id: rePrefixId(r.id),
      object: 'chat.completion',
      created: r.created_at ?? Math.floor(Date.now() / 1000),
      model: `xai/${r.model || model || 'unknown'}`,
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
    if (r.citations) (result as any).citations = r.citations;
    if (r.output) (result as any).output = r.output;
    if (r.server_side_tool_usage) (result as any).server_side_tool_usage = r.server_side_tool_usage;
    if (r.usage) (result as any).raw_usage = r.usage;
    if (r.usage?.server_side_tool_usage_details) {
      (result as any).server_side_tool_usage_details = r.usage.server_side_tool_usage_details;
    }
    return result;
  }

  const adapter: ProviderAdapter = {
    name: 'xai',

    translateRequest(request: ChatCompletionRequest): unknown {
      return hasWebSearchTool(request.tools) ? buildResponsesBody(request) : buildChatBody(request);
    },

    translateResponse(response: unknown): ChatCompletion {
      const r = response as any;
      return Array.isArray(r?.output) ? translateResponsesResponse(r) : translateChatResponse(r);
    },

    async *translateStream(_stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
      throw new AnyModelError(400, 'xAI streaming is not implemented in the native adapter yet', {
        provider_name: 'xai',
      });
    },

    translateError(error: unknown): { code: number; message: string; metadata: AnyModelErrorMetadata } {
      if (error instanceof AnyModelError) {
        return { code: error.code, message: error.message, metadata: error.metadata };
      }
      const err = error as any;
      const status = err?.status || err?.code || 500;
      return {
        code: mapErrorCode(status),
        message: err?.message || 'Unknown xAI error',
        metadata: { provider_name: 'xai', raw: error },
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      return MODELS.map(model => ({
        id: `xai/${model.id}`,
        name: model.name,
        created: 0,
        description: '',
        context_length: model.context,
        pricing: { prompt: '0', completion: '0' },
        architecture: {
          modality: 'text->text',
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'unknown',
        },
        top_provider: {
          context_length: model.context,
          max_completion_tokens: model.maxOutput,
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
      if (hasWebSearchTool(request.tools)) {
        const body = buildResponsesBody(request);
        const res = await makeRequest('/responses', body);
        const json = await res.json();
        return translateResponsesResponse(json, request.model);
      }
      const body = buildChatBody(request);
      const res = await makeRequest('/chat/completions', body);
      const json = await res.json();
      return translateChatResponse(json);
    },

    async sendRequestWithMeta(request: ChatCompletionRequest): Promise<ChatCompletionWithMeta> {
      const completion = await adapter.sendRequest(request);
      const meta: ResponseMeta = { headers: {} };
      return { completion, meta };
    },

    async sendStreamingRequest(_request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      throw new AnyModelError(400, 'xAI streaming is not implemented in the native adapter yet', {
        provider_name: 'xai',
      });
    },
  };

  return adapter;
}
