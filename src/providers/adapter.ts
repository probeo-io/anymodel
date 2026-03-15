import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
  BatchRequestItem,
  BatchResultItem,
} from '../types.js';

export interface ProviderAdapter {
  readonly name: string;

  translateRequest(request: ChatCompletionRequest): unknown;
  translateResponse(response: unknown): ChatCompletion;
  translateStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk>;
  translateError(error: unknown): { code: number; message: string; metadata: AnyModelErrorMetadata };
  listModels(): Promise<ModelInfo[]>;
  supportsParameter(param: string): boolean;
  supportsBatch(): boolean;

  sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion>;
  sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>>;
}

export interface NativeBatchStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  failed: number;
}

export interface BatchAdapter {
  createBatch(model: string, requests: BatchRequestItem[], options?: Record<string, unknown>): Promise<{ providerBatchId: string; metadata?: Record<string, unknown> }>;
  pollBatch(providerBatchId: string): Promise<NativeBatchStatus>;
  getBatchResults(providerBatchId: string): Promise<BatchResultItem[]>;
  cancelBatch(providerBatchId: string): Promise<void>;
}
