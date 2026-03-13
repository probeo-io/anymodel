// Client
export { AnyModel } from './client.js';

// Types
export type {
  // Messages
  Message,
  Role,
  ContentPart,

  // Tools
  Tool,
  ToolChoice,
  ToolCall,

  // Request / Response
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChunkChoice,
  ChunkDelta,
  ResponseFormat,
  ProviderPreferences,
  Usage,
  FinishReason,

  // Models
  ModelInfo,
  ModelPricing,
  ModelArchitecture,
  ModelTopProvider,

  // Generation
  GenerationStats,

  // Batch
  BatchCreateRequest,
  BatchRequestItem,
  BatchObject,
  BatchResultItem,
  BatchResults,
  BatchUsageSummary,
  BatchStatus,
  BatchMode,

  // Config
  AnyModelConfig,
  ProviderConfig,
  CustomProviderConfig,

  // Errors
  AnyModelErrorMetadata,
} from './types.js';

export { AnyModelError } from './types.js';

// Config
export { resolveConfig } from './config.js';

// Generation stats
export { GenerationStatsStore } from './utils/generation-stats.js';

// Batch
export { BatchManager, BatchStore } from './batch/index.js';
export type { BatchPollOptions } from './batch/index.js';

// Server
export { createAnyModelServer, startServer } from './server.js';
export type { ServerOptions } from './server.js';

// Provider adapters (for custom adapters)
export type { ProviderAdapter, BatchAdapter, NativeBatchStatus } from './providers/adapter.js';
export { createOpenAIBatchAdapter } from './providers/openai-batch.js';
export { createAnthropicBatchAdapter } from './providers/anthropic-batch.js';
