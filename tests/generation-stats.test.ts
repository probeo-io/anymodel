import { describe, it, expect } from 'vitest';
import { GenerationStatsStore } from '../src/utils/generation-stats.js';

describe('GenerationStatsStore', () => {
  it('records and retrieves a generation', () => {
    const store = new GenerationStatsStore();
    store.record({
      id: 'gen-abc123',
      model: 'anthropic/claude-sonnet-4-6',
      providerName: 'anthropic',
      promptTokens: 100,
      completionTokens: 50,
      startTime: 1000,
      endTime: 2500,
      finishReason: 'stop',
      streamed: false,
    });

    const stats = store.get('gen-abc123');
    expect(stats).toBeDefined();
    expect(stats!.id).toBe('gen-abc123');
    expect(stats!.model).toBe('anthropic/claude-sonnet-4-6');
    expect(stats!.provider_name).toBe('anthropic');
    expect(stats!.tokens_prompt).toBe(100);
    expect(stats!.tokens_completion).toBe(50);
    expect(stats!.latency).toBe(1500);
    expect(stats!.streamed).toBe(false);
  });

  it('returns undefined for unknown id', () => {
    const store = new GenerationStatsStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('lists recent generations', () => {
    const store = new GenerationStatsStore();
    for (let i = 0; i < 5; i++) {
      store.record({
        id: `gen-${i}`,
        model: 'openai/gpt-4o',
        providerName: 'openai',
        promptTokens: 10,
        completionTokens: 5,
        startTime: i * 1000,
        endTime: i * 1000 + 500,
        finishReason: 'stop',
        streamed: false,
      });
    }

    const list = store.list(3);
    expect(list).toHaveLength(3);
    // Most recent first
    expect(list[0].id).toBe('gen-4');
  });

  it('evicts oldest when at capacity', () => {
    const store = new GenerationStatsStore(3);
    for (let i = 0; i < 5; i++) {
      store.record({
        id: `gen-${i}`,
        model: 'openai/gpt-4o',
        providerName: 'openai',
        promptTokens: 10,
        completionTokens: 5,
        startTime: 0,
        endTime: 100,
        finishReason: 'stop',
        streamed: false,
      });
    }

    expect(store.get('gen-0')).toBeUndefined();
    expect(store.get('gen-1')).toBeUndefined();
    expect(store.get('gen-4')).toBeDefined();
  });
});
