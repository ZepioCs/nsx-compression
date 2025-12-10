import { CompressionAlgorithm } from "./base";

export class LZMAAlgorithm implements CompressionAlgorithm {
  name = "gzip";
  private compressionLevel: number = 6;

  constructor(compressionLevel: number = 6) {
    this.compressionLevel = compressionLevel;
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { gzipSync } = await import("zlib");
      const compressed = gzipSync(Buffer.from(data), {
        level: this.compressionLevel === 9 ? 9 : Math.max(1, Math.min(9, this.compressionLevel)),
      });
      return new Uint8Array(compressed);
    } catch (error) {
      throw new Error(`LZMA compression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { gunzipSync } = await import("zlib");
      const decompressed = gunzipSync(Buffer.from(data));
      return new Uint8Array(decompressed);
    } catch (error) {
      throw new Error(`LZMA decompression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  setCompressionLevel(level: number): void {
    if (level < 0 || level > 9) {
      throw new Error("LZMA compression level must be between 0 and 9");
    }
    this.compressionLevel = level;
  }
}

