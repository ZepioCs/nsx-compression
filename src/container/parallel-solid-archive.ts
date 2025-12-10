import {
  HeaderSerializer,
  MAGIC_NUMBER,
  VERSION,
  type ArchiveHeader,
} from "./header";
import { type CompressionAlgorithm } from "../algorithms/base";
import { readFileBuffer, writeFileBuffer } from "../utils/io";
import { BufferUtils } from "../utils/buffer";
import { getConcurrency } from "../utils/parallel";

const PARALLEL_SOLID_FLAG = 0x03;
const DEFAULT_BLOCK_SIZE = 64 * 1024 * 1024;

interface SolidFileInfo {
  path: string;
  size: number;
  offset: number;
  timestamp: number;
}

interface BlockInfo {
  compressedOffset: number;
  compressedSize: number;
  uncompressedSize: number;
}

export class ParallelSolidArchive {
  private fileInfos: SolidFileInfo[] = [];
  private blockInfos: BlockInfo[] = [];
  private algorithm: CompressionAlgorithm | null = null;
  private compressedBlocks: Uint8Array[] = [];
  private decompressedData: Uint8Array | null = null;
  private blockSize: number = DEFAULT_BLOCK_SIZE;

  setBlockSize(size: number): void {
    this.blockSize = size;
  }

  sortFilesByType(
    files: Array<{ path: string; data: Uint8Array; timestamp?: number }>
  ): Array<{ path: string; data: Uint8Array; timestamp?: number }> {
    const getExtension = (path: string): string => {
      const parts = path.split(".");
      return parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : "";
    };

    const getCategory = (ext: string): number => {
      const categories: Record<string, number> = {
        java: 0,
        class: 0,
        jar: 1,
        json: 2,
        toml: 2,
        cfg: 2,
        properties: 2,
        yml: 2,
        yaml: 2,
        xml: 2,
        txt: 3,
        md: 3,
        log: 3,
        png: 4,
        jpg: 5,
        jpeg: 5,
        gif: 6,
        ogg: 7,
        mp3: 7,
        wav: 7,
        nbt: 8,
        dat: 8,
        mca: 8,
        mcmeta: 2,
        lang: 2,
        js: 9,
        ts: 9,
        html: 10,
        css: 10,
        lua: 11,
        py: 12,
        sh: 13,
        bat: 13,
        dll: 14,
        so: 14,
        exe: 14,
      };
      return categories[ext] ?? 99;
    };

    return [...files].sort((a, b) => {
      const extA = getExtension(a.path);
      const extB = getExtension(b.path);
      const catA = getCategory(extA);
      const catB = getCategory(extB);

      if (catA !== catB) return catA - catB;
      if (extA !== extB) return extA.localeCompare(extB);
      return a.path.localeCompare(b.path);
    });
  }

