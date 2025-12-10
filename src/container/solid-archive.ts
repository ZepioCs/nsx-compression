import {
  HeaderSerializer,
  MAGIC_NUMBER,
  VERSION,
  type ArchiveHeader,
} from "./header";
import { type CompressionAlgorithm } from "../algorithms/base";
import { readFileBuffer, writeFileBuffer } from "../utils/io";
import { BufferUtils } from "../utils/buffer";

const SOLID_FLAG = 0x01;

interface SolidFileInfo {
  path: string;
  size: number;
  offset: number;
  timestamp: number;
}

export class SolidArchive {
  private fileInfos: SolidFileInfo[] = [];
  private algorithm: CompressionAlgorithm | null = null;
  private data: Uint8Array | null = null;
  private decompressedData: Uint8Array | null = null;

  async compress(
    files: Array<{ path: string; data: Uint8Array; timestamp?: number }>,
    algorithm: CompressionAlgorithm
  ): Promise<Uint8Array> {
    this.algorithm = algorithm;
    this.fileInfos = [];

    let totalSize = 0;
    for (const file of files) {
      this.fileInfos.push({
        path: file.path,
        size: file.data.length,
        offset: totalSize,
        timestamp: file.timestamp || Date.now(),
      });
      totalSize += file.data.length;
    }

    const combinedData = new Uint8Array(totalSize);
    let offset = 0;
    for (const file of files) {
      combinedData.set(file.data, offset);
      offset += file.data.length;
    }

    const compressedData = await algorithm.compress(combinedData);

    const indexBuffer = this.serializeIndex();
    const header: ArchiveHeader = {
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: this.fileInfos.length,
      indexOffset: BigInt(24 + compressedData.length),
      flags: SOLID_FLAG,
    };

    const headerBuffer = HeaderSerializer.serialize(header);
    const totalArchiveSize =
      headerBuffer.length + compressedData.length + indexBuffer.length + 8;

    const archive = new Uint8Array(totalArchiveSize);
    let archiveOffset = 0;

    archive.set(headerBuffer, archiveOffset);
    archiveOffset += headerBuffer.length;

    archive.set(compressedData, archiveOffset);
    archiveOffset += compressedData.length;

    BufferUtils.writeUint64(archive, archiveOffset, BigInt(totalSize));
    archiveOffset += 8;

    archive.set(indexBuffer, archiveOffset);

    return archive;
  }

  async write(
    filePath: string,
    files: Array<{ path: string; data: Uint8Array; timestamp?: number }>,
    algorithm: CompressionAlgorithm
  ): Promise<void> {
    const archive = await this.compress(files, algorithm);
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

    if (!(header.flags & SOLID_FLAG)) {
      throw new Error("Not a solid archive. Use regular Archive class.");
    }

    const indexStart = Number(header.indexOffset);
    const uncompressedSize = BufferUtils.readUint64(buffer, indexStart);

    const indexDataStart = indexStart + 8;
    this.fileInfos = this.deserializeIndex(
      buffer.slice(indexDataStart),
      header.fileCount
    );

    this.data = buffer.slice(24, indexStart);
  }

  async decompress(algorithm: CompressionAlgorithm): Promise<void> {
    if (!this.data) {
      throw new Error("Archive not loaded");
    }
    this.decompressedData = await algorithm.decompress(this.data);
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

  static isSolidArchive(buffer: Uint8Array): boolean {
    if (buffer.length < 24) return false;
    const header = HeaderSerializer.deserialize(buffer);
    return (header.flags & SOLID_FLAG) !== 0;
  }
}
