import { CompressionAlgorithm } from "./base";

export class ZstdAlgorithm implements CompressionAlgorithm {
  name = "zstd";
  private compressionLevel: number = 3;

  constructor(compressionLevel: number = 3) {
    this.compressionLevel = compressionLevel;
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { compress } = await import("zstd-codec");
      const compressed = compress(data, this.compressionLevel);
      return compressed;
    } catch {
      try {
        const zstd = await import("node-zstd");
        const compressed = zstd.compress(Buffer.from(data), this.compressionLevel);
        return new Uint8Array(compressed);
      } catch {
        throw new Error("Zstandard compression not available. Please install 'zstd-codec' or 'node-zstd' package.");
      }
    }
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    try {
      const { decompress } = await import("zstd-codec");
      const decompressed = decompress(data);
      return decompressed;
    } catch {
      try {
        const zstd = await import("node-zstd");
        const decompressed = zstd.decompress(Buffer.from(data));
        return new Uint8Array(decompressed);
      } catch {
        throw new Error("Zstandard decompression not available. Please install 'zstd-codec' or 'node-zstd' package.");
      }
    }
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  setCompressionLevel(level: number): void {
    if (level < 1 || level > 22) {
      throw new Error("Zstandard compression level must be between 1 and 22");
    }
    this.compressionLevel = level;
  }
}

