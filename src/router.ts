import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionWithMeta,
  ChatCompletionChunk,
  AnyModelConfig,
  ProviderPreferences,
} from './types.js';
import { AnyModelError } from './types.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { parseModelString } from './utils/model-parser.js';
import { validateRequest } from './utils/validate.js';
import { withRetry } from './utils/retry.js';
import { RateLimitTracker } from './utils/rate-limiter.js';
import { applyTransform } from './utils/transforms.js';

// Parameters that can be stripped if unsupported by a provider
const STRIPPABLE_PARAMS = [
  'temperature', 'max_tokens', 'top_p', 'top_k',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty',
  'seed', 'stop', 'logprobs', 'top_logprobs', 'response_format',
  'tools', 'tool_choice', 'user',
] as const;

export class Router {
  private rateLimiter = new RateLimitTracker();

  constructor(
    private registry: ProviderRegistry,
    private aliases?: Record<string, string>,
    private config?: AnyModelConfig,
  ) {}

  /**
   * Strip parameters that the target provider doesn't support.
   */
  private stripUnsupported(request: ChatCompletionRequest, adapter: ProviderAdapter): ChatCompletionRequest {
    const cleaned = { ...request };
    for (const param of STRIPPABLE_PARAMS) {
      if ((cleaned as any)[param] !== undefined && !adapter.supportsParameter(param)) {
        delete (cleaned as any)[param];
      }
    }
    return cleaned;
  }

  /**
   * Apply transforms (e.g., middle-out) to the request messages.
   */
  private applyTransforms(request: ChatCompletionRequest): ChatCompletionRequest {
    const transforms = request.transforms || this.config?.defaults?.transforms;
    if (!transforms || transforms.length === 0) return request;

    let messages = [...request.messages];
    // Default context length for transform budget
    const contextLength = 128000;

    for (const transform of transforms) {
      messages = applyTransform(transform, messages, contextLength);
    }

    return { ...request, messages };
  }

  /**
   * Order models based on provider preferences.
   */
  private applyProviderPreferences(
    models: string[],
    prefs?: ProviderPreferences,
  ): string[] {
    if (!prefs) return models;

    let filtered = [...models];

    // Apply 'only' filter — restrict to these providers
    if (prefs.only && prefs.only.length > 0) {
      const onlySet = new Set(prefs.only);
      filtered = filtered.filter(m => {
        const { provider } = parseModelString(m, this.aliases);
        return onlySet.has(provider);
      });
    }

    // Apply 'ignore' filter — exclude these providers
    if (prefs.ignore && prefs.ignore.length > 0) {
      const ignoreSet = new Set(prefs.ignore);
      filtered = filtered.filter(m => {
        const { provider } = parseModelString(m, this.aliases);
        return !ignoreSet.has(provider);
      });
    }

    // Apply 'order' — reorder to prefer specified providers first
    if (prefs.order && prefs.order.length > 0) {
      const orderMap = new Map(prefs.order.map((p, i) => [p, i]));
      filtered.sort((a, b) => {
        const aProvider = parseModelString(a, this.aliases).provider;
        const bProvider = parseModelString(b, this.aliases).provider;
        const aOrder = orderMap.get(aProvider) ?? Infinity;
        const bOrder = orderMap.get(bProvider) ?? Infinity;
        return aOrder - bOrder;
      });
    }

    // Apply 'require_parameters' — skip providers that don't support all used params
    if (prefs.require_parameters) {
      filtered = filtered.filter(m => {
        try {
          const { provider } = parseModelString(m, this.aliases);
          const adapter = this.registry.get(provider);
          // No way to know which params will be used without looking at the request,
          // so this is handled at dispatch time by stripUnsupported
          return adapter !== undefined;
        } catch {
          return false;
        }
      });
    }

    // Skip rate-limited providers
    filtered = filtered.filter(m => {
      const { provider } = parseModelString(m, this.aliases);
      return !this.rateLimiter.isRateLimited(provider);
    });

    return filtered;
  }

