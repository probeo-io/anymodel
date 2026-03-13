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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const SUPPORTED_PARAMS = new Set([
  'temperature', 'max_tokens', 'top_p', 'top_k', 'stop', 'stream',
  'tools', 'tool_choice', 'response_format',
]);

// Fallback if API listing fails — kept current as of March 2026
const FALLBACK_MODELS: ModelInfo[] = [
  // Gemini 2.5
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', created: 0, description: 'Most capable Gemini model', context_length: 1048576, pricing: { prompt: '0.00000125', completion: '0.000005' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', created: 0, description: 'Fast and efficient', context_length: 1048576, pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  // Gemini 2.0
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', created: 0, description: 'Fast multimodal model', context_length: 1048576, pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', created: 0, description: 'Lightweight and fast', context_length: 1048576, pricing: { prompt: '0.00000005', completion: '0.0000002' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  // Gemini 1.5
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro', created: 0, description: 'Previous generation pro model', context_length: 2097152, pricing: { prompt: '0.00000125', completion: '0.000005' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 2097152, max_completion_tokens: 8192, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
  { id: 'google/gemini-1.5-flash', name: 'Gemini 1.5 Flash', created: 0, description: 'Previous generation flash model', context_length: 1048576, pricing: { prompt: '0.000000075', completion: '0.0000003' }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'video', 'audio'], output_modalities: ['text'], tokenizer: 'gemini' }, top_provider: { context_length: 1048576, max_completion_tokens: 8192, is_moderated: false }, supported_parameters: Array.from(SUPPORTED_PARAMS) },
];

export function createGoogleAdapter(apiKey: string): ProviderAdapter {
  function getModelEndpoint(model: string, stream: boolean): string {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return `${GEMINI_API_BASE}/models/${model}:${action}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
  }

  function mapErrorCode(status: number): number {
    if (status === 401 || status === 403) return 401;
    if (status === 429) return 429;
    if (status === 400) return 400;
    if (status >= 500) return 502;
    return status;
  }

  function translateRequest(request: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    // Extract system instruction
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const nonSystemMessages = request.messages.filter(m => m.role !== 'system');

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map(m => typeof m.content === 'string' ? m.content : '').join('\n') }],
      };
    }

    // Map messages to contents
    body.contents = nonSystemMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string'
        ? [{ text: m.content }]
        : Array.isArray(m.content)
          ? m.content.map(p => p.type === 'text' ? { text: p.text } : { text: '' })
          : [{ text: '' }],
    }));

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.max_tokens !== undefined) generationConfig.maxOutputTokens = request.max_tokens;
    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    if (request.top_k !== undefined) generationConfig.topK = request.top_k;
    if (request.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }

    // Response format
    if (request.response_format) {
      if (request.response_format.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json';
      } else if (request.response_format.type === 'json_schema') {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = request.response_format.json_schema.schema;
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Map tools
    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map(t => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || {},
        })),
      }];

      if (request.tool_choice) {
        if (request.tool_choice === 'auto') {
          body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        } else if (request.tool_choice === 'required') {
          body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (request.tool_choice === 'none') {
          body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        } else if (typeof request.tool_choice === 'object') {
          body.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [request.tool_choice.function.name],
            },
          };
        }
      }
    }

    return body;
  }

  function mapFinishReason(reason: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'content_filter';
      case 'RECITATION': return 'content_filter';
      default: return 'stop';
    }
  }

  function translateResponse(response: unknown): ChatCompletion {
    const r = response as any;
    const candidate = r.candidates?.[0];

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const part of candidate?.content?.parts || []) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: generateId('call'),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    const message: Message = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const finishReason = toolCalls.length > 0
      ? 'tool_calls' as const
      : mapFinishReason(candidate?.finishReason || 'STOP');

    return {
      id: generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `google/${r.modelVersion || 'unknown'}`,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: r.usageMetadata?.promptTokenCount || 0,
        completion_tokens: r.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: r.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  const adapter: ProviderAdapter = {
    name: 'google',

    translateRequest,
    translateResponse,

    async *translateStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const id = generateId();
      const created = Math.floor(Date.now() / 1000);
      let emittedRole = false;

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
              const data = JSON.parse(trimmed.substring(6));
              const candidate = data.candidates?.[0];

              if (!candidate) continue;

              const parts = candidate.content?.parts || [];
              for (const part of parts) {
                if (part.text !== undefined) {
                  const chunk: ChatCompletionChunk = {
                    id, object: 'chat.completion.chunk', created, model: `google/${data.modelVersion || 'unknown'}`,
                    choices: [{
                      index: 0,
                      delta: emittedRole ? { content: part.text } : { role: 'assistant', content: part.text },
                      finish_reason: null,
                    }],
                  };
                  emittedRole = true;
                  yield chunk;
                }
              }

              if (candidate.finishReason) {
                yield {
                  id, object: 'chat.completion.chunk', created, model: `google/${data.modelVersion || 'unknown'}`,
                  choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(candidate.finishReason) }],
                  usage: data.usageMetadata ? {
                    prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                    completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                    total_tokens: data.usageMetadata.totalTokenCount || 0,
                  } : undefined,
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
        message: err?.message || 'Unknown Google error',
        metadata: { provider_name: 'google', raw: error } as AnyModelErrorMetadata,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const res = await fetch(`${GEMINI_API_BASE}/models?key=${apiKey}`);

        if (!res.ok) return FALLBACK_MODELS;

        const data = await res.json() as any;
        const models = (data.models || []) as any[];

        return models
          .filter((m: any) => m.name?.startsWith('models/gemini-') && m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: any) => {
            const modelId = m.name.replace('models/', '');
            return {
              id: `google/${modelId}`,
              name: m.displayName || modelId,
              created: 0,
              description: m.description || '',
              context_length: m.inputTokenLimit || 1048576,
              pricing: { prompt: '0', completion: '0' },
              architecture: {
                modality: 'text+image->text',
                input_modalities: ['text', 'image', 'video', 'audio'],
                output_modalities: ['text'],
                tokenizer: 'gemini',
              },
              top_provider: {
                context_length: m.inputTokenLimit || 1048576,
                max_completion_tokens: m.outputTokenLimit || 65536,
                is_moderated: false,
              },
              supported_parameters: Array.from(SUPPORTED_PARAMS),
            };
          });
      } catch {
        return FALLBACK_MODELS;
      }
    },

    supportsParameter(param: string): boolean {
      return SUPPORTED_PARAMS.has(param);
    },

    supportsBatch(): boolean {
      return false;
    },

    async sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion> {
      const body = translateRequest(request);
      const url = getModelEndpoint(request.model, false);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let errorBody: any;
        try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
        throw new AnyModelError(mapErrorCode(res.status), errorBody?.error?.message || res.statusText, {
          provider_name: 'google', raw: errorBody,
        });
      }
      const json = await res.json();
      return translateResponse(json);
    },

    async sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
      const body = translateRequest(request);
      const url = getModelEndpoint(request.model, true);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let errorBody: any;
        try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
        throw new AnyModelError(mapErrorCode(res.status), errorBody?.error?.message || res.statusText, {
          provider_name: 'google', raw: errorBody,
        });
      }
      if (!res.body) {
        throw new AnyModelError(502, 'No response body for streaming request', { provider_name: 'google' });
      }
      return adapter.translateStream(res.body);
    },
  };

  return adapter;
}
