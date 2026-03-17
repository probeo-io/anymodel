import type { BatchAdapter, NativeBatchStatus } from './adapter.js';
import type { BatchRequestItem, BatchResultItem, ChatCompletion, Message, ToolCall } from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { resolveMaxTokens } from '../utils/token-estimate.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function createGoogleBatchAdapter(apiKey: string): BatchAdapter {
  async function apiRequest(path: string, options: {
    method?: string;
    body?: unknown;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };

    const res = await fetchWithTimeout(`${GEMINI_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let errorBody: any;
      try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(res.status >= 500 ? 502 : res.status, msg, {
        provider_name: 'google',
        raw: errorBody,
      });
    }

    return res;
  }

  function translateRequestToGemini(model: string, req: BatchRequestItem): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    // Extract system messages
    const systemMessages = req.messages.filter(m => m.role === 'system');
    const nonSystemMessages = req.messages.filter(m => m.role !== 'system');

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
          ? m.content.map((p: any) => p.type === 'text' ? { text: p.text } : { text: '' })
          : [{ text: '' }],
    }));

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    generationConfig.maxOutputTokens = req.max_tokens !== undefined
      ? req.max_tokens
      : resolveMaxTokens(model, req.messages);
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
    if (req.top_k !== undefined) generationConfig.topK = req.top_k;
    if (req.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }

    if (req.response_format) {
      if (req.response_format.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json';
      } else if (req.response_format.type === 'json_schema') {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = req.response_format.json_schema?.schema;
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Map tools
    if (req.tools && req.tools.length > 0) {
      body.tools = [{
        functionDeclarations: req.tools.map(t => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || {},
        })),
      }];

      if (req.tool_choice) {
        if (req.tool_choice === 'auto') {
          body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        } else if (req.tool_choice === 'required') {
          body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (req.tool_choice === 'none') {
          body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        } else if (typeof req.tool_choice === 'object') {
          body.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [req.tool_choice.function.name],
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

  function translateGeminiResponse(response: any, model: string): ChatCompletion {
    const candidate = response.candidates?.[0];

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
      model: `google/${model}`,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  function mapBatchState(state: string): NativeBatchStatus['status'] {
    switch (state) {
      case 'JOB_STATE_PENDING':
        return 'pending';
      case 'JOB_STATE_RUNNING':
        return 'processing';
      case 'JOB_STATE_SUCCEEDED':
        return 'completed';
      case 'JOB_STATE_FAILED':
        return 'failed';
      case 'JOB_STATE_CANCELLED':
        return 'cancelled';
      case 'JOB_STATE_EXPIRED':
        return 'failed';
      default:
        return 'pending';
    }
  }

  return {
    async createBatch(model, requests, _options) {
      // Build inline batch requests
      const batchRequests = requests.map(req => ({
        request: translateRequestToGemini(model, req),
        metadata: { key: req.custom_id },
      }));

      const res = await apiRequest(`/models/${model}:batchGenerateContent`, {
        method: 'POST',
        body: {
          batch: {
            display_name: `anymodel-batch-${Date.now()}`,
            input_config: {
              requests: {
                requests: batchRequests,
              },
            },
          },
        },
      });
      const data = await res.json();

      // The response contains a batch name like "batches/123456789"
      const batchName = data.name || data.batch?.name;
      if (!batchName) {
        throw new AnyModelError(502, 'No batch name in Google response', {
          provider_name: 'google',
          raw: data,
        });
      }

      return {
        providerBatchId: batchName,
        metadata: {
          model,
          total_requests: requests.length,
        },
      };
    },

    async pollBatch(providerBatchId) {
      const res = await apiRequest(`/${providerBatchId}`);
      const data = await res.json();

      const state = data.state || 'JOB_STATE_PENDING';
      const status = mapBatchState(state);

      // Google doesn't provide granular counts during processing
      const totalCount = data.totalCount || data.metadata?.total_requests || 0;
      const successCount = data.succeededCount || 0;
      const failedCount = data.failedCount || 0;

      return {
        status,
        total: totalCount || successCount + failedCount,
        completed: successCount,
        failed: failedCount,
      };
    },

    async getBatchResults(providerBatchId) {
      // First get the batch to check for inline results or file reference
      const batchRes = await apiRequest(`/${providerBatchId}`);
      const batchData = await batchRes.json();

      const results: BatchResultItem[] = [];
      const model = batchData.metadata?.model || 'unknown';

      // Check for inline responses
      if (batchData.response?.inlinedResponses) {
        for (const item of batchData.response.inlinedResponses) {
          const customId = item.metadata?.key || `request-${results.length}`;

          if (item.response) {
            results.push({
              custom_id: customId,
              status: 'success',
              response: translateGeminiResponse(item.response, model),
              error: null,
            });
          } else if (item.error) {
            results.push({
              custom_id: customId,
              status: 'error',
              response: null,
              error: {
                code: item.error.code || 500,
                message: item.error.message || 'Batch item failed',
              },
            });
          }
        }
        return results;
      }

      // Check for file-based results
      const responsesFile = batchData.response?.responsesFileName ||
                            batchData.outputConfig?.file_name;

      if (responsesFile) {
        const downloadUrl = `${GEMINI_API_BASE}/${responsesFile}:download?alt=media`;
        const fileRes = await fetchWithTimeout(downloadUrl, {
          headers: { 'x-goog-api-key': apiKey },
        });

        if (!fileRes.ok) {
          throw new AnyModelError(502, 'Failed to download batch results file', {
            provider_name: 'google',
          });
        }

        const text = await fileRes.text();
        for (const line of text.trim().split('\n')) {
          if (!line) continue;
          const item = JSON.parse(line);
          const customId = item.key || item.metadata?.key || `request-${results.length}`;

          if (item.response) {
            results.push({
              custom_id: customId,
              status: 'success',
              response: translateGeminiResponse(item.response, model),
              error: null,
            });
          } else if (item.error) {
            results.push({
              custom_id: customId,
              status: 'error',
              response: null,
              error: {
                code: item.error.code || 500,
                message: item.error.message || 'Batch item failed',
              },
            });
          }
        }
      }

      return results;
    },

    async cancelBatch(providerBatchId) {
      await apiRequest(`/${providerBatchId}:cancel`, { method: 'POST' });
    },
  };
}
