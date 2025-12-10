import { readFileBuffer, getFileSize } from "../utils/io";
import { AlgorithmSelector } from "../algorithms/selector";
import type { CompressionAlgorithm } from "../algorithms/base";
import { Archive } from "../container/archive";
import { stat } from "fs/promises";
import { parallelBatch, getConcurrency } from "../utils/parallel";

export interface BenchmarkResult {
  algorithm: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  compressionTime: number;
  decompressionTime: number;
  memoryUsage?: number;
}

export class BenchmarkRunner {
  private selector: AlgorithmSelector;

  constructor() {
    this.selector = new AlgorithmSelector();
  }

  async benchmarkFile(
    filePath: string,
    algorithm: CompressionAlgorithm
  ): Promise<BenchmarkResult> {
    const data = await readFileBuffer(filePath);
    const originalSize = data.length;

    const compressStart = performance.now();
    const compressed = await algorithm.compress(data);
    const compressEnd = performance.now();
    const compressionTime = compressEnd - compressStart;

    const decompressStart = performance.now();
    const decompressed = await algorithm.decompress(compressed);
    const decompressEnd = performance.now();
    const decompressionTime = decompressEnd - decompressStart;

    if (decompressed.length !== originalSize) {
      throw new Error(
        `Decompression size mismatch: expected ${originalSize}, got ${decompressed.length}`
      );
    }

    for (let i = 0; i < originalSize; i++) {
      if (data[i] !== decompressed[i]) {
        throw new Error(`Data corruption detected at byte ${i}`);
      }
    }

    const compressedSize = compressed.length;
    const compressionRatio = (1 - compressedSize / originalSize) * 100;

    return {
      algorithm: algorithm.name,
      originalSize,
      compressedSize,
      compressionRatio,
      compressionTime,
      decompressionTime,
    };
  }

  async benchmarkWithData(
    data: Uint8Array,
    algorithm: CompressionAlgorithm
  ): Promise<BenchmarkResult> {
    const originalSize = data.length;

    const compressStart = performance.now();
    const compressed = await algorithm.compress(data);
    const compressEnd = performance.now();
    const compressionTime = compressEnd - compressStart;

    const decompressStart = performance.now();
    const decompressed = await algorithm.decompress(compressed);
    const decompressEnd = performance.now();
    const decompressionTime = decompressEnd - decompressStart;

    if (decompressed.length !== originalSize) {
      throw new Error(
        `Decompression size mismatch: expected ${originalSize}, got ${decompressed.length}`
      );
    }

    const compressedSize = compressed.length;
    const compressionRatio = (1 - compressedSize / originalSize) * 100;

    return {
      algorithm: algorithm.name,
      originalSize,
      compressedSize,
      compressionRatio,
      compressionTime,
      decompressionTime,
    };
  }

  async benchmarkAllAlgorithms(
    filePath: string,
    parallel: boolean = false
  ): Promise<BenchmarkResult[]> {
    const algorithms = this.selector.getAllAlgorithms();
    const data = await readFileBuffer(filePath);

    if (parallel) {
      console.log(
        `Running parallel benchmark (${getConcurrency()} workers)...`
      );
      const results = await parallelBatch(
        algorithms,
        async (algorithm) => {
          return this.benchmarkWithData(data, algorithm);
        },
        getConcurrency()
      );

      const successfulResults: BenchmarkResult[] = [];
      for (const result of results) {
        if (result.success && result.result) {
          successfulResults.push(result.result);
        } else if (result.error) {
          console.error(`Error benchmarking: ${result.error.message}`);
        }
      }

      return successfulResults.sort(
        (a, b) => a.compressedSize - b.compressedSize
      );
    }

    const results: BenchmarkResult[] = [];

    for (const algorithm of algorithms) {
      try {
        const result = await this.benchmarkWithData(data, algorithm);
        results.push(result);
      } catch (error) {
        console.error(
          `Error benchmarking ${algorithm.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return results.sort((a, b) => a.compressedSize - b.compressedSize);
  }

  async benchmarkArchive(filePath: string): Promise<BenchmarkResult> {
    const originalSize = await getFileSize(filePath);
    const archive = new Archive();
    await archive.read(filePath);

    const compressStart = performance.now();
    await archive.write(filePath + ".test");
    const compressEnd = performance.now();
    const compressionTime = compressEnd - compressStart;

    const testArchive = new Archive();
    const decompressStart = performance.now();
    await testArchive.read(filePath + ".test");
    const decompressEnd = performance.now();
    const decompressionTime = decompressEnd - decompressStart;

    const stats = await stat(filePath + ".test");
    const compressedSize = stats.size;
    const compressionRatio = (1 - compressedSize / originalSize) * 100;

    return {
      algorithm: "archive",
      originalSize,
      compressedSize,
      compressionRatio,
      compressionTime,
      decompressionTime,
    };
  }
}
