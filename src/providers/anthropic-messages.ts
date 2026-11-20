import type { Message } from '../types.js';

type AnthropicBlock = Record<string, unknown>;
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[] | Message['content'];
}

function parseArguments(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function textBlocks(content: Message['content']): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content as unknown as AnthropicBlock[];
}

/**
 * Maps OpenAI-shaped, non-system messages to Anthropic's Messages API shape.
 *
 * - An assistant message with `tool_calls` becomes `tool_use` blocks (after any text), so the
 *   `tool_result` that follows has the call it answers.
 * - Tool results become `tool_result` blocks in a user message. Consecutive tool results are
 *   merged into one user message, which Anthropic requires when one turn made several calls.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool' || m.tool_call_id) {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : '',
      };
      const last = out[out.length - 1];
      const lastBlocks = last?.content;
      if (last && last.role === 'user' && Array.isArray(lastBlocks) && lastBlocks.length > 0
        && lastBlocks.every((b) => (b as AnthropicBlock).type === 'tool_result')) {
        (lastBlocks as AnthropicBlock[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...textBlocks(m.content),
          ...m.tool_calls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          })),
        ],
      });
      continue;
    }
    out.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }
  return out;
}
