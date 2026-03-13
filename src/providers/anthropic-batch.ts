import type { BatchAdapter, NativeBatchStatus } from './adapter.js';
import type { BatchRequestItem, BatchResultItem, ChatCompletion, Message, ToolCall } from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicBatchAdapter(apiKey: string): BatchAdapter {
  async function apiRequest(path: string, options: {
    method?: string;
    body?: unknown;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    };

    const res = await fetch(`${ANTHROPIC_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let errorBody: any;
      try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(res.status >= 500 ? 502 : res.status, msg, {
        provider_name: 'anthropic',
        raw: errorBody,
      });
    }

    return res;
  }

  function translateToAnthropicParams(model: string, req: BatchRequestItem): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model,
      max_tokens: req.max_tokens || DEFAULT_MAX_TOKENS,
    };

    // Extract system messages
    const systemMessages = req.messages.filter(m => m.role === 'system');
    const nonSystemMessages = req.messages.filter(m => m.role !== 'system');

    if (systemMessages.length > 0) {
      params.system = systemMessages
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join('\n');
    }

    // Map messages
    params.messages = nonSystemMessages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.tool_call_id
        ? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }]
        : m.content,
    }));

    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.top_p !== undefined) params.top_p = req.top_p;
    if (req.top_k !== undefined) params.top_k = req.top_k;
    if (req.stop !== undefined) params.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    // Map tools
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));

      if (req.tool_choice) {
        if (req.tool_choice === 'auto') {
          params.tool_choice = { type: 'auto' };
        } else if (req.tool_choice === 'required') {
          params.tool_choice = { type: 'any' };
        } else if (req.tool_choice === 'none') {
          delete params.tools;
        } else if (typeof req.tool_choice === 'object') {
          params.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
        }
      }
    }

    // Handle response_format
    if (req.response_format) {
      if (req.response_format.type === 'json_object' || req.response_format.type === 'json_schema') {
        const jsonInstruction = 'Respond with valid JSON only. Do not include any text outside the JSON object.';
        params.system = params.system ? `${jsonInstruction}\n\n${params.system}` : jsonInstruction;
      }
    }

    return params;
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

  function translateAnthropicMessage(msg: any): ChatCompletion {
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of msg.content || []) {
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

    const message: Message = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `anthropic/${msg.model}`,
      choices: [{
        index: 0,
        message,
        finish_reason: mapStopReason(msg.stop_reason),
      }],
      usage: {
        prompt_tokens: msg.usage?.input_tokens || 0,
        completion_tokens: msg.usage?.output_tokens || 0,
        total_tokens: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0),
      },
    };
  }

  return {
    async createBatch(model, requests, _options) {
      // Build Anthropic batch request format
      const batchRequests = requests.map(req => ({
        custom_id: req.custom_id,
        params: translateToAnthropicParams(model, req),
      }));

      const res = await apiRequest('/messages/batches', {
        method: 'POST',
        body: { requests: batchRequests },
      });
      const data = await res.json();

      return {
        providerBatchId: data.id,
        metadata: {
          anthropic_type: data.type,
          created_at: data.created_at,
        },
      };
    },

    async pollBatch(providerBatchId) {
      const res = await apiRequest(`/messages/batches/${providerBatchId}`);
      const data = await res.json();

      const counts = data.request_counts || {};
      const total = (counts.processing || 0) + (counts.succeeded || 0) +
                    (counts.errored || 0) + (counts.canceled || 0) + (counts.expired || 0);

      let status: NativeBatchStatus['status'];
      if (data.processing_status === 'ended') {
        // Check if all failed
        if (counts.succeeded === 0 && (counts.errored > 0 || counts.expired > 0 || counts.canceled > 0)) {
          status = 'failed';
        } else if (data.cancel_initiated_at) {
          status = 'cancelled';
        } else {
          status = 'completed';
        }
      } else {
        status = 'processing';
      }

      return {
        status,
        total,
        completed: counts.succeeded || 0,
        failed: (counts.errored || 0) + (counts.expired || 0) + (counts.canceled || 0),
      };
    },

    async getBatchResults(providerBatchId) {
      const res = await apiRequest(`/messages/batches/${providerBatchId}/results`);
      const text = await res.text();
      const results: BatchResultItem[] = [];

      for (const line of text.trim().split('\n')) {
        if (!line) continue;
        const item = JSON.parse(line);

        if (item.result?.type === 'succeeded') {
          results.push({
            custom_id: item.custom_id,
            status: 'success',
            response: translateAnthropicMessage(item.result.message),
            error: null,
          });
        } else {
          // errored, expired, or canceled
          const errorType = item.result?.type || 'unknown';
          const errorMsg = item.result?.error?.message || `Batch item ${errorType}`;
          results.push({
            custom_id: item.custom_id,
            status: 'error',
            response: null,
            error: {
              code: errorType === 'expired' ? 408 : 500,
              message: errorMsg,
            },
          });
        }
      }

      return results;
    },

    async cancelBatch(providerBatchId) {
      await apiRequest(`/messages/batches/${providerBatchId}/cancel`, { method: 'POST' });
    },
  };
}
