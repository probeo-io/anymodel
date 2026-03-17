import type {
  AnyModelConfig,
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  ModelInfo,
  GenerationStats,
  BatchCreateRequest,
  BatchObject,
  BatchResults,
} from './types.js';
import { ProviderRegistry } from './providers/registry.js';
import { Router } from './router.js';
import { createOpenAIAdapter } from './providers/openai.js';
import { createAnthropicAdapter } from './providers/anthropic.js';
import { createGoogleAdapter } from './providers/google.js';
import { createPerplexityAdapter } from './providers/perplexity.js';
import { createCustomAdapter } from './providers/custom.js';
import { resolveConfig } from './config.js';
import { GenerationStatsStore } from './utils/generation-stats.js';
import { BatchManager, type BatchPollOptions } from './batch/manager.js';
import { createOpenAIBatchAdapter } from './providers/openai-batch.js';
import { createAnthropicBatchAdapter } from './providers/anthropic-batch.js';
import { createGoogleBatchAdapter } from './providers/google-batch.js';
import { configureFsIO } from './utils/fs-io.js';
import { setDefaultTimeout } from './utils/fetch-with-timeout.js';

export class AnyModel {
  private registry: ProviderRegistry;
  private router: Router;
  private config: AnyModelConfig;
  private modelCache: ModelInfo[] | null = null;
  private statsStore = new GenerationStatsStore();
  private batchManager!: BatchManager;

  public readonly chat: {
    completions: {
      create: (request: ChatCompletionRequest) => Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>;
    };
  };

  public readonly models: {
    list: (opts?: { provider?: string }) => Promise<ModelInfo[]>;
    refresh: () => Promise<ModelInfo[]>;
  };

  public readonly generation: {
    get: (id: string) => GenerationStats | undefined;
    list: (limit?: number) => GenerationStats[];
  };

  public readonly batches: {
    create: (request: BatchCreateRequest) => Promise<BatchObject>;
    createAndPoll: (request: BatchCreateRequest, options?: BatchPollOptions) => Promise<BatchResults>;
    poll: (id: string, options?: BatchPollOptions) => Promise<BatchResults>;
    get: (id: string) => Promise<BatchObject | null>;
    list: () => Promise<BatchObject[]>;
    cancel: (id: string) => Promise<BatchObject>;
    results: (id: string) => Promise<BatchResults>;
  };

  constructor(config: AnyModelConfig = {}) {
    this.config = resolveConfig(config);
    this.registry = new ProviderRegistry();

    // Configure HTTP request timeout (config is in seconds, convert to ms)
    setDefaultTimeout((this.config.defaults?.timeout ?? 120) * 1000);

    // Configure filesystem IO concurrency
    if (this.config.io) {
      configureFsIO(this.config.io);
    }

    this.registerProviders();

    this.router = new Router(this.registry, this.config.aliases, this.config);

    // Namespace: chat.completions
    this.chat = {
      completions: {
        create: async (request: ChatCompletionRequest) => {
          const merged = this.applyDefaults(request);

          if (merged.stream) {
            return this.router.stream(merged);
          }

          const startTime = Date.now();
          const response = await this.router.complete(merged);
          const endTime = Date.now();

          // Record generation stats
          const providerName = response.model.includes('/')
            ? response.model.split('/')[0]
            : 'unknown';

          this.statsStore.record({
            id: response.id,
            model: response.model,
            providerName,
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            startTime,
            endTime,
            finishReason: response.choices[0]?.finish_reason || 'stop',
            streamed: false,
          });

          return response;
        },
      },
    };

    // Namespace: models
    this.models = {
      list: async (opts?: { provider?: string }) => {
        if (!this.modelCache) {
          this.modelCache = await this.fetchModels();
        }
        if (opts?.provider) {
          return this.modelCache.filter(m => m.id.startsWith(`${opts.provider}/`));
        }
        return this.modelCache;
      },
      refresh: async () => {
        this.modelCache = null;
        return this.models.list();
      },
    };

    // Namespace: generation
    this.generation = {
      get: (id: string) => this.statsStore.get(id),
      list: (limit?: number) => this.statsStore.list(limit),
    };

    // Namespace: batches
    this.batchManager = new BatchManager(this.router, {
      dir: this.config.batch?.dir,
      concurrency: this.config.batch?.concurrencyFallback,
      pollInterval: this.config.batch?.pollInterval,
    });

    this.registerBatchAdapters();

    this.batches = {
      create: (request) => this.batchManager.create(request),
      createAndPoll: (request, options) => this.batchManager.createAndPoll(request, options),
      poll: (id, options) => this.batchManager.poll(id, options),
      get: (id) => this.batchManager.get(id),
      list: () => this.batchManager.list(),
      cancel: (id) => this.batchManager.cancel(id),
      results: (id) => this.batchManager.getResults(id),
    };
  }

