import type { Message } from '../types.js';

/**
 * Middle-out transform: when messages exceed a token budget,
 * remove messages from the middle of the conversation, preserving
 * the system prompt (first) and most recent messages (last).
 *
 * This is a character-based approximation (4 chars ≈ 1 token).
 */
const CHARS_PER_TOKEN = 4;

export function middleOut(messages: Message[], maxTokens: number): Message[] {
  if (messages.length <= 2) return messages;

  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // Calculate total content length
  function messageLength(msg: Message): number {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    return content.length + 20; // overhead for role, etc.
  }

  const totalChars = messages.reduce((sum, m) => sum + messageLength(m), 0);
  if (totalChars <= maxChars) return messages;

  // Separate system messages from conversation
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  if (conversationMessages.length <= 2) return messages;

  const systemChars = systemMessages.reduce((sum, m) => sum + messageLength(m), 0);
  const budgetForConversation = maxChars - systemChars;

  if (budgetForConversation <= 0) return [...systemMessages, conversationMessages[conversationMessages.length - 1]];

  // Keep messages from both ends, removing from the middle
  const kept: Message[] = [];
  let usedChars = 0;

  // Always keep the last few messages (recency is most important)
  const tail: Message[] = [];
  let tailChars = 0;
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const len = messageLength(conversationMessages[i]);
    if (tailChars + len > budgetForConversation * 0.7) break;
    tail.unshift(conversationMessages[i]);
    tailChars += len;
  }

  // Fill from the head with remaining budget
  const headBudget = budgetForConversation - tailChars;
  const headEnd = conversationMessages.length - tail.length;
  for (let i = 0; i < headEnd; i++) {
    const len = messageLength(conversationMessages[i]);
    if (usedChars + len > headBudget) break;
    kept.push(conversationMessages[i]);
    usedChars += len;
  }

  return [...systemMessages, ...kept, ...tail];
}

/**
 * Apply a named transform to the request messages.
 */
export function applyTransform(
  name: string,
  messages: Message[],
  contextLength: number,
): Message[] {
  if (name === 'middle-out') {
    return middleOut(messages, contextLength);
  }
  return messages;
}