  async compress(
    files: Array<{ path: string; data: Uint8Array; timestamp?: number }>,
    algorithm: CompressionAlgorithm,
    onProgress?: (phase: string, current: number, total: number) => void
  ): Promise<Uint8Array> {
    this.algorithm = algorithm;
    this.fileInfos = [];
    this.blockInfos = [];
    this.compressedBlocks = [];

    onProgress?.("sorting", 0, 1);
    const sortedFiles = this.sortFilesByType(files);
    onProgress?.("sorting", 1, 1);

    let totalSize = 0;
    for (const file of sortedFiles) {
      this.fileInfos.push({
        path: file.path,
        size: file.data.length,
        offset: totalSize,
        timestamp: file.timestamp || Date.now(),
      });
      totalSize += file.data.length;
    }

    onProgress?.("combining", 0, sortedFiles.length);
    const combinedData = new Uint8Array(totalSize);
    let offset = 0;
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i]!;
      combinedData.set(file.data, offset);
      offset += file.data.length;
      if (i % 100 === 0) {
        onProgress?.("combining", i, sortedFiles.length);
      }
    }
    onProgress?.("combining", sortedFiles.length, sortedFiles.length);

    const numBlocks = Math.ceil(totalSize / this.blockSize);
    const concurrency = getConcurrency();

    onProgress?.("compressing", 0, numBlocks);

    const blocks: Uint8Array[] = [];
    for (let i = 0; i < numBlocks; i++) {
      const start = i * this.blockSize;
      const end = Math.min(start + this.blockSize, totalSize);
      blocks.push(combinedData.slice(start, end));
    }

    const compressedBlocks: Uint8Array[] = new Array(numBlocks);
    let completedBlocks = 0;

    const compressBlock = async (index: number): Promise<void> => {
      const block = blocks[index]!;
      compressedBlocks[index] = await algorithm.compress(block);
      completedBlocks++;
      onProgress?.("compressing", completedBlocks, numBlocks);
    };

    const queue: number[] = Array.from({ length: numBlocks }, (_, i) => i);
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(concurrency, numBlocks); i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const index = queue.shift();
            if (index !== undefined) {
              await compressBlock(index);
            }
          }
        })()
      );
    }

    await Promise.all(workers);
    this.compressedBlocks = compressedBlocks;

    let compressedOffset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const compressedBlock = compressedBlocks[i]!;
      const uncompressedSize = Math.min(
        this.blockSize,
        totalSize - i * this.blockSize
      );
      this.blockInfos.push({
        compressedOffset,
        compressedSize: compressedBlock.length,
        uncompressedSize,
      });
      compressedOffset += compressedBlock.length;
    }

    const indexBuffer = this.serializeIndex();
    const blockIndexBuffer = this.serializeBlockIndex();

    const totalCompressedSize = compressedBlocks.reduce(
      (sum, b) => sum + b.length,
      0
    );

    const header: ArchiveHeader = {
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: this.fileInfos.length,
      indexOffset: BigInt(24 + totalCompressedSize),
      flags: PARALLEL_SOLID_FLAG,
    };

    const headerBuffer = HeaderSerializer.serialize(header);
    const totalArchiveSize =
      headerBuffer.length +
      totalCompressedSize +
      8 +
      4 +
      blockIndexBuffer.length +
      indexBuffer.length;

    const archive = new Uint8Array(totalArchiveSize);
    let archiveOffset = 0;

    archive.set(headerBuffer, archiveOffset);
    archiveOffset += headerBuffer.length;

    for (const block of compressedBlocks) {
      archive.set(block, archiveOffset);
      archiveOffset += block.length;
    }

    BufferUtils.writeUint64(archive, archiveOffset, BigInt(totalSize));
    archiveOffset += 8;

    BufferUtils.writeUint32(archive, archiveOffset, this.blockSize);
    archiveOffset += 4;

    archive.set(blockIndexBuffer, archiveOffset);
    archiveOffset += blockIndexBuffer.length;

    archive.set(indexBuffer, archiveOffset);

    return archive;
  }

  async write(
    filePath: string,
    files: Array<{ path: string; data: Uint8Array; timestamp?: number }>,
    algorithm: CompressionAlgorithm,
    onProgress?: (phase: string, current: number, total: number) => void
  ): Promise<void> {
    const archive = await this.compress(files, algorithm, onProgress);
    await writeFileBuffer(filePath, archive);
  }

  async read(filePath: string): Promise<void> {
    const buffer = await readFileBuffer(filePath);
    const header = HeaderSerializer.deserialize(buffer);

    if (header.magic !== MAGIC_NUMBER) {
      throw new Error("Invalid archive format");
    }

    if (header.version !== VERSION) {
      throw new Error(`Unsupported archive version: ${header.version}`);
    }

    if (!(header.flags & PARALLEL_SOLID_FLAG)) {
      throw new Error(
        "Not a parallel solid archive. Use regular SolidArchive class."
      );
    }

    const indexStart = Number(header.indexOffset);
    const uncompressedSize = BufferUtils.readUint64(buffer, indexStart);

    let offset = indexStart + 8;
    const blockSizeRead = BufferUtils.readUint32(buffer, offset);
    this.blockSize = blockSizeRead.value;
    offset = blockSizeRead.offset;

    const blockCount = BufferUtils.readUint32(buffer, offset);
    offset = blockCount.offset;

    this.blockInfos = [];
    for (let i = 0; i < blockCount.value; i++) {
      const compressedOffset = BufferUtils.readUint64(buffer, offset);
      offset = compressedOffset.offset;
      const compressedSize = BufferUtils.readUint32(buffer, offset);
      offset = compressedSize.offset;
      const uncompSize = BufferUtils.readUint32(buffer, offset);
      offset = uncompSize.offset;

      this.blockInfos.push({
        compressedOffset: Number(compressedOffset.value),
        compressedSize: compressedSize.value,
        uncompressedSize: uncompSize.value,
      });
    }

    this.fileInfos = this.deserializeIndex(
      buffer.slice(offset),
      header.fileCount
    );

    this.compressedBlocks = [];
    for (const blockInfo of this.blockInfos) {
      const start = 24 + blockInfo.compressedOffset;
      const end = start + blockInfo.compressedSize;
      this.compressedBlocks.push(buffer.slice(start, end));
    }
  }

  async decompress(
    algorithm: CompressionAlgorithm,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    if (this.compressedBlocks.length === 0) {
      throw new Error("Archive not loaded");
    }

    const concurrency = getConcurrency();
    const numBlocks = this.compressedBlocks.length;
    const decompressedBlocks: Uint8Array[] = new Array(numBlocks);
    let completedBlocks = 0;

    const decompressBlock = async (index: number): Promise<void> => {
      decompressedBlocks[index] = await algorithm.decompress(
        this.compressedBlocks[index]!
      );
      completedBlocks++;
      onProgress?.(completedBlocks, numBlocks);
    };

    const queue: number[] = Array.from({ length: numBlocks }, (_, i) => i);
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(concurrency, numBlocks); i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const index = queue.shift();
            if (index !== undefined) {
              await decompressBlock(index);
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    const totalSize = decompressedBlocks.reduce((sum, b) => sum + b.length, 0);
    this.decompressedData = new Uint8Array(totalSize);
    let offset = 0;
    for (const block of decompressedBlocks) {
      this.decompressedData.set(block, offset);
      offset += block.length;
    }
  }

  getFileInfos(): SolidFileInfo[] {
    return [...this.fileInfos];
  }

  extractFile(fileInfo: SolidFileInfo): Uint8Array {
    if (!this.decompressedData) {
      throw new Error("Archive not decompressed. Call decompress() first.");
    }
    return this.decompressedData.slice(
      fileInfo.offset,
      fileInfo.offset + fileInfo.size
    );
  }

  private serializeBlockIndex(): Uint8Array {
    const size = 4 + this.blockInfos.length * (8 + 4 + 4);
    const buffer = new Uint8Array(size);
    let offset = BufferUtils.writeUint32(buffer, 0, this.blockInfos.length);

    for (const info of this.blockInfos) {
      offset = BufferUtils.writeUint64(
        buffer,
        offset,
        BigInt(info.compressedOffset)
      );
      offset = BufferUtils.writeUint32(buffer, offset, info.compressedSize);
      offset = BufferUtils.writeUint32(buffer, offset, info.uncompressedSize);
    }

    return buffer;
  }

  private serializeIndex(): Uint8Array {
    const entries: Uint8Array[] = [];

    for (const info of this.fileInfos) {
      const pathBytes = new TextEncoder().encode(info.path);
      const entrySize = 4 + pathBytes.length + 8 + 8 + 4;
      const entry = new Uint8Array(entrySize);
      let offset = 0;

      offset = BufferUtils.writeUint32(entry, offset, pathBytes.length);
      entry.set(pathBytes, offset);
      offset += pathBytes.length;

      offset = BufferUtils.writeUint64(entry, offset, BigInt(info.size));
      offset = BufferUtils.writeUint64(entry, offset, BigInt(info.offset));
      BufferUtils.writeUint32(entry, offset, info.timestamp);

      entries.push(entry);
    }

    const totalSize = entries.reduce((sum, e) => sum + e.length, 0) + 4;
    const buffer = new Uint8Array(totalSize);
    let offset = BufferUtils.writeUint32(buffer, 0, this.fileInfos.length);

    for (const entry of entries) {
      buffer.set(entry, offset);
      offset += entry.length;
    }

    return buffer;
  }

  private deserializeIndex(
    buffer: Uint8Array,
    expectedCount: number
  ): SolidFileInfo[] {
    const count = BufferUtils.readUint32(buffer, 0);
    const infos: SolidFileInfo[] = [];
    let offset = count.offset;

    for (let i = 0; i < count.value; i++) {
      const pathLength = BufferUtils.readUint32(buffer, offset);
      offset = pathLength.offset;

      const pathBytes = buffer.slice(offset, offset + pathLength.value);
      const path = new TextDecoder().decode(pathBytes);
      offset += pathLength.value;

      const size = BufferUtils.readUint64(buffer, offset);
      offset = size.offset;

      const infoOffset = BufferUtils.readUint64(buffer, offset);
      offset = infoOffset.offset;

      const timestamp = BufferUtils.readUint32(buffer, offset);
      offset = timestamp.offset;

      infos.push({
        path,
        size: Number(size.value),
        offset: Number(infoOffset.value),
        timestamp: timestamp.value,
      });
    }

    return infos;
  }

  static isParallelSolidArchive(buffer: Uint8Array): boolean {
    if (buffer.length < 24) return false;
    const header = HeaderSerializer.deserialize(buffer);
    return (header.flags & PARALLEL_SOLID_FLAG) === PARALLEL_SOLID_FLAG;
  }

  getCompressionStats(): {
    blockCount: number;
    blockSize: number;
    totalCompressed: number;
    totalUncompressed: number;
  } {
    return {
      blockCount: this.blockInfos.length,
      blockSize: this.blockSize,
      totalCompressed: this.blockInfos.reduce(
        (sum, b) => sum + b.compressedSize,
        0
      ),
      totalUncompressed: this.blockInfos.reduce(
        (sum, b) => sum + b.uncompressedSize,
        0
      ),
    };
  }
}