  private registerProviders(): void {
    const config = this.config;

    // OpenAI — native adapter
    const openaiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.registry.register('openai', createOpenAIAdapter(openaiKey));
    }

    // Anthropic — native adapter
    const anthropicKey = config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.registry.register('anthropic', createAnthropicAdapter(anthropicKey));
    }

    // Google — native adapter
    const googleKey = config.google?.apiKey || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      this.registry.register('google', createGoogleAdapter(googleKey));
    }

    // Perplexity — native adapter
    const perplexityKey = config.perplexity?.apiKey || process.env.PERPLEXITY_API_KEY;
    if (perplexityKey) {
      this.registry.register('perplexity', createPerplexityAdapter(perplexityKey));
    }

    // Built-in OpenAI-compatible providers
    const builtinProviders: Array<{
      name: string;
      baseURL: string;
      configKey: keyof typeof config;
      envVar: string;
    }> = [
      { name: 'mistral', baseURL: 'https://api.mistral.ai/v1', configKey: 'mistral', envVar: 'MISTRAL_API_KEY' },
      { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', configKey: 'groq', envVar: 'GROQ_API_KEY' },
      { name: 'deepseek', baseURL: 'https://api.deepseek.com', configKey: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
      { name: 'xai', baseURL: 'https://api.x.ai/v1', configKey: 'xai', envVar: 'XAI_API_KEY' },
      { name: 'together', baseURL: 'https://api.together.xyz/v1', configKey: 'together', envVar: 'TOGETHER_API_KEY' },
      { name: 'fireworks', baseURL: 'https://api.fireworks.ai/inference/v1', configKey: 'fireworks', envVar: 'FIREWORKS_API_KEY' },
    ];

    for (const { name, baseURL, configKey, envVar } of builtinProviders) {
      const providerConfig = config[configKey] as { apiKey?: string } | undefined;
      const key = providerConfig?.apiKey || process.env[envVar];
      if (key) {
        this.registry.register(name, createCustomAdapter(name, { baseURL, apiKey: key }));
      }
    }

    // Ollama — local, no API key needed
    const ollamaConfig = config.ollama;
    const ollamaURL = ollamaConfig?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    if (ollamaConfig || process.env.OLLAMA_BASE_URL) {
      this.registry.register('ollama', createCustomAdapter('ollama', { baseURL: ollamaURL }));
    }

    // Custom providers
    if (config.custom) {
      for (const [name, customConfig] of Object.entries(config.custom)) {
        this.registry.register(name, createCustomAdapter(name, customConfig));
      }
    }
  }

  private registerBatchAdapters(): void {
    const config = this.config;

    const openaiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.batchManager.registerBatchAdapter('openai', createOpenAIBatchAdapter(openaiKey));
    }

    const anthropicKey = config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.batchManager.registerBatchAdapter('anthropic', createAnthropicBatchAdapter(anthropicKey));
    }

    const googleKey = config.google?.apiKey || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      this.batchManager.registerBatchAdapter('google', createGoogleBatchAdapter(googleKey));
    }
  }

  private applyDefaults(request: ChatCompletionRequest): ChatCompletionRequest {
    const defaults = this.config.defaults;
    if (!defaults) return request;

    return {
      ...request,
      temperature: request.temperature ?? defaults.temperature,
      max_tokens: request.max_tokens ?? defaults.max_tokens,
    };
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const all: ModelInfo[] = [];
    for (const adapter of this.registry.all()) {
      try {
        const models = await adapter.listModels();
        all.push(...models);
      } catch {
        // Skip providers that fail model listing
      }
    }
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }

  getRegistry(): ProviderRegistry {
    return this.registry;
  }
}
