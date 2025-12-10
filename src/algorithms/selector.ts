import { CompressionAlgorithm } from "./base";
import { LZMAAlgorithm } from "./lzma";
import { BrotliAlgorithm } from "./brotli";
import { ZstdAlgorithm } from "./zstd";
import { BWTAlgorithm } from "./bwt";
import { StoreAlgorithm } from "./store";
import { FileTypeDetector, FileType } from "../analyzer/detector";
import { EntropyAnalyzer } from "../analyzer/entropy";

export class AlgorithmSelector {
  private algorithms: Map<string, CompressionAlgorithm> = new Map();
  private compressionLevel: number = 6;

  constructor(compressionLevel: number = 6) {
    this.compressionLevel = compressionLevel;
    this.initAlgorithms();
  }

  private initAlgorithms(): void {
    this.algorithms.clear();
    this.algorithms.set("store", new StoreAlgorithm());
    this.algorithms.set("gzip", new LZMAAlgorithm(Math.min(9, this.compressionLevel)));
    this.algorithms.set("brotli", new BrotliAlgorithm(Math.min(11, this.compressionLevel)));
    this.algorithms.set("bwt", new BWTAlgorithm(9));
    try {
      this.algorithms.set("zstd", new ZstdAlgorithm(Math.min(22, this.compressionLevel)));
    } catch {
    }
  }

  setCompressionLevel(level: number): void {
    this.compressionLevel = level;
    this.initAlgorithms();
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  async selectBestAlgorithm(
    data: Uint8Array,
    filename?: string
  ): Promise<CompressionAlgorithm> {
    const fileType = FileTypeDetector.detect(data, filename);
    const compressibility = EntropyAnalyzer.getCompressibility(data);

    if (fileType === FileType.TEXT || fileType === FileType.UNKNOWN) {
      return this.algorithms.get("brotli")!;
    }

    if (fileType === FileType.EXECUTABLE || fileType === FileType.BINARY) {
      return this.algorithms.get("gzip")!;
    }

    if (fileType === FileType.IMAGE || fileType === FileType.AUDIO || fileType === FileType.VIDEO) {
      const zstd = this.algorithms.get("zstd");
      if (compressibility > 0.3 && zstd) {
        return zstd;
      }
      return this.algorithms.get("gzip")!;
    }

    if (fileType === FileType.ARCHIVE) {
      return this.algorithms.get("store")!;
    }

    return this.algorithms.get("brotli")!;
  }

  getAlgorithm(name: string): CompressionAlgorithm | undefined {
    return this.algorithms.get(name);
  }

  getAllAlgorithms(): CompressionAlgorithm[] {
    return Array.from(this.algorithms.values());
  }
}

