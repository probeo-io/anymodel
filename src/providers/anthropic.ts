import type { ProviderAdapter } from './adapter.js';
import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
  Message,
  ToolCall,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'top_k', 'stop', 'stream',
  'tools', 'tool_choice', 'response_format',
]);

// Fallback if API listing fails — kept current as of March 2026
const FALLBACK_MODELS: ModelInfo[] = [
  // Claude 4.6
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', created: 0, description: 'Most capable model', context_length: 200000, pricing: { prompt: '0.000015', completion: '0.000075' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 32768, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', created: 0, description: 'Best balance of speed and capability', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 16384, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  // Claude 4.5
  { id: 'anthropic/claude-sonnet-4-5-20251022', name: 'Claude Sonnet 4.5', created: 0, description: 'Previous generation balanced model', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 16384, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', created: 0, description: 'Fast and compact', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 8192, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  // Claude 3.5
  { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', created: 0, description: 'Legacy balanced model', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 8192, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', created: 0, description: 'Legacy fast model', context_length: 200000, pricing: { prompt: '0.0000008', completion: '0.000004' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'claude' }, top_provider: { context_length: 200000, max_completion_tokens: 8192, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
];

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  async function makeRequest(path: string, body: unknown, stream = false): Promise<Response> {
    const res = await fetch(`${ANTHROPIC_API_BASE}${path}`, {
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
    body.messages = nonSystemMessages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.tool_call_id
        ? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }]
        : m.content,
    }));

    // Map optional params
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.top_k !== undefined) body.top_k = request.top_k;
    if (request.stop !== undefined) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    if (request.stream) body.stream = true;

    // Map tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));

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

    return {
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
                } else if (data.delta?.type === 'input_json_delta') {
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
        const res = await fetch(`${ANTHROPIC_API_BASE}/models`, {
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
            context_length: 200000,
            pricing: { prompt: '0', completion: '0' },
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
              tokenizer: 'claude',
            },
            top_provider: {
              context_length: 200000,
              max_completion_tokens: 16384,
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
      const body = translateRequest(request);
      const res = await makeRequest('/messages', body);
      const json = await res.json();
      return translateResponse(json);
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
