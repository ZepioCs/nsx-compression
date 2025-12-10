import { CompressionAlgorithm } from "./base";

export class StoreAlgorithm implements CompressionAlgorithm {
  name = "store";
  private compressionLevel: number = 0;

  constructor() {}

  async compress(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(data);
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(data);
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  setCompressionLevel(level: number): void {
    this.compressionLevel = level;
  }
}

