export interface CompressionAlgorithm {
  name: string;
  compress(data: Uint8Array): Promise<Uint8Array>;
  decompress(data: Uint8Array): Promise<Uint8Array>;
  getCompressionLevel(): number;
  setCompressionLevel(level: number): void;
}

export interface AlgorithmStats {
  algorithm: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  compressionTime: number;
  decompressionTime: number;
}

