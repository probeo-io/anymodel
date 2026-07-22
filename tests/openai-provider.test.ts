import { describe, expect, it } from 'vitest';
import { createOpenAIAdapter } from '../src/providers/openai.js';
import type { ChatCompletionRequest } from '../src/types.js';

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: 'Research Texas LLC fees.' }],
    ...overrides,
  };
}

describe('OpenAI adapter', () => {
  const adapter = createOpenAIAdapter('test-key');

  it('uses chat completion shape for normal requests', () => {
    const body = adapter.translateRequest(request()) as any;
    expect(body.messages).toEqual([{ role: 'user', content: 'Research Texas LLC fees.' }]);
    expect(body.input).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('uses Responses shape when web_search is requested', () => {
    const body = adapter.translateRequest(request({
      tools: [{ type: 'web_search', search_context_size: 'high' }],
      response_format: { type: 'json_object' },
      service_tier: 'flex',
    })) as any;

    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([{ role: 'user', content: 'Research Texas LLC fees.' }]);
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }]);
    expect(body.tool_choice).toBe('required');
    expect(body.service_tier).toBe('flex');
    expect(body.text).toEqual({ format: { type: 'json_object' } });
  });

  it('translates Responses output into chat completion shape and preserves metadata', () => {
    const completion = adapter.translateResponse({
      id: 'resp_123',
      model: 'gpt-5.6-terra',
      output_text: '{"ok":true}',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        server_side_tool_usage_details: { web_search_calls: 1 },
      },
      output: [{ type: 'web_search_call' }],
    }) as any;

    expect(completion.model).toBe('openai/gpt-5.6-terra');
    expect(completion.choices[0].message.content).toBe('{"ok":true}');
    expect(completion.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(completion.output).toEqual([{ type: 'web_search_call' }]);
    expect(completion.server_side_tool_usage_details).toEqual({ web_search_calls: 1 });
  });
});
