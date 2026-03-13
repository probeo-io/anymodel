import { AnyModelError } from '../types.js';
import type { ChatCompletionRequest } from '../types.js';

export function validateRequest(request: ChatCompletionRequest): void {
  if (!request.model && !request.models?.length) {
    throw new AnyModelError(400, 'Missing required field: model');
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnyModelError(400, 'Missing or empty required field: messages');
  }

  if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
    throw new AnyModelError(400, 'temperature must be between 0.0 and 2.0');
  }

  if (request.top_p !== undefined && (request.top_p < 0 || request.top_p > 1)) {
    throw new AnyModelError(400, 'top_p must be between 0.0 and 1.0');
  }

  if (request.top_logprobs !== undefined && !request.logprobs) {
    throw new AnyModelError(400, 'top_logprobs requires logprobs: true');
  }

  if (request.top_logprobs !== undefined && (request.top_logprobs < 0 || request.top_logprobs > 20)) {
    throw new AnyModelError(400, 'top_logprobs must be between 0 and 20');
  }

  if (request.stop !== undefined) {
    const stops = Array.isArray(request.stop) ? request.stop : [request.stop];
    if (stops.length > 4) {
      throw new AnyModelError(400, 'stop may have at most 4 sequences');
    }
  }

  if (request.models && request.models.length > 0 && request.route && request.route !== 'fallback') {
    throw new AnyModelError(400, `Invalid route: '${request.route}'. Only 'fallback' is supported.`);
  }
}
