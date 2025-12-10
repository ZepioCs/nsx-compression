import { cpus } from "os";

export function getConcurrency(): number {
  return cpus().length;
}

export function getMaxConcurrency(): number {
  return cpus().length;
}

export function getIOConcurrency(): number {
  return Math.min(cpus().length * 4, 128);
}

export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency?: number
): Promise<R[]> {
  const limit = concurrency ?? getConcurrency();
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (currentIndex < items.length) {
        const index = currentIndex++;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await fn(item, index);
        }
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export async function parallelForEach<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  concurrency?: number
): Promise<void> {
  const limit = concurrency ?? getConcurrency();
  let currentIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (currentIndex < items.length) {
        const index = currentIndex++;
        const item = items[index];
        if (item !== undefined) {
          await fn(item, index);
        }
      }
    }
  );

  await Promise.all(workers);
}

export interface BatchResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  index: number;
}

export async function parallelBatch<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency?: number
): Promise<BatchResult<R>[]> {
  const limit = concurrency ?? getConcurrency();
  const results: BatchResult<R>[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (currentIndex < items.length) {
        const index = currentIndex++;
        const item = items[index];
        if (item !== undefined) {
          try {
            const result = await fn(item, index);
            results[index] = { success: true, result, index };
          } catch (error) {
            results[index] = {
              success: false,
              error: error instanceof Error ? error : new Error(String(error)),
              index,
            };
          }
        }
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export class ProgressTracker {
  private processed = 0;
  private readonly total: number;
  private readonly startTime: number;

  constructor(total: number) {
    this.total = total;
    this.startTime = Date.now();
  }

  increment(): number {
    return ++this.processed;
  }

  getProgress(): {
    processed: number;
    total: number;
    percent: number;
    elapsed: number;
  } {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return {
      processed: this.processed,
      total: this.total,
      percent: (this.processed / this.total) * 100,
      elapsed,
    };
  }

  getETA(): number | null {
    if (this.processed === 0) return null;
    const elapsed = Date.now() - this.startTime;
    const avgTimePerItem = elapsed / this.processed;
    const remaining = this.total - this.processed;
    return (avgTimePerItem * remaining) / 1000;
  }
}
