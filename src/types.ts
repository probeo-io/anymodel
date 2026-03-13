// ─── Messages ────────────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Response Format ─────────────────────────────────────────────────────────

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

// ─── Chat Completion Request ─────────────────────────────────────────────────

export interface ProviderPreferences {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  sort?: 'price' | 'throughput' | 'latency';
}

export interface ChatCompletionRequest {
  // Required
  model: string;
  messages: Message[];

  // Standard optional
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
  stream?: boolean;
  logprobs?: boolean;
  top_logprobs?: number;
  response_format?: ResponseFormat;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  user?: string;

  // Anymodel-specific (mirrors OpenRouter)
  models?: string[];
  route?: 'fallback';
  transforms?: string[];
  provider?: ProviderPreferences;
}

// ─── Chat Completion Response ────────────────────────────────────────────────

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: Message;
  finish_reason: FinishReason;
  logprobs?: unknown;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export interface ChunkDelta {
  role?: Role;
  content?: string;
  tool_calls?: Partial<ToolCall>[];
}

export interface ChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason: FinishReason | null;
  logprobs?: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: Usage;
}

// ─── Models ──────────────────────────────────────────────────────────────────

export interface ModelPricing {
  prompt: string;
  completion: string;
}

export interface ModelArchitecture {
  modality: string;
  input_modalities: string[];
  output_modalities: string[];
  tokenizer: string;
}

export interface ModelTopProvider {
  context_length: number;
  max_completion_tokens: number;
  is_moderated: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  created: number;
  description: string;
  context_length: number;
  pricing: ModelPricing;
  architecture: ModelArchitecture;
  top_provider: ModelTopProvider;
  supported_parameters: string[];
}

// ─── Generation Stats ────────────────────────────────────────────────────────

export interface GenerationStats {
  id: string;
  model: string;
  provider_name: string;
  total_cost: number;
  tokens_prompt: number;
  tokens_completion: number;
  latency: number;
  generation_time: number;
  created_at: string;
  finish_reason: FinishReason;
  streamed: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface AnyModelErrorMetadata {
  provider_name?: string;
  raw?: unknown;
}

export class AnyModelError extends Error {
  readonly code: number;
  readonly metadata: AnyModelErrorMetadata;

  constructor(code: number, message: string, metadata: AnyModelErrorMetadata = {}) {
    super(message);
    this.name = 'AnyModelError';
    this.code = code;
    this.metadata = metadata;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        metadata: this.metadata,
      },
    };
  }
}

// ─── Batch ───────────────────────────────────────────────────────────────────

export type BatchStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type BatchMode = 'native' | 'concurrent';

export interface BatchRequestItem {
  custom_id: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  response_format?: ResponseFormat;
  tools?: Tool[];
  tool_choice?: ToolChoice;
}

export interface BatchCreateRequest {
  model: string;
  requests: BatchRequestItem[];
  options?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    top_k?: number;
    stop?: string | string[];
    response_format?: ResponseFormat;
    tools?: Tool[];
    tool_choice?: ToolChoice;
  };
  webhook?: string;
}

export interface BatchObject {
  id: string;
  object: 'batch';
  status: BatchStatus;
  model: string;
  provider_name: string;
  batch_mode: BatchMode;
  total: number;
  completed: number;
  failed: number;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface BatchResultItem {
  custom_id: string;
  status: 'success' | 'error';
  response: ChatCompletion | null;
  error: { code: number; message: string } | null;
}

export interface BatchUsageSummary {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_cost: number;
}

export interface BatchResults {
  id: string;
  status: BatchStatus;
  results: BatchResultItem[];
  usage_summary: BatchUsageSummary;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  defaultModel?: string;
}

export interface CustomProviderConfig {
  baseURL: string;
  apiKey?: string;
  models?: string[];
}

export interface AnyModelConfig {
  anthropic?: ProviderConfig;
  openai?: ProviderConfig;
  google?: ProviderConfig;
  custom?: Record<string, CustomProviderConfig>;
  aliases?: Record<string, string>;
  defaults?: {
    temperature?: number;
    max_tokens?: number;
    retries?: number;
    timeout?: number;
    transforms?: string[];
  };
  routing?: {
    fallback_order?: string[];
    allow_fallbacks?: boolean;
  };
  batch?: {
    dir?: string;
    pollInterval?: number;
    concurrencyFallback?: number;
    retentionDays?: number;
  };
}
