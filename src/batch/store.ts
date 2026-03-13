import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BatchObject, BatchResultItem } from '../types.js';

const DEFAULT_BATCH_DIR = join(homedir(), '.anymodel', 'batches');

/**
 * Disk-based batch persistence store.
 * Structure: {dir}/{batchId}/meta.json, requests.jsonl, results.jsonl, provider.json
 */
export class BatchStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = resolve(dir || DEFAULT_BATCH_DIR);
    mkdirSync(this.dir, { recursive: true });
  }

  private batchDir(id: string): string {
    return join(this.dir, id);
  }

  /**
   * Create a new batch directory and save initial metadata.
   */
  create(batch: BatchObject): void {
    const dir = this.batchDir(batch.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(batch, null, 2));
  }

  /**
   * Update batch metadata.
   */
  updateMeta(batch: BatchObject): void {
    const dir = this.batchDir(batch.id);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(batch, null, 2));
  }

  /**
   * Save requests as JSONL.
   */
  saveRequests(id: string, requests: unknown[]): void {
    const dir = this.batchDir(id);
    const lines = requests.map(r => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(join(dir, 'requests.jsonl'), lines);
  }

  /**
   * Append a result to results.jsonl.
   */
  appendResult(id: string, result: BatchResultItem): void {
    const dir = this.batchDir(id);
    appendFileSync(join(dir, 'results.jsonl'), JSON.stringify(result) + '\n');
  }

  /**
   * Save provider-specific state (e.g., provider batch ID).
   */
  saveProviderState(id: string, state: Record<string, unknown>): void {
    const dir = this.batchDir(id);
    writeFileSync(join(dir, 'provider.json'), JSON.stringify(state, null, 2));
  }

  /**
   * Load provider state.
   */
  loadProviderState(id: string): Record<string, unknown> | null {
    const path = join(this.batchDir(id), 'provider.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  /**
   * Get batch metadata.
   */
  getMeta(id: string): BatchObject | null {
    const path = join(this.batchDir(id), 'meta.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  /**
   * Get all results for a batch.
   */
  getResults(id: string): BatchResultItem[] {
    const path = join(this.batchDir(id), 'results.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  /**
   * List all batch IDs.
   */
  listBatches(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  /**
   * Check if a batch exists.
   */
  exists(id: string): boolean {
    return existsSync(join(this.batchDir(id), 'meta.json'));
  }
}
