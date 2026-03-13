import { describe, it, expect } from 'vitest';
import { middleOut, applyTransform } from '../src/utils/transforms.js';
import type { Message } from '../src/types.js';

describe('middleOut', () => {
  it('returns messages unchanged when under budget', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const result = middleOut(messages, 100000);
    expect(result).toEqual(messages);
  });

  it('preserves system message and recent messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First message ' + 'x'.repeat(500) },
      { role: 'assistant', content: 'First reply ' + 'x'.repeat(500) },
      { role: 'user', content: 'Middle message ' + 'x'.repeat(500) },
      { role: 'assistant', content: 'Middle reply ' + 'x'.repeat(500) },
      { role: 'user', content: 'Recent message' },
      { role: 'assistant', content: 'Recent reply' },
    ];

    // Very tight budget — should keep system + most recent
    const result = middleOut(messages, 200);
    expect(result[0].role).toBe('system');
    expect(result[result.length - 1].content).toBe('Recent reply');
    expect(result.length).toBeLessThan(messages.length);
  });

  it('handles 2 or fewer messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];
    expect(middleOut(messages, 10)).toEqual(messages);
  });
});

describe('applyTransform', () => {
  it('applies middle-out transform', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];
    const result = applyTransform('middle-out', messages, 100000);
    expect(result).toEqual(messages);
  });

  it('returns unchanged for unknown transform', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];
    const result = applyTransform('unknown', messages, 100000);
    expect(result).toEqual(messages);
  });
});
