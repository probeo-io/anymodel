import type { CustomProviderConfig } from '../types.js';
import type { ProviderAdapter } from './adapter.js';
import { createOpenAIAdapter } from './openai.js';

/**
 * Create a custom provider adapter that uses an OpenAI-compatible API.
 * This wraps the OpenAI adapter with a custom base URL and provider name.
 */
export function createCustomAdapter(
  name: string,
  config: CustomProviderConfig,
): ProviderAdapter {
  const openaiAdapter = createOpenAIAdapter(config.apiKey || '', config.baseURL);

  return {
    ...openaiAdapter,
    name,

    async listModels() {
      // If static model list is provided in config, use that
      if (config.models && config.models.length > 0) {
        return config.models.map(modelId => ({
          id: `${name}/${modelId}`,
          name: modelId,
          created: 0,
          description: `Custom model via ${name}`,
          context_length: 128000,
          pricing: { prompt: '0', completion: '0' },
          architecture: {
            modality: 'text->text',
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'unknown',
          },
          top_provider: {
            context_length: 128000,
            max_completion_tokens: 16384,
            is_moderated: false,
          },
          supported_parameters: ['temperature', 'max_tokens', 'top_p', 'stop', 'stream', 'tools', 'tool_choice'],
        }));
      }

      // Otherwise try to fetch from the /models endpoint
      try {
        const models = await openaiAdapter.listModels();
        // Re-prefix with custom provider name
        return models.map(m => ({
          ...m,
          id: `${name}/${m.name}`,
        }));
      } catch {
        return [];
      }
    },

    translateResponse(response: unknown) {
      const translated = openaiAdapter.translateResponse(response);
      // Re-prefix the model with our custom provider name
      if (translated.model.startsWith('openai/')) {
        translated.model = `${name}/${translated.model.substring(7)}`;
      }
      return translated;
    },
  };
}
