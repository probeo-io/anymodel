import type { BatchAdapter, NativeBatchStatus } from './adapter.js';
import type { BatchRequestItem, BatchResultItem, ChatCompletion } from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { resolveMaxTokens } from '../utils/token-estimate.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export function createOpenAIBatchAdapter(apiKey: string): BatchAdapter {
  async function apiRequest(path: string, options: {
    method?: string;
    body?: unknown;
    formData?: FormData;
  } = {}): Promise<any> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
    };

    let fetchBody: BodyInit | undefined;
    if (options.formData) {
      fetchBody = options.formData;
    } else if (options.body) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(options.body);
    }

    const res = await fetchWithTimeout(`${OPENAI_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: fetchBody,
    });

    if (!res.ok) {
      let errorBody: any;
      try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
      const msg = errorBody?.error?.message || errorBody?.message || res.statusText;
      throw new AnyModelError(res.status >= 500 ? 502 : res.status, msg, {
        provider_name: 'openai',
        raw: errorBody,
      });
    }

    return res;
  }

  function buildJSONL(model: string, requests: BatchRequestItem[]): string {
    return requests.map(req => {
      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
      };
      body.max_tokens = req.max_tokens !== undefined
        ? req.max_tokens
        : resolveMaxTokens(model, req.messages);
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.top_p !== undefined) body.top_p = req.top_p;
      if (req.stop !== undefined) body.stop = req.stop;
      if (req.response_format !== undefined) body.response_format = req.response_format;
      if (req.tools !== undefined) body.tools = req.tools;
      if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
      // service_tier intentionally omitted — native batch already gets 50% off

      return JSON.stringify({
        custom_id: req.custom_id,
        method: 'POST',
        url: '/v1/chat/completions',
        body,
      });
    }).join('\n');
  }

  function rePrefixId(id: string): string {
    if (id && id.startsWith('chatcmpl-')) {
      return `gen-${id.substring(9)}`;
    }
    return id.startsWith('gen-') ? id : `gen-${id}`;
  }

  function translateOpenAIResponse(body: any): ChatCompletion {
    return {
      id: rePrefixId(body.id || generateId()),
      object: 'chat.completion',
      created: body.created || Math.floor(Date.now() / 1000),
      model: `openai/${body.model}`,
      choices: body.choices,
      usage: body.usage,
    };
  }

  function mapStatus(openaiStatus: string): NativeBatchStatus['status'] {
    switch (openaiStatus) {
      case 'validating':
      case 'finalizing':
        return 'processing';
      case 'in_progress':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'expired':
        return 'failed';
      case 'cancelled':
      case 'cancelling':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  return {
    async createBatch(model, requests, options) {
      // 1. Build JSONL content
      const jsonlContent = buildJSONL(model, requests);
      const blob = new Blob([jsonlContent], { type: 'application/jsonl' });

      // 2. Upload file
      const formData = new FormData();
      formData.append('purpose', 'batch');
      formData.append('file', blob, 'batch_input.jsonl');

      const uploadRes = await apiRequest('/files', { method: 'POST', formData });
      const fileData = await uploadRes.json();
      const inputFileId = fileData.id;

      // 3. Create batch
      const batchRes = await apiRequest('/batches', {
        method: 'POST',
        body: {
          input_file_id: inputFileId,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          metadata: options?.metadata as Record<string, string> | undefined,
        },
      });
      const batchData = await batchRes.json();

      return {
        providerBatchId: batchData.id,
        metadata: {
          input_file_id: inputFileId,
          openai_status: batchData.status,
        },
      };
    },

    async pollBatch(providerBatchId) {
      const res = await apiRequest(`/batches/${providerBatchId}`);
      const data = await res.json();

      const requestCounts = data.request_counts || {};

      return {
        status: mapStatus(data.status),
        total: requestCounts.total || 0,
        completed: requestCounts.completed || 0,
        failed: requestCounts.failed || 0,
      };
    },

    async getBatchResults(providerBatchId) {
      // Get batch to find output file
      const batchRes = await apiRequest(`/batches/${providerBatchId}`);
      const batchData = await batchRes.json();

      const results: BatchResultItem[] = [];

      // Download output file
      if (batchData.output_file_id) {
        const outputRes = await apiRequest(`/files/${batchData.output_file_id}/content`);
        const outputText = await outputRes.text();

        for (const line of outputText.trim().split('\n')) {
          if (!line) continue;
          const item = JSON.parse(line);

          if (item.response?.status_code === 200) {
            results.push({
              custom_id: item.custom_id,
              status: 'success',
              response: translateOpenAIResponse(item.response.body),
              error: null,
            });
          } else {
            results.push({
              custom_id: item.custom_id,
              status: 'error',
              response: null,
              error: {
                code: item.response?.status_code || 500,
                message: item.error?.message || item.response?.body?.error?.message || 'Unknown error',
              },
            });
          }
        }
      }

      // Download error file
      if (batchData.error_file_id) {
        const errorRes = await apiRequest(`/files/${batchData.error_file_id}/content`);
        const errorText = await errorRes.text();

        for (const line of errorText.trim().split('\n')) {
          if (!line) continue;
          const item = JSON.parse(line);
          // Only add if not already in results
          const existing = results.find(r => r.custom_id === item.custom_id);
          if (!existing) {
            results.push({
              custom_id: item.custom_id,
              status: 'error',
              response: null,
              error: {
                code: item.response?.status_code || 500,
                message: item.error?.message || 'Batch item error',
              },
            });
          }
        }
      }

      return results;
    },

    async cancelBatch(providerBatchId) {
      await apiRequest(`/batches/${providerBatchId}/cancel`, { method: 'POST' });
    },
  };
}
