import type { BatchAdapter, NativeBatchStatus } from './adapter.js';
import type { BatchRequestItem, BatchResultItem, ChatCompletion } from '../types.js';
import { AnyModelError } from '../types.js';
import { rejectWebSearch } from '../utils/web-search.js';
import { generateId } from '../utils/id.js';
import { resolveMaxTokens } from '../utils/token-estimate.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

const DEEPINFRA_API_BASE = 'https://api.deepinfra.com/v1/openai';

/** The only endpoint anymodel batches against, and the only completion window DeepInfra accepts. */
const BATCH_ENDPOINT = '/v1/chat/completions';
const COMPLETION_WINDOW = '24h';

export function createDeepInfraBatchAdapter(apiKey: string, baseURL = DEEPINFRA_API_BASE): BatchAdapter {
  async function apiRequest(path: string, options: {
    method?: string;
    body?: unknown;
    formData?: FormData;
  } = {}): Promise<Response> {
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

    const res = await fetchWithTimeout(`${baseURL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: fetchBody,
    });

    if (!res.ok) {
      let errorBody: any;
      try { errorBody = await res.json(); } catch { errorBody = { message: res.statusText }; }
      const msg = errorBody?.error?.message || errorBody?.detail || errorBody?.message || res.statusText;
      throw new AnyModelError(res.status >= 500 ? 502 : res.status, msg, {
        provider_name: 'deepinfra',
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
        max_tokens: req.max_tokens !== undefined ? req.max_tokens : resolveMaxTokens(model, req.messages),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.top_p !== undefined) body.top_p = req.top_p;
      if (req.stop !== undefined) body.stop = req.stop;
      if (req.response_format !== undefined) body.response_format = req.response_format;
      rejectWebSearch(req.tools, 'deepinfra');
      if (req.tools !== undefined) body.tools = req.tools;
      if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
      // DeepInfra has no retention controls — only the cache partition key applies.
      if (req.cache?.key !== undefined) body.prompt_cache_key = req.cache.key;

      return JSON.stringify({
        custom_id: req.custom_id,
        method: 'POST',
        url: BATCH_ENDPOINT,
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

  function translateDeepInfraResponse(body: any): ChatCompletion {
    return {
      id: rePrefixId(body.id || generateId()),
      object: 'chat.completion',
      created: body.created || Math.floor(Date.now() / 1000),
      model: `deepinfra/${body.model}`,
      choices: body.choices,
      usage: body.usage,
    };
  }

  function mapStatus(deepinfraStatus: string): NativeBatchStatus['status'] {
    switch (deepinfraStatus) {
      case 'validating':
      case 'in_progress':
      case 'finalizing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      // Expired batches still publish the lines that finished, so they are
      // terminal-with-results rather than a clean success.
      case 'expired':
        return 'failed';
      case 'cancelled':
      case 'cancelling':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  async function readJsonlLines(fileId: string): Promise<any[]> {
    const res = await apiRequest(`/files/${fileId}/content`);
    const text = await res.text();
    const items: any[] = [];
    for (const line of text.trim().split('\n')) {
      if (!line) continue;
      items.push(JSON.parse(line));
    }
    return items;
  }

  return {
    async createBatch(model, requests, options) {
      const jsonlContent = buildJSONL(model, requests);
      const blob = new Blob([jsonlContent], { type: 'application/jsonl' });

      const formData = new FormData();
      formData.append('purpose', 'batch');
      formData.append('file', blob, 'batch_input.jsonl');

      const uploadRes = await apiRequest('/files', { method: 'POST', formData });
      const fileData = await uploadRes.json();
      const inputFileId = fileData.id;

      const batchRes = await apiRequest('/batches', {
        method: 'POST',
        body: {
          input_file_id: inputFileId,
          endpoint: BATCH_ENDPOINT,
          completion_window: COMPLETION_WINDOW,
          metadata: options?.metadata as Record<string, string> | undefined,
          output_expires_after: options?.output_expires_after,
        },
      });
      const batchData = await batchRes.json();

      return {
        providerBatchId: batchData.id,
        metadata: {
          input_file_id: inputFileId,
          deepinfra_status: batchData.status,
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
      const batchRes = await apiRequest(`/batches/${providerBatchId}`);
      const batchData = await batchRes.json();

      const results: BatchResultItem[] = [];

      if (batchData.output_file_id) {
        for (const item of await readJsonlLines(batchData.output_file_id)) {
          if (item.response?.status_code === 200) {
            results.push({
              custom_id: item.custom_id,
              status: 'success',
              response: translateDeepInfraResponse(item.response.body),
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

      if (batchData.error_file_id) {
        for (const item of await readJsonlLines(batchData.error_file_id)) {
          const existing = results.find(r => r.custom_id === item.custom_id);
          if (existing) continue;
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

      return results;
    },

    async cancelBatch(providerBatchId) {
      await apiRequest(`/batches/${providerBatchId}/cancel`, { method: 'POST' });
    },
  };
}
