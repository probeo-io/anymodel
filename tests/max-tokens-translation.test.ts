import { describe, it, expect } from 'vitest';
import { createOpenAIAdapter } from '../src/providers/openai.js';
import { createAnthropicAdapter } from '../src/providers/anthropic.js';
import { createGoogleAdapter } from '../src/providers/google.js';
import type { ChatCompletionRequest } from '../src/types.js';

function baseRequest(model: string, maxTokens?: number): ChatCompletionRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: maxTokens,
  };
}

describe('max_tokens translation', () => {
  describe('OpenAI adapter', () => {
    const adapter = createOpenAIAdapter('test-key');

    // ─── Models that need max_completion_tokens ───────────────────────

    it('translates max_tokens to max_completion_tokens for gpt-4o', () => {
      const body = adapter.translateRequest(baseRequest('gpt-4o', 1000)) as any;
      expect(body.max_completion_tokens).toBe(1000);
      expect(body.max_tokens).toBeUndefined();
    });

    it('translates max_tokens to max_completion_tokens for gpt-4o-mini', () => {
      const body = adapter.translateRequest(baseRequest('gpt-4o-mini', 500)) as any;
      expect(body.max_completion_tokens).toBe(500);
      expect(body.max_tokens).toBeUndefined();
    });

    it('translates max_tokens to max_completion_tokens for o1', () => {
      const body = adapter.translateRequest(baseRequest('o1', 2000)) as any;
      expect(body.max_completion_tokens).toBe(2000);
      expect(body.max_tokens).toBeUndefined();
    });

    it('translates max_tokens to max_completion_tokens for o3', () => {
      const body = adapter.translateRequest(baseRequest('o3', 4000)) as any;
      expect(body.max_completion_tokens).toBe(4000);
      expect(body.max_tokens).toBeUndefined();
    });

    it('translates max_tokens to max_completion_tokens for o4-mini', () => {
      const body = adapter.translateRequest(baseRequest('o4-mini', 8000)) as any;
      expect(body.max_completion_tokens).toBe(8000);
      expect(body.max_tokens).toBeUndefined();
    });

    it('translates max_tokens to max_completion_tokens for gpt-5-mini', () => {
      const body = adapter.translateRequest(baseRequest('gpt-5-mini', 16000)) as any;
      expect(body.max_completion_tokens).toBe(16000);
      expect(body.max_tokens).toBeUndefined();
    });

    // ─── Legacy models that keep max_tokens ──────────────────────────

    it('keeps max_tokens for gpt-4-turbo', () => {
      const body = adapter.translateRequest(baseRequest('gpt-4-turbo', 1000)) as any;
      expect(body.max_tokens).toBe(1000);
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('keeps max_tokens for gpt-3.5-turbo', () => {
      const body = adapter.translateRequest(baseRequest('gpt-3.5-turbo', 500)) as any;
      expect(body.max_tokens).toBe(500);
      expect(body.max_completion_tokens).toBeUndefined();
    });

    // ─── Omitted max_tokens ──────────────────────────────────────────

    it('omits both when max_tokens is undefined for new models', () => {
      const body = adapter.translateRequest(baseRequest('gpt-4o')) as any;
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('omits both when max_tokens is undefined for legacy models', () => {
      const body = adapter.translateRequest(baseRequest('gpt-4-turbo')) as any;
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
    });
  });

  describe('Anthropic adapter', () => {
    const adapter = createAnthropicAdapter('test-key');

    it('always sends max_tokens for Anthropic', () => {
      const body = adapter.translateRequest(baseRequest('claude-sonnet-4-6', 2000)) as any;
      expect(body.max_tokens).toBe(2000);
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('defaults max_tokens to 4096 when not provided', () => {
      const body = adapter.translateRequest(baseRequest('claude-sonnet-4-6')) as any;
      expect(body.max_tokens).toBe(4096);
    });
  });

  describe('Google adapter', () => {
    const adapter = createGoogleAdapter('test-key');

    it('translates max_tokens to maxOutputTokens for Gemini', () => {
      const body = adapter.translateRequest(baseRequest('gemini-2.5-pro', 8000)) as any;
      expect(body.generationConfig.maxOutputTokens).toBe(8000);
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('omits maxOutputTokens when max_tokens is undefined', () => {
      const body = adapter.translateRequest(baseRequest('gemini-2.5-flash')) as any;
      expect(body.generationConfig).toBeUndefined();
    });
  });
});
