import type { BatchObject, BatchResultItem } from '../types.js';
import {
  ensureDir,
  readFileQueued,
  readJsonQueued,
  readDirQueued,
  writeFileQueued,
  writeFileFlushedQueued,
  appendFileQueued,
  pathExistsQueued,
  fileExistsQueued,
  joinPath,
  resolvePath,
} from '../utils/fs-io.js';

const DEFAULT_BATCH_DIR = joinPath(process.cwd(), '.anymodel', 'batches');

/**
 * Disk-based batch persistence store.
 * Uses queued, concurrency-limited IO for high-volume operations.
 * Structure: {dir}/{batchId}/meta.json, requests.jsonl, results.jsonl, provider.json
 */
export class BatchStore {
  private dir: string;
  private initialized = false;

  constructor(dir?: string) {
    this.dir = resolvePath(dir || DEFAULT_BATCH_DIR);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(this.dir);
    this.initialized = true;
  }

  private batchDir(id: string): string {
    return joinPath(this.dir, id);
  }

  /**
   * Create a new batch directory and save initial metadata.
   */
  async create(batch: BatchObject): Promise<void> {
    await this.init();
    const dir = this.batchDir(batch.id);
    await ensureDir(dir);
    await writeFileFlushedQueued(joinPath(dir, 'meta.json'), JSON.stringify(batch, null, 2));
  }

  /**
   * Update batch metadata (atomic write).
   */
  async updateMeta(batch: BatchObject): Promise<void> {
    await writeFileFlushedQueued(
      joinPath(this.batchDir(batch.id), 'meta.json'),
      JSON.stringify(batch, null, 2),
    );
  }

  /**
   * Save requests as JSONL.
   */
  async saveRequests(id: string, requests: unknown[]): Promise<void> {
    const lines = requests.map(r => JSON.stringify(r)).join('\n') + '\n';
    await writeFileQueued(joinPath(this.batchDir(id), 'requests.jsonl'), lines);
  }

  /**
   * Append a result to results.jsonl.
   */
  async appendResult(id: string, result: BatchResultItem): Promise<void> {
    await appendFileQueued(
      joinPath(this.batchDir(id), 'results.jsonl'),
      JSON.stringify(result) + '\n',
    );
  }

  /**
   * Save provider-specific state (e.g., provider batch ID).
   */
  async saveProviderState(id: string, state: Record<string, unknown>): Promise<void> {
    await writeFileFlushedQueued(
      joinPath(this.batchDir(id), 'provider.json'),
      JSON.stringify(state, null, 2),
    );
  }

  /**
   * Load provider state.
   */
  async loadProviderState(id: string): Promise<Record<string, unknown> | null> {
    const p = joinPath(this.batchDir(id), 'provider.json');
    if (!(await fileExistsQueued(p))) return null;
    return readJsonQueued<Record<string, unknown>>(p);
  }

  /**
   * Get batch metadata.
   */
  async getMeta(id: string): Promise<BatchObject | null> {
    const p = joinPath(this.batchDir(id), 'meta.json');
    if (!(await fileExistsQueued(p))) return null;
    return readJsonQueued<BatchObject>(p);
  }

  /**
   * Get all results for a batch.
   */
  async getResults(id: string): Promise<BatchResultItem[]> {
    const p = joinPath(this.batchDir(id), 'results.jsonl');
    if (!(await fileExistsQueued(p))) return [];
    const raw = (await readFileQueued(p, 'utf8')) as string;
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  /**
   * List all batch IDs.
   */
  async listBatches(): Promise<string[]> {
    await this.init();
    if (!(await pathExistsQueued(this.dir))) return [];
    const entries = await readDirQueued(this.dir);
    return entries
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  /**
   * Stream requests from JSONL one line at a time (memory-efficient).
   */
  async *streamRequests(id: string): AsyncGenerator<unknown> {
    const p = joinPath(this.batchDir(id), 'requests.jsonl');
    if (!(await fileExistsQueued(p))) return;
    const raw = (await readFileQueued(p, 'utf8')) as string;
    for (const line of raw.split('\n')) {
      if (line.trim()) yield JSON.parse(line);
    }
  }

  /**
   * Check if a batch exists.
   */
  async exists(id: string): Promise<boolean> {
    return fileExistsQueued(joinPath(this.batchDir(id), 'meta.json'));
  }
}
