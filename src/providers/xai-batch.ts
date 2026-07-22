import type { BatchAdapter, NativeBatchStatus } from './adapter.js';
import type { BatchRequestItem, BatchResultItem, ChatCompletion, FinishReason, FunctionTool, Message, ToolCall } from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { resolveMaxTokens } from '../utils/token-estimate.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const XAI_API_BASE = 'https://api.x.ai/v1';

function isFunctionTool(tool: unknown): tool is FunctionTool {
  return Boolean(tool && typeof tool === 'object' && (tool as FunctionTool).type === 'function');
}

type XAIContentPart = {
  type?: string;
  text?: string;
  image_url?: { url: string; detail?: string };
};

export function createXAIBatchAdapter(apiKey: string): BatchAdapter {
  async function apiRequest(path: string, options: {
    method?: string;
    body?: unknown;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const res = await fetchWithTimeout(`${XAI_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let errorBody: any;
      try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(res.status >= 500 ? 502 : res.status, msg, {
        provider_name: 'xai',
        raw: errorBody,
      });
    }

    return res;
  }

  function contentToText(content: Message['content']): string {
    if (typeof content === 'string') return content;
    return content
      .map(part => part.type === 'text' ? part.text || '' : '')
      .filter(Boolean)
      .join('\n');
  }

  function contentToResponsesContent(content: Message['content']): string | XAIContentPart[] {
    if (typeof content === 'string') return content;

    const parts = content
      .map((part): XAIContentPart | null => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text || '' };
        }
        if (part.type === 'image_url') {
          return { type: 'image_url', image_url: part.image_url };
        }
        return null;
      })
      .filter((part): part is XAIContentPart => Boolean(part));

    return parts.length > 0 ? parts : '';
  }

  function translateInput(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map(message => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: contentToText(message.content),
        };
      }

      const translated: Record<string, unknown> = {
        role: message.role,
        content: contentToResponsesContent(message.content),
      };

      if (message.name) translated.name = message.name;
      if (message.tool_calls) translated.tool_calls = message.tool_calls;
      if (message.tool_call_id) translated.tool_call_id = message.tool_call_id;

      return translated;
    });
  }

  function translateRequest(model: string, req: BatchRequestItem): Record<string, unknown> {
    const responses: Record<string, unknown> = {
      model,
      input: translateInput(req.messages),
      max_output_tokens: req.max_tokens ?? resolveMaxTokens(model, req.messages),
    };

    if (req.temperature !== undefined) responses.temperature = req.temperature;
    if (req.top_p !== undefined) responses.top_p = req.top_p;
    if (req.stop !== undefined) responses.stop = req.stop;
    if (req.cache?.key !== undefined) responses.prompt_cache_key = req.cache.key;

    if (req.tools && req.tools.length > 0) {
      const functionTools = req.tools.filter(isFunctionTool);
      responses.tools = functionTools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      }));
      if (functionTools.length === 0) delete responses.tools;
    }

    if (req.tool_choice !== undefined) responses.tool_choice = req.tool_choice;

    if (req.response_format) {
      if (req.response_format.type === 'json_schema') {
        responses.text = {
          format: {
            type: 'json_schema',
            name: req.response_format.json_schema.name,
            schema: req.response_format.json_schema.schema,
            strict: req.response_format.json_schema.strict,
          },
        };
      } else if (req.response_format.type === 'json_object') {
        responses.text = { format: { type: 'json_object' } };
      }
    }

    return { responses };
  }

  function mapFinishReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'tool_calls':
      case 'tool_use':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      case 'error':
        return 'error';
      default:
        return 'stop';
    }
  }

  function extractResponseText(body: any): string {
    if (typeof body?.output_text === 'string') return body.output_text;

    let text = '';
    for (const output of body?.output || []) {
      for (const part of output?.content || []) {
        if (typeof part?.text === 'string') {
          text += part.text;
        } else if (typeof part?.content === 'string') {
          text += part.content;
        }
      }
    }
    return text;
  }

  function extractToolCalls(body: any): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const output of body?.output || []) {
      if (output?.type === 'function_call') {
        toolCalls.push({
          id: output.call_id || output.id || generateId('call'),
          type: 'function',
          function: {
            name: output.name,
            arguments: typeof output.arguments === 'string'
              ? output.arguments
              : JSON.stringify(output.arguments || {}),
          },
        });
      }
    }

    return toolCalls;
  }

  function translateXAIResponse(body: any): ChatCompletion {
    if (body?.choices) {
      return {
        id: body.id || generateId(),
        object: 'chat.completion',
        created: body.created || Math.floor(Date.now() / 1000),
        model: `xai/${body.model || 'unknown'}`,
        choices: body.choices,
        usage: {
          prompt_tokens: body.usage?.prompt_tokens || 0,
          completion_tokens: body.usage?.completion_tokens || 0,
          total_tokens: body.usage?.total_tokens || 0,
        },
      };
    }

    const toolCalls = extractToolCalls(body);
    const message: Message = {
      role: 'assistant',
      content: extractResponseText(body),
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const inputTokens = body?.usage?.input_tokens || body?.usage?.prompt_tokens || 0;
    const outputTokens = body?.usage?.output_tokens || body?.usage?.completion_tokens || 0;

    return {
      id: body?.id || generateId(),
      object: 'chat.completion',
      created: body?.created || Math.floor(Date.now() / 1000),
      model: `xai/${body?.model || 'unknown'}`,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(body?.finish_reason || body?.status),
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: body?.usage?.total_tokens || inputTokens + outputTokens,
      },
    };
  }

  function mapBatchStatus(data: any): NativeBatchStatus['status'] {
    const status = data.status || data.processing_status || data.state?.status;
    if (status === 'cancelled' || status === 'canceled' || status === 'cancelling') return 'cancelled';
    if (status === 'failed' || status === 'expired') return 'failed';
    if (status === 'completed' || status === 'complete') return 'completed';
    if (status === 'processing' || status === 'in_progress' || status === 'running') return 'processing';

    const state = data.state || {};
    const pending = state.num_pending || 0;
    const total = state.num_requests || 0;
    const succeeded = state.num_success || 0;
    const failed = (state.num_error || 0) + (state.num_cancelled || 0);

    if (total > 0 && pending === 0) {
      return succeeded === 0 && failed > 0 ? 'failed' : 'completed';
    }
    return total > 0 ? 'processing' : 'pending';
  }

  return {
    async createBatch(model, requests, options) {
      const createRes = await apiRequest('/batches', {
        method: 'POST',
        body: {
          name: typeof options?.name === 'string'
            ? options.name
            : `anymodel-batch-${Date.now()}`,
        },
      });
      const batch = await createRes.json();
      const batchId = batch.batch_id || batch.id;

      if (!batchId) {
        throw new AnyModelError(502, 'No batch id in xAI response', {
          provider_name: 'xai',
          raw: batch,
        });
      }

      const batchRequests = requests.map(req => ({
        batch_request_id: req.custom_id,
        batch_request: translateRequest(model, req),
      }));

      await apiRequest(`/batches/${batchId}/requests`, {
        method: 'POST',
        body: { batch_requests: batchRequests },
      });

      return {
        providerBatchId: batchId,
        metadata: {
          model,
          total_requests: requests.length,
        },
      };
    },

    async pollBatch(providerBatchId) {
      const res = await apiRequest(`/batches/${providerBatchId}`);
      const data = await res.json();
      const state = data.state || {};

      const total = state.num_requests || 0;
      const failed = (state.num_error || 0) + (state.num_cancelled || 0);

      return {
        status: mapBatchStatus(data),
        total,
        completed: state.num_success || 0,
        failed,
      };
    },

    async getBatchResults(providerBatchId) {
      const results: BatchResultItem[] = [];
      let paginationToken: string | undefined;

      do {
        const search = new URLSearchParams({ limit: '100' });
        if (paginationToken) search.set('pagination_token', paginationToken);

        const res = await apiRequest(`/batches/${providerBatchId}/results?${search.toString()}`);
        const page = await res.json();

        for (const item of page.results || []) {
          const response = item.batch_result?.response;
          const completion = response?.chat_get_completion || response?.responses || response;
          const errorMessage = item.error_message || item.batch_result?.error?.message;

          if (completion && (response?.chat_get_completion || response?.responses || completion.choices || completion.output)) {
            results.push({
              custom_id: item.batch_request_id,
              status: 'success',
              response: translateXAIResponse(completion),
              error: null,
            });
          } else {
            results.push({
              custom_id: item.batch_request_id,
              status: 'error',
              response: null,
              error: {
                code: item.batch_result?.error?.code || 500,
                message: errorMessage || 'Batch item error',
              },
            });
          }
        }

        paginationToken = page.pagination_token;
      } while (paginationToken);

      return results;
    },

    async cancelBatch(providerBatchId) {
      await apiRequest(`/batches/${providerBatchId}:cancel`, { method: 'POST' });
    },
  };
}
