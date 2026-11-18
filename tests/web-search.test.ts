import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicAdapter } from '../src/providers/anthropic.js';
import { createAnthropicBatchAdapter } from '../src/providers/anthropic-batch.js';
import { createXAIBatchAdapter } from '../src/providers/xai-batch.js';
import { createGoogleAdapter } from '../src/providers/google.js';
import { createPerplexityAdapter } from '../src/providers/perplexity.js';
import { createDeepInfraAdapter } from '../src/providers/deepinfra.js';
import { createDeepInfraBatchAdapter } from '../src/providers/deepinfra-batch.js';
import type { ChatCompletionRequest, Tool } from '../src/types.js';

const lookup: Tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Best payroll for five people?' }], ...overrides };
}

/** Answers each fetch in turn and records the JSON bodies sent. */
function stubFetch(...replies: unknown[]) {
  const sent: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(init?.body ? JSON.parse(init.body as string) : undefined);
    return new Response(JSON.stringify(replies.shift() ?? {}), { status: 200 });
  }));
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('web search on Anthropic', () => {
  const adapter = createAnthropicAdapter('test-key');

  it('sends the web search server tool alongside function tools', () => {
    const body = adapter.translateRequest(request({
      tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }, lookup],
    })) as any;
    expect(body.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', allowed_domains: ['example.com'] },
      { name: 'lookup', description: '', input_schema: { type: 'object', properties: {} } },
    ]);
  });

  it('refuses an allow list and a block list together, as the API would', () => {
    expect(() => adapter.translateRequest(request({
      tools: [{ type: 'web_search', filters: { allowed_domains: ['a.com'], blocked_domains: ['b.com'] } }],
    }))).toThrow(/not both/);
  });

  it('uses the basic search version on models before Opus 4.6 / Sonnet 4.6', () => {
    const type = (model: string) => (adapter.translateRequest(request({ model, tools: [{ type: 'web_search' }] })) as any).tools[0].type;
    expect(type('claude-sonnet-4-6')).toBe('web_search_20260209');
    expect(type('claude-fable-5-1')).toBe('web_search_20260209');
    expect(type('claude-haiku-4-5')).toBe('web_search_20250305');
    expect(type('claude-haiku-5-5')).toBe('web_search_20250305');
    expect(type('claude-opus-4-1-20250805')).toBe('web_search_20250305');
    expect(type('claude-sonnet-4-20250514')).toBe('web_search_20250305');
  });

  it('returns the pages its searches found, cited ones first', () => {
    const completion = adapter.translateResponse({
      model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'payroll' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [
          { type: 'web_search_result', url: 'https://b.com', title: 'B' }, { type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
        { type: 'text', text: 'Gusto is common.', citations: [{ type: 'web_search_result_location', url: 'https://a.com', title: 'A', cited_text: 'Gusto' }] },
      ],
    }) as any;
    expect(completion.choices[0].message.content).toBe('Gusto is common.');
    expect(completion.choices[0].message.tool_calls).toBeUndefined();
    expect(completion.citations).toEqual([{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }]);
    expect(completion.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  it('resumes a paused turn and joins the answer', async () => {
    const paused = { model: 'claude-opus-5-5', stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: 'text', text: 'Part one. ' }] };
    const done = { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 },
      content: [{ type: 'text', text: 'Part two.' }] };
    const sent = stubFetch(paused, done);
    const completion = await adapter.sendRequest(request({ tools: [{ type: 'web_search' }] }));
    expect(sent).toHaveLength(2);
    expect(sent[1].messages.at(-1)).toEqual({ role: 'assistant', content: paused.content });
    expect(completion.choices[0].message.content).toBe('Part one. Part two.');
    expect(completion.usage.prompt_tokens).toBe(22);
  });

  it('does not stream a web search as a tool call', async () => {
    const events = [
      { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
    ];
    const sse = events.map(e => `data: ${JSON.stringify(e)}\n`).join('');
    const chunks = [];
    for await (const c of adapter.translateStream(new Response(sse).body!)) chunks.push(c);
    expect(chunks.some(c => c.choices[0].delta.tool_calls)).toBe(false);
    expect(chunks.map(c => c.choices[0].delta.content).join('')).toBe('Hi');
  });

  it('sends the search tool in a batch', async () => {
    const sent = stubFetch({ id: 'b1' });
    await createAnthropicBatchAdapter('k').createBatch('claude-opus-5-5', [
      { custom_id: 'r1', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search' }] },
    ]);
    expect(sent[0].requests[0].params.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search' }]);
  });
});

describe('web search in an xAI batch', () => {
  it('keeps the web search tool', async () => {
    const sent = stubFetch({ batch_id: 'b1' }, {});
    await createXAIBatchAdapter('k').createBatch('grok-4.5', [
      { custom_id: 'r1', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search' }, lookup] },
    ]);
    expect(sent[1].batch_requests[0].batch_request.responses.tools).toEqual([
      { type: 'web_search' },
      { type: 'function', name: 'lookup', description: undefined, parameters: { type: 'object', properties: {} } },
    ]);
  });
});

describe('web search on Google', () => {
  const adapter = createGoogleAdapter('k');

  it('sends Google Search alongside function declarations', () => {
    const body = adapter.translateRequest(request({ model: 'gemini-3-pro', tools: [{ type: 'web_search' }, lookup] })) as any;
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: 'lookup', description: '', parameters: { type: 'object', properties: {} } }] },
      { googleSearch: {} },
    ]);
  });

  it('refuses domain filters, which Google Search does not have', () => {
    expect(() => adapter.translateRequest(request({ tools: [{ type: 'web_search', filters: { blocked_domains: ['b.com'] } }] })))
      .toThrow(/no domain filters/);
  });

  it('returns the grounding pages as citations', () => {
    const completion = adapter.translateResponse({ modelVersion: 'gemini-3-pro', candidates: [{
      content: { parts: [{ text: 'Gusto.' }] }, finishReason: 'STOP',
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://a.com', title: 'a.com' } }] },
    }] }) as any;
    expect(completion.citations).toEqual([{ url: 'https://a.com', title: 'a.com' }]);
  });
});

