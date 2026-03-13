import type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  AnyModelErrorMetadata,
  ModelInfo,
} from '../types.js';

export interface ProviderAdapter {
  readonly name: string;

  translateRequest(request: ChatCompletionRequest): unknown;
  translateResponse(response: unknown): ChatCompletion;
  translateStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk>;
  translateError(error: unknown): { code: number; message: string; metadata: AnyModelErrorMetadata };
  listModels(): Promise<ModelInfo[]>;
  supportsParameter(param: string): boolean;

  sendRequest(request: ChatCompletionRequest): Promise<ChatCompletion>;
  sendStreamingRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk>>;
}
