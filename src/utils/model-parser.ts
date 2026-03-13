import { AnyModelError } from '../types.js';

export interface ParsedModel {
  provider: string;
  model: string;
}

export function parseModelString(model: string, aliases?: Record<string, string>): ParsedModel {
  // Check aliases first
  if (aliases && model in aliases) {
    model = aliases[model];
  }

  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    throw new AnyModelError(
      400,
      `Model must be in provider/model format or be a valid alias. Got: '${model}'`
    );
  }

  const provider = model.substring(0, slashIndex);
  const modelId = model.substring(slashIndex + 1);

  if (!provider) {
    throw new AnyModelError(400, `Invalid model string: missing provider in '${model}'`);
  }
  if (!modelId) {
    throw new AnyModelError(400, `Invalid model string: missing model ID in '${model}'`);
  }

  return { provider, model: modelId };
}
