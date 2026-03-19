import type { GenerationStats, FinishReason } from '../types.js';
import { calculateCost } from '../generated/pricing.js';

export interface GenerationRecord {
  id: string;
  model: string;
  providerName: string;
  promptTokens: number;
  completionTokens: number;
  startTime: number; // epoch ms
  endTime: number;   // epoch ms
  finishReason: FinishReason;
  streamed: boolean;
}

/**
 * In-memory generation stats store.
 * Tracks recent completions for the generation stats endpoint.
 */
export class GenerationStatsStore {
  private records = new Map<string, GenerationRecord>();
  private maxRecords: number;

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
  }

  record(entry: GenerationRecord): void {
    // Evict oldest if at capacity
    if (this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest) this.records.delete(oldest);
    }
    this.records.set(entry.id, entry);
  }

  get(id: string): GenerationStats | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;

    const latency = rec.endTime - rec.startTime;
    return {
      id: rec.id,
      model: rec.model,
      provider_name: rec.providerName,
      total_cost: calculateCost(rec.model, rec.promptTokens, rec.completionTokens),
      tokens_prompt: rec.promptTokens,
      tokens_completion: rec.completionTokens,
      latency,
      generation_time: latency,
      created_at: new Date(rec.startTime).toISOString(),
      finish_reason: rec.finishReason,
      streamed: rec.streamed,
    };
  }

  list(limit = 50): GenerationStats[] {
    const entries = Array.from(this.records.values())
      .slice(-limit)
      .reverse();

    return entries.map(rec => this.get(rec.id)!);
  }
}
