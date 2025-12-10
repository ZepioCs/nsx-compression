import { CompressionAlgorithm } from "./base";
import { constants } from "zlib";

export class BrotliAlgorithm implements CompressionAlgorithm {
  name = "brotli";
  private compressionLevel: number = 11;

  constructor(compressionLevel: number = 11) {
    this.compressionLevel = compressionLevel;
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { brotliCompressSync } = await import("zlib");
      const compressed = brotliCompressSync(Buffer.from(data), {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: this.compressionLevel,
          [constants.BROTLI_PARAM_LGWIN]: 24,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
        },
      });
      return new Uint8Array(compressed);
    } catch (error) {
      throw new Error(`Brotli compression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { brotliDecompressSync } = await import("zlib");
      const decompressed = brotliDecompressSync(Buffer.from(data));
      return new Uint8Array(decompressed);
    } catch (error) {
      throw new Error(`Brotli decompression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  setCompressionLevel(level: number): void {
    if (level < 0 || level > 11) {
      throw new Error("Brotli compression level must be between 0 and 11");
    }
    this.compressionLevel = level;
  }
}