  private getRetryOptions(): { maxRetries: number } {
    return {
      maxRetries: this.config?.defaults?.retries ?? 2,
    };
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletion> {
    validateRequest(request);

    // Apply transforms
    const transformed = this.applyTransforms(request);

    // Fallback routing
    if (transformed.models && transformed.models.length > 0 && transformed.route === 'fallback') {
      return this.completeWithFallback(transformed);
    }

    const { provider, model } = parseModelString(transformed.model, this.aliases);
    const adapter = this.registry.get(provider);
    const resolvedRequest = this.stripUnsupported({ ...transformed, model }, adapter);

    return withRetry(
      () => adapter.sendRequest(resolvedRequest),
      this.getRetryOptions(),
    );
  }

  /**
   * Like complete(), but returns response metadata (headers) alongside the completion.
   * Used by the batch manager for adaptive concurrency control.
   */
  async completeWithMeta(request: ChatCompletionRequest): Promise<ChatCompletionWithMeta> {
    validateRequest(request);
    const transformed = this.applyTransforms(request);
    const { provider, model } = parseModelString(transformed.model, this.aliases);
    const adapter = this.registry.get(provider);
    const resolvedRequest = this.stripUnsupported({ ...transformed, model }, adapter);

    if (adapter.sendRequestWithMeta) {
      const result = await withRetry(
        () => adapter.sendRequestWithMeta!(resolvedRequest),
        this.getRetryOptions(),
      );
      this.rateLimiter.updateFromHeaders(provider, result.meta.headers);
      return result;
    }

    // Fallback for adapters without meta support
    const completion = await withRetry(
      () => adapter.sendRequest(resolvedRequest),
      this.getRetryOptions(),
    );
    return { completion, meta: { headers: {} } };
  }

  async stream(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
    validateRequest(request);

    const transformed = this.applyTransforms(request);

    if (transformed.models && transformed.models.length > 0 && transformed.route === 'fallback') {
      return this.streamWithFallback(transformed);
    }

    const { provider, model } = parseModelString(transformed.model, this.aliases);
    const adapter = this.registry.get(provider);
    const resolvedRequest = this.stripUnsupported({ ...transformed, model, stream: true }, adapter);

    return withRetry(
      () => adapter.sendStreamingRequest(resolvedRequest),
      this.getRetryOptions(),
    );
  }

  private async completeWithFallback(request: ChatCompletionRequest): Promise<ChatCompletion> {
    let models = request.models!;
    const errors: Array<{ model: string; error: AnyModelError }> = [];

    // Apply provider preferences to order/filter models
    models = this.applyProviderPreferences(models, request.provider);

    for (const modelStr of models) {
      try {
        const { provider, model } = parseModelString(modelStr, this.aliases);
        const adapter = this.registry.get(provider);
        const resolvedRequest = this.stripUnsupported(
          { ...request, model, models: undefined, route: undefined },
          adapter,
        );

        const response = await withRetry(
          () => adapter.sendRequest(resolvedRequest),
          this.getRetryOptions(),
        );

        response.model = modelStr;
        return response;
      } catch (err) {
        const error = err instanceof AnyModelError
          ? err
          : new AnyModelError(500, String(err));

        // Track rate limits
        if (error.code === 429) {
          const { provider } = parseModelString(modelStr, this.aliases);
          this.rateLimiter.recordRateLimit(provider);
        }

        errors.push({ model: modelStr, error });
      }
    }

    const lastError = errors[errors.length - 1];
    throw new AnyModelError(lastError.error.code, lastError.error.message, {
      ...lastError.error.metadata,
      raw: {
        attempts: errors.map(e => ({
          model: e.model,
          code: e.error.code,
          message: e.error.message,
        })),
      },
    });
  }

  private async streamWithFallback(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>> {
    let models = request.models!;
    const errors: Array<{ model: string; error: AnyModelError }> = [];

    models = this.applyProviderPreferences(models, request.provider);

    for (const modelStr of models) {
      try {
        const { provider, model } = parseModelString(modelStr, this.aliases);
        const adapter = this.registry.get(provider);
        const resolvedRequest = this.stripUnsupported(
          { ...request, model, models: undefined, route: undefined, stream: true },
          adapter,
        );

        return await withRetry(
          () => adapter.sendStreamingRequest(resolvedRequest),
          this.getRetryOptions(),
        );
      } catch (err) {
        const error = err instanceof AnyModelError
          ? err
          : new AnyModelError(500, String(err));

        if (error.code === 429) {
          const { provider } = parseModelString(modelStr, this.aliases);
          this.rateLimiter.recordRateLimit(provider);
        }

        errors.push({ model: modelStr, error });
      }
    }

    const lastError = errors[errors.length - 1];
    throw new AnyModelError(lastError.error.code, lastError.error.message, {
      ...lastError.error.metadata,
      raw: {
        attempts: errors.map(e => ({
          model: e.model,
          code: e.error.code,
          message: e.error.message,
        })),
      },
    });
  }

  getRateLimiter(): RateLimitTracker {
    return this.rateLimiter;
  }
}