describe('web search on Perplexity', () => {
  const adapter = createPerplexityAdapter('k');

  it('leaves the tool off and turns its filters into search_domain_filter', () => {
    const body = adapter.translateRequest(request({ model: 'sonar', tools: [{ type: 'web_search', filters: { blocked_domains: ['b.com'] } }] })) as any;
    expect(body.tools).toBeUndefined();
    expect(body.search_domain_filter).toEqual(['-b.com']);
  });

  it('keeps function tools', () => {
    const body = adapter.translateRequest(request({ model: 'sonar', tools: [{ type: 'web_search' }, lookup] })) as any;
    expect(body.tools).toEqual([lookup]);
    expect(body.search_domain_filter).toBeUndefined();
  });
});

describe('web search on DeepInfra', () => {
  it('fails with an error that says there is no search', () => {
    expect(() => createDeepInfraAdapter('k').translateRequest(request({ model: 'x', tools: [{ type: 'web_search' }] })))
      .toThrow(/no built-in web search/);
  });

  it('fails the same way in a batch', async () => {
    stubFetch({});
    await expect(createDeepInfraBatchAdapter('k').createBatch('x', [
      { custom_id: 'r1', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'web_search' }] },
    ])).rejects.toThrow(/no built-in web search/);
  });
});

describe('Gemini usage', () => {
  it('counts thinking tokens as output and tool tokens as input', () => {
    const completion = createGoogleAdapter('k').translateResponse({ modelVersion: 'gemini-3.8-flash', candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, toolUsePromptTokenCount: 300, candidatesTokenCount: 1158, thoughtsTokenCount: 536, totalTokenCount: 2006 } }) as any;
    expect(completion.usage).toEqual({ prompt_tokens: 312, completion_tokens: 1694, total_tokens: 2006 });
  });
});

describe('tool fees in the cost', () => {
  it('prices each provider\'s searches on the usage', () => {
    const anthropic = createAnthropicAdapter('k').translateResponse({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [],
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } } }) as any;
    expect(anthropic.usage.tool_cost).toBeCloseTo(0.02);
    const google = createGoogleAdapter('k').translateResponse({ modelVersion: 'gemini-3.5-flash-lite', candidates: [{ content: { parts: [{ text: 'x' }] },
      finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } }], usageMetadata: {} }) as any;
    expect(google.usage.tool_cost).toBeCloseTo(0.042);
    const pplx = createPerplexityAdapter('k').translateResponse({ id: 'x', model: 'sonar-pro', created: 0, choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 239, total_tokens: 250, cost: { request_cost: 0.0025 } } }) as any;
    expect(pplx.usage.tool_cost).toBe(0.0025);
  });

  it('adds tool fees to the provider cost, undiscounted', async () => {
    const { calculateProviderCost, calculateCost } = await import('../src/generated/pricing.js');
    const usage = { promptTokens: 1000, completionTokens: 100 };
    const tokens = calculateCost('anthropic/claude-sonnet-5-5', 1000, 100);
    expect(calculateProviderCost({ model: 'anthropic/claude-sonnet-5-5', usage: { ...usage, toolCost: 0.02 } }).estimatedCost).toBeCloseTo(tokens + 0.02);
  });
});
