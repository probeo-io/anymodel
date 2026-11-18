import type { ProviderAdapter } from './adapter.js';
import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionWithMeta,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
  Message,
  ResponseMeta,
  ToolCall,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { toAnthropicMessages } from './anthropic-messages.js';
import { generateId } from '../utils/id.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { anthropicCitations, anthropicTools } from '../utils/web-search.js';
import { withToolCost, webSearchCost } from '../pricing/tool-fees.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
// A web search turn can pause (stop_reason 'pause_turn'); it is resumed at most this many times.
const MAX_PAUSE_TURNS = 5;

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'top_k', 'stop', 'stream',
  'tools', 'tool_choice', 'response_format', 'cache',
]);

// Fallback if API listing fails — sourced from docs.anthropic.com/en/docs/about-claude/models/overview
const FALLBACK_MODELS: ModelInfo[] = [
  // From the Models API and the pricing page, 2026-10-07.
  { id: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', created: 0, description: 'Claude Haiku 5.5', context_length: 1000000, pricing: {prompt: '0.0000001', completion: '0.0000005'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', created: 0, description: 'Claude Sonnet 5.5', context_length: 1000000, pricing: {prompt: '0.000002', completion: '0.00001'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5', created: 0, description: 'Claude Opus 5.5', context_length: 1000000, pricing: {prompt: '0.000004', completion: '0.00002'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-fable-5-1', name: 'Claude Fable 5.1', created: 0, description: 'Claude Fable 5.1', context_length: 1000000, pricing: {prompt: '0.00001', completion: '0.00005'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', created: 0, description: 'Claude Opus 5', context_length: 1000000, pricing: {prompt: '0.000005', completion: '0.000025'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', created: 0, description: 'Claude Sonnet 5', context_length: 1000000, pricing: {prompt: '0.000002', completion: '0.00001'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', created: 0, description: 'Claude Fable 5', context_length: 1000000, pricing: {prompt: '0.00001', completion: '0.00005'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', created: 0, description: 'Claude Opus 4.8', context_length: 1000000, pricing: {prompt: '0.000005', completion: '0.000025'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-4-7', name: 'Claude Opus 4.7', created: 0, description: 'Claude Opus 4.7', context_length: 1000000, pricing: {prompt: '0.000005', completion: '0.000025'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', created: 0, description: 'Claude Sonnet 4.6', context_length: 1000000, pricing: {prompt: '0.000003', completion: '0.000015'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', created: 0, description: 'Claude Opus 4.6', context_length: 1000000, pricing: {prompt: '0.000005', completion: '0.000025'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-opus-4-5-20251101', name: 'Claude Opus 4.5', created: 0, description: 'Claude Opus 4.5', context_length: 200000, pricing: {prompt: '0.000005', completion: '0.000025'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', created: 0, description: 'Claude Haiku 4.5', context_length: 200000, pricing: {prompt: '0.000001', completion: '0.000005'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', created: 0, description: 'Claude Sonnet 4.5', context_length: 1000000, pricing: {prompt: '0.000003', completion: '0.000015'}, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 1000000, max_completion_tokens: 64000, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
];

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  // Anthropic uses its own header naming convention
  const RATE_LIMIT_HEADERS = [
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'retry-after',
  ];

  function extractResponseMeta(res: Response): ResponseMeta {
    const headers: Record<string, string> = {};
    for (const key of RATE_LIMIT_HEADERS) {
      const val = res.headers.get(key);
      if (val) headers[key] = val;
    }
    // Normalize to x-ratelimit-* so the controller can use a single key
    if (headers['anthropic-ratelimit-requests-remaining']) {
      headers['x-ratelimit-remaining-requests'] = headers['anthropic-ratelimit-requests-remaining'];
    }
    if (headers['anthropic-ratelimit-tokens-remaining']) {
      headers['x-ratelimit-remaining-tokens'] = headers['anthropic-ratelimit-tokens-remaining'];
    }
    return { headers };
  }

  async function makeRequest(path: string, body: unknown, stream = false): Promise<Response> {
    const res = await fetchWithTimeout(`${ANTHROPIC_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
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
        provider_name: 'anthropic',
        raw: errorBody,
      });
    }

    return res;
  }

  function mapErrorCode(status: number): number {
    if (status === 401 || status === 403) return 401;
    if (status === 429) return 429;
    if (status === 400 || status === 422) return 400;
    if (status === 529) return 502;
    if (status >= 500) return 502;
    return status;
  }

  function translateRequest(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    };

    // Extract system messages
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const nonSystemMessages = request.messages.filter(m => m.role !== 'system');

    if (systemMessages.length > 0) {
      body.system = systemMessages
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join('\n');
    }

    // Map messages
    body.messages = toAnthropicMessages(nonSystemMessages);

    // Map optional params
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.top_k !== undefined) body.top_k = request.top_k;
    if (request.stop !== undefined) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    if (request.stream) body.stream = true;
    if (request.cache) {
      body.cache_control = {
        type: 'ephemeral',
        ...(request.cache.ttl === '1h' || request.cache.ttl === '24h' ? { ttl: '1h' } : {}),
      };
    }

    // Map tools
    if (request.tools && request.tools.length > 0) {
      const tools = anthropicTools(request.model, request.tools);
      body.tools = tools;
      if (tools.length === 0) delete body.tools;

      if (request.tool_choice) {
        if (request.tool_choice === 'auto') {
          body.tool_choice = { type: 'auto' };
        } else if (request.tool_choice === 'required') {
          body.tool_choice = { type: 'any' };
        } else if (request.tool_choice === 'none') {
          // Omit tool_choice, don't send tools
          delete body.tools;
        } else if (typeof request.tool_choice === 'object') {
          body.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
        }
      }
    }

    // Handle response_format
    if (request.response_format) {
      if (request.response_format.type === 'json_object' || request.response_format.type === 'json_schema') {
        // Prepend JSON instruction to system
        const jsonInstruction = 'Respond with valid JSON only. Do not include any text outside the JSON object.';
        body.system = body.system ? `${jsonInstruction}\n\n${body.system}` : jsonInstruction;
      }
    }

    return body;
  }

  function mapStopReason(reason: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'max_tokens': return 'length';
      case 'tool_use': return 'tool_calls';
      case 'stop_sequence': return 'stop';
      default: return 'stop';
    }
  }

  function translateResponse(response: unknown): ChatCompletion {
    const r = response as any;

    // Extract text content
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of r.content || []) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const message: Message = {
      role: 'assistant',
      content,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const result: ChatCompletion = {
      id: generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `anthropic/${r.model}`,
      choices: [{
        index: 0,
        message,
        finish_reason: mapStopReason(r.stop_reason),
      }],
      usage: {
        prompt_tokens: r.usage?.input_tokens || 0,
        completion_tokens: r.usage?.output_tokens || 0,
        total_tokens: (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0),
      },
    };
    // The pages a web search answer cited, as xAI and Perplexity already return them.
    const citations = anthropicCitations(r.content || []);
    if (citations.length > 0) (result as any).citations = citations;
    if (r.usage?.server_tool_use) (result as any).server_tool_use = r.usage.server_tool_use;
    withToolCost(result.usage, webSearchCost('anthropic', Number(r.usage?.server_tool_use?.web_search_requests ?? 0)));
    return result;
  }

  /* A server-side web search can stop with 'pause_turn'. Sending the paused
     content back as the assistant turn lets Claude carry on; the pieces are
     joined so the caller gets one finished answer. */
  async function postMessages(body: Record<string, unknown>): Promise<{ res: Response; json: any }> {
    let res = await makeRequest('/messages', body);
    let json: any = await res.json();
    for (let i = 0; json?.stop_reason === 'pause_turn' && i < MAX_PAUSE_TURNS; i++) {
      const resumed = { ...body, messages: [...(body.messages as unknown[]), { role: 'assistant', content: json.content }] };
      res = await makeRequest('/messages', resumed);
      json = joinPausedTurn(json, await res.json());
    }
    return { res, json };
  }

  function joinPausedTurn(paused: any, next: any): any {
    const add = (k: string) => (paused.usage?.[k] || 0) + (next.usage?.[k] || 0);
    const searches = (paused.usage?.server_tool_use?.web_search_requests || 0) + (next.usage?.server_tool_use?.web_search_requests || 0);
    return {
      ...next,
      content: [...(paused.content || []), ...(next.content || [])],
      usage: { ...next.usage, input_tokens: add('input_tokens'), output_tokens: add('output_tokens'),
        ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}) },
    };
  }

  const adapter: ProviderAdapter = {
    name: 'anthropic',

    translateRequest,
    translateResponse,

    async *translateStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const id = generateId();
      const created = Math.floor(Date.now() / 1000);
      let model = '';
      let usage: any = null;
      // Block types by index: only the caller's own tool_use blocks stream out as
      // tool calls, not a web search's server_tool_use input.
      const blockTypes = new Map<number, string>();

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

            if (trimmed.startsWith('data: ')) {
              const data = JSON.parse(trimmed.substring(6));

              if (data.type === 'message_start') {
                model = `anthropic/${data.message.model}`;
                usage = data.message.usage;
                // Emit initial chunk with role
                yield {
                  id, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                };
              } else if (data.type === 'content_block_delta') {
                if (data.delta?.type === 'text_delta') {
                  yield {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
                  };
                } else if (data.delta?.type === 'input_json_delta' && blockTypes.get(data.index) === 'tool_use') {
                  // Tool use streaming — emit as tool_calls delta
                  yield {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          id: data.content_block?.id || '',
                          type: 'function',
                          function: { name: '', arguments: data.delta.partial_json },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                }
              } else if (data.type === 'content_block_start') {
                blockTypes.set(data.index, data.content_block?.type);
                if (data.content_block?.type === 'tool_use') {
                  yield {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          id: data.content_block.id,
                          type: 'function',
                          function: { name: data.content_block.name, arguments: '' },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                }
              } else if (data.type === 'message_delta') {
                const finalUsage = usage ? {
                  prompt_tokens: usage.input_tokens || 0,
                  completion_tokens: data.usage?.output_tokens || 0,
                  total_tokens: (usage.input_tokens || 0) + (data.usage?.output_tokens || 0),
                } : undefined;

                yield {
                  id, object: 'chat.completion.chunk', created, model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: mapStopReason(data.delta?.stop_reason || 'end_turn'),
                  }],
                  usage: finalUsage,
                };
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    translateError(error: unknown) {
      if (error instanceof AnyModelError) {
        return { code: error.code, message: error.message, metadata: error.metadata };
      }
      const err = error as any;
      const status = err?.status || err?.code || 500;
      return {
        code: mapErrorCode(status),
        message: err?.message || 'Unknown Anthropic error',
        metadata: { provider_name: 'anthropic', raw: error } as AnyModelErrorMetadata,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const res = await fetchWithTimeout(`${ANTHROPIC_API_BASE}/models`, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
        });

        if (!res.ok) return FALLBACK_MODELS;

        const data = await res.json() as any;
        const models = (data.data || []) as any[];

        return models
          .filter((m: any) => m.type === 'model')
          .map((m: any) => ({
            id: `anthropic/${m.id}`,
            name: m.display_name || m.id,
            created: m.created_at ? new Date(m.created_at).getTime() / 1000 : 0,
            description: m.display_name || '',
            // The Models API reports each model's limits; the old fixed 200000/16384 predates that.
            context_length: m.max_input_tokens ?? 200000,
            pricing: { prompt: '0', completion: '0' },
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
              tokenizer: 'claude',
            },
            top_provider: {
              context_length: m.max_input_tokens ?? 200000,
              max_completion_tokens: m.max_tokens ?? 16384,
              is_moderated: false,
            },
            supported_parameters: Array.from(SUPPORTED_PARAMS),
          }));
      } catch {
        return FALLBACK_MODELS;
      }
    },

    supportsParameter(param: string): boolean {
      return SUPPORTED_PARAMS.has(param);
    },

    supportsBatch(): boolean {
      return true;
    },

    async sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion> {
      const { json } = await postMessages(translateRequest(request));
      return translateResponse(json);
    },

    async sendRequestWithMeta(request: ChatCompletionRequest): Promise<ChatCompletionWithMeta> {
      const { res, json } = await postMessages(translateRequest(request));
      return { completion: translateResponse(json), meta: extractResponseMeta(res) };
    },

    async sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      const body = translateRequest({ ...request, stream: true });
      const res = await makeRequest('/messages', body, true);
      if (!res.body) {
        throw new AnyModelError(502, 'No response body for streaming request', {
          provider_name: 'anthropic',
        });
      }
      return adapter.translateStream(res.body);
    },
  };

  return adapter;
}
