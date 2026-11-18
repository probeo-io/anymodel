import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../src/providers/anthropic-messages.js';

describe('toAnthropicMessages', () => {
  it('turns an assistant tool call into a tool_use block before its tool_result', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'read AGENTS.md' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"AGENTS.md"}' } }] },
      { role: 'tool', content: '{"content":"# org"}', tool_call_id: 'toolu_1' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'read AGENTS.md' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'AGENTS.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"content":"# org"}' }] },
    ]);
  });

  it('keeps assistant text ahead of the tool calls', () => {
    const [msg] = toAnthropicMessages([
      { role: 'assistant', content: 'Reading it now.', tool_calls: [{ id: 't', type: 'function', function: { name: 'now', arguments: '' } }] },
    ]);
    expect(msg.content).toEqual([
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool_use', id: 't', name: 'now', input: {} },
    ]);
  });

  it('merges consecutive tool results into one user message', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
      ] },
      { role: 'tool', content: '1', tool_call_id: 'a' },
      { role: 'tool', content: '2', tool_call_id: 'b' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: '1' },
      { type: 'tool_result', tool_use_id: 'b', content: '2' },
    ] });
  });
});
