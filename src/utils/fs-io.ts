/**
 * Concurrency-limited filesystem helpers for high-volume file operations.
 *
 * Based on probeo-core/common/fs-io. Provides queued reads/writes,
 * atomic durable writes, directory caching, and path memoization.
 */

import { mkdir, open, readFile as fsReadFile, rename, writeFile as fsWriteFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import PQueue from 'p-queue';

// Concurrency-limited queues to prevent resource exhaustion.
let writeQueue = new PQueue({ concurrency: 10 });
let readQueue = new PQueue({ concurrency: 20 });

/**
 * Configure the filesystem IO concurrency limits.
 * Call before any IO operations to adjust defaults.
 */
export function configureFsIO(options: { readConcurrency?: number; writeConcurrency?: number }): void {
  if (options.readConcurrency !== undefined) {
    readQueue.concurrency = options.readConcurrency;
  }
  if (options.writeConcurrency !== undefined) {
    writeQueue.concurrency = options.writeConcurrency;
  }
}

// In-memory cache of directories we've already ensured exist.
const ensuredDirs = new Set<string>();

// Memoization caches for path operations.
const joinPathCache = new Map<string, string>();
const dirnameCache = new Map<string, string>();
const resolvePathCache = new Map<string, string>();

// ─── Directory Operations ───────────────────────────────────────────────────

export async function ensureDir(dir: string): Promise<void> {
  if (!dir) return;
  if (ensuredDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

// ─── Queued Read Operations ─────────────────────────────────────────────────

export async function readFileQueued(
  filePath: string,
  encoding: BufferEncoding | null = 'utf8',
): Promise<string | Buffer> {
  return readQueue.add(async () => {
    return fsReadFile(filePath, encoding as any);
  });
}

export async function readJsonQueued<T = unknown>(filePath: string): Promise<T> {
  const raw = (await readFileQueued(filePath, 'utf8')) as string;
  return JSON.parse(raw) as T;
}

export async function readDirQueued(dirPath: string): Promise<Dirent[]> {
  return readQueue.add(async () => {
    return fsReaddir(dirPath, { withFileTypes: true });
  });
}

export async function statQueued(filePath: string): Promise<Stats> {
  return readQueue.add(async () => {
    return fsStat(filePath);
  });
}

export async function pathExistsQueued(p: string): Promise<boolean> {
  return readQueue.add(async () => {
    try {
      await fsStat(p);
      return true;
    } catch {
      return false;
    }
  });
}

export async function fileExistsQueued(filePath: string): Promise<boolean> {
  return readQueue.add(async () => {
    try {
      const s = await fsStat(filePath);
      return s.isFile();
    } catch {
      return false;
    }
  });
}

// ─── Queued Write Operations ────────────────────────────────────────────────

export async function writeFileQueued(filePath: string, data: string | Buffer): Promise<void> {
  await writeQueue.add(async () => {
    const dir = dirnameOf(filePath);
    await ensureDir(dir);
    await fsWriteFile(filePath, data);
  });
}

export async function appendFileQueued(filePath: string, data: string | Buffer): Promise<void> {
  await writeQueue.add(async () => {
    const dir = dirnameOf(filePath);
    await ensureDir(dir);
    await fsWriteFile(filePath, data, { flag: 'a' } as any);
  });
}

/**
 * Atomically write a file with fsync to ensure data hits disk.
 * Uses temp file + rename + directory fsync.
 */
export async function writeFileFlushedQueued(filePath: string, data: string | Buffer): Promise<void> {
  await writeQueue.add(async () => {
    const dir = dirnameOf(filePath);
    await ensureDir(dir);

    const tmpPath = joinPath(
      dir,
      `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );

    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }

    await rename(tmpPath, filePath);

    try {
      const dh = await open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch {
      // ignore directory fsync errors
    }
  });
}

/**
 * Streamed write with durability: temp file → stream → fsync → atomic rename.
 */
export async function writeStreamFlushedQueued(
  filePath: string,
  producer: (stream: NodeJS.WritableStream) => Promise<void> | void,
): Promise<void> {
  await writeQueue.add(async () => {
    const dir = dirnameOf(filePath);
    await ensureDir(dir);

    const tmpPath = joinPath(
      dir,
      `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );

    const ws = createWriteStream(tmpPath);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: any) => { if (settled) return; settled = true; reject(err); };
      const onFinish = () => { if (settled) return; settled = true; resolve(); };
      ws.once('error', onError);
      ws.once('finish', onFinish);

      Promise.resolve()
        .then(async () => {
          await producer(ws);
          if (!(ws as any).destroyed && !(ws as any).writableEnded) {
            (ws as any).end();
          }
        })
        .catch(onError);
    });

    const fh = await open(tmpPath, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }

    await rename(tmpPath, filePath);

    try {
      const dh = await open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch {
      // ignore directory fsync errors
    }
  });
}

// ─── Path Utilities (Memoized) ──────────────────────────────────────────────

export function joinPath(...segments: string[]): string {
  const key = segments.join('\u0000');
  const cached = joinPathCache.get(key);
  if (cached !== undefined) return cached;
  const out = path.join(...segments);
  joinPathCache.set(key, out);
  return out;
}

export function dirnameOf(p: string): string {
  const cached = dirnameCache.get(p);
  if (cached !== undefined) return cached;
  const out = path.dirname(p);
  dirnameCache.set(p, out);
  return out;
}

export function resolvePath(...segments: string[]): string {
  const key = segments.join('\u0000');
  const cached = resolvePathCache.get(key);
  if (cached !== undefined) return cached;
  const out = path.resolve(...segments);
  resolvePathCache.set(key, out);
  return out;
}

// ─── Queue Status ───────────────────────────────────────────────────────────

export function getFsQueueStatus() {
  return {
    read: { size: readQueue.size, pending: readQueue.pending },
    write: { size: writeQueue.size, pending: writeQueue.pending },
  };
}

export async function waitForFsQueuesIdle(): Promise<void> {
  await Promise.all([writeQueue.onIdle(), readQueue.onIdle()]);
}
