import type { Usage } from '../types.js';

/* Gemini bills thinking tokens as output and the content a tool such as Google
   Search brings in as input, but reports both outside candidatesTokenCount and
   promptTokenCount. Counting them here keeps cost accounting at what Google bills. */
export function geminiUsage(u: any): Usage {
  const prompt = (u?.promptTokenCount || 0) + (u?.toolUsePromptTokenCount || 0);
  const completion = (u?.candidatesTokenCount || 0) + (u?.thoughtsTokenCount || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u?.totalTokenCount || prompt + completion };
}
