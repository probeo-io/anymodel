import { describe, expect, it } from 'vitest';
import { createXAIAdapter } from '../src/providers/xai.js';
import type { ChatCompletionRequest } from '../src/types.js';

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'Research Texas LLC fees.' }],
    ...overrides,
  };
}

describe('xAI adapter', () => {
  const adapter = createXAIAdapter('test-key');

  it('uses chat completion shape for normal requests', () => {
    const body = adapter.translateRequest(request()) as any;
    expect(body.messages).toEqual([{ role: 'user', content: 'Research Texas LLC fees.' }]);
    expect(body.input).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('uses Responses shape when web_search is requested', () => {
    const body = adapter.translateRequest(request({
      tools: [{ type: 'web_search' }],
      response_format: { type: 'json_object' },
    })) as any;

    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([{ role: 'user', content: 'Research Texas LLC fees.' }]);
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.text).toEqual({ format: { type: 'json_object' } });
  });

  it('translates Responses output into chat completion shape and preserves xAI metadata', () => {
    const completion = adapter.translateResponse({
      id: 'resp_123',
      model: 'grok-4.5',
      output_text: '{"ok":true}',
      citations: ['https://www.sos.state.tx.us/corp/instructions/205.shtml'],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        server_side_tool_usage_details: { web_search_calls: 1 },
      },
      output: [{ type: 'web_search_call' }],
    }) as any;

    expect(completion.model).toBe('xai/grok-4.5');
    expect(completion.choices[0].message.content).toBe('{"ok":true}');
    expect(completion.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(completion.citations).toEqual(['https://www.sos.state.tx.us/corp/instructions/205.shtml']);
    expect(completion.server_side_tool_usage_details).toEqual({ web_search_calls: 1 });
  });
});
