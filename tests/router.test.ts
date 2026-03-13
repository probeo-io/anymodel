import { describe, it, expect, vi } from 'vitest';
import { Router } from '../src/router.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ProviderAdapter } from '../src/providers/adapter.js';
import type { ChatCompletionRequest, ChatCompletion, ModelInfo } from '../src/types.js';
import { generateId } from '../src/utils/id.js';

function createMockAdapter(name: string, supportedParams: string[]): ProviderAdapter {
  const paramSet = new Set(supportedParams);
  let lastRequest: any = null;

  const mockResponse: ChatCompletion = {
    id: generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${name}/test-model`,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  return {
    name,
    translateRequest: (r) => r,
    translateResponse: (r) => r as ChatCompletion,
    async *translateStream() { /* empty */ },
    translateError: (e) => ({ code: 500, message: 'error', metadata: {} }),
    listModels: async () => [],
    supportsParameter: (p) => paramSet.has(p),
    sendRequest: async (request) => {
      lastRequest = request;
      return mockResponse;
    },
    sendStreamingRequest: async function* () { /* empty */ } as any,
    // Expose for assertions
    get _lastRequest() { return lastRequest; },
  } as ProviderAdapter & { _lastRequest: any };
}

describe('Router', () => {
  it('strips unsupported parameters before sending to provider', async () => {
    const registry = new ProviderRegistry();
    // This adapter only supports temperature, not top_k or seed
    const adapter = createMockAdapter('test', ['temperature', 'max_tokens', 'top_p', 'stop', 'stream', 'tools', 'tool_choice']);
    registry.register('test', adapter);

    const router = new Router(registry);
    const request: ChatCompletionRequest = {
      model: 'test/some-model',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      top_k: 40,       // not supported
      seed: 42,         // not supported
      frequency_penalty: 0.5, // not supported
    };

    await router.complete(request);
    const sent = (adapter as any)._lastRequest;

    expect(sent.temperature).toBe(0.7);
    expect(sent.top_k).toBeUndefined();
    expect(sent.seed).toBeUndefined();
    expect(sent.frequency_penalty).toBeUndefined();
  });

  it('resolves aliases', async () => {
    const registry = new ProviderRegistry();
    const adapter = createMockAdapter('anthropic', ['temperature']);
    registry.register('anthropic', adapter);

    const router = new Router(registry, { smart: 'anthropic/claude-sonnet-4-6' });

    await router.complete({
      model: 'smart',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const sent = (adapter as any)._lastRequest;
    expect(sent.model).toBe('claude-sonnet-4-6');
  });

  it('throws on missing provider', async () => {
    const registry = new ProviderRegistry();
    const router = new Router(registry);

    await expect(
      router.complete({
        model: 'unknown/model',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toThrow(/unknown/);
  });
});
