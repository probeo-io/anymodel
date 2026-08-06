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

  it('uses Responses shape and translates function tools when reasoning is configured', () => {
    const body = adapter.translateRequest(request({
      reasoning: { effort: 'low' },
      tools: [{ type: 'function', function: { name: 'list_pages', description: 'List pages', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'list_pages' } },
    })) as any;

    expect(body.input).toEqual([{ role: 'user', content: 'Research Texas LLC fees.' }]);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toEqual([{ type: 'function', name: 'list_pages', description: 'List pages', parameters: { type: 'object' } }]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'list_pages' });
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

  it('translates Responses function calls into common tool calls', () => {
    const completion = adapter.translateResponse({
      id: 'resp_456', model: 'gpt-5.6-luna', usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ type: 'function_call', call_id: 'call_1', name: 'list_pages', arguments: '{"customer":"c"}' }],
    });
    expect(completion.choices[0].finish_reason).toBe('tool_calls');
    expect(completion.choices[0].message.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'list_pages', arguments: '{"customer":"c"}' } }]);
  });
});
