import {
  HeaderSerializer,
  MAGIC_NUMBER,
  VERSION,
  type ArchiveHeader,
} from "./header";
import { type FileEntry, EntrySerializer } from "./entry";
import type { CompressionAlgorithm } from "../algorithms/base";
import { readFileBuffer, writeFileBuffer } from "../utils/io";
import { BufferUtils } from "../utils/buffer";
import { open } from "fs/promises";

interface PendingFile {
  path: string;
  data: Uint8Array;
  algorithm: CompressionAlgorithm;
  timestamp: number;
}

export class Archive {
  private entries: FileEntry[] = [];
  private data: Uint8Array | null = null;
  private pendingFiles: PendingFile[] = [];
  private tempFilePath: string | null = null;
  private tempFileHandle: any = null;
  private currentOffset: bigint = 0n;

  async addFile(
    path: string,
    data: Uint8Array,
    algorithm: CompressionAlgorithm,
    timestamp: number = Date.now()
  ): Promise<void> {
    this.pendingFiles.push({ path, data, algorithm, timestamp });
  }

  async startStreamingWrite(filePath: string): Promise<void> {
    this.tempFilePath = filePath + ".tmp";
    this.tempFileHandle = await open(this.tempFilePath, "w");
    this.entries = [];
    const headerSize = HeaderSerializer.serialize({
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: 0,
      indexOffset: 0n,
      flags: 0,
    }).length;
    this.currentOffset = BigInt(headerSize);

    const placeholderHeader = new Uint8Array(headerSize);
    await this.tempFileHandle.write(placeholderHeader, 0, headerSize, 0);
  }

  async writeFileStreaming(
    path: string,
    data: Uint8Array,
    algorithm: CompressionAlgorithm,
    timestamp: number = Date.now()
  ): Promise<void> {
    if (!this.tempFileHandle) {
      throw new Error(
        "Streaming write not started. Call startStreamingWrite first."
      );
    }

    if (!algorithm) {
      throw new Error("Algorithm is null or undefined");
    }

    let compressed: Uint8Array;
    try {
      compressed = await algorithm.compress(data);
      if (!compressed) {
        throw new Error("Compression returned null or undefined");
      }
      if (compressed.length === 0 && data.length > 0) {
        throw new Error("Compression returned empty result for non-empty data");
      }
    } catch (error) {
      throw new Error(
        `Compression failed in writeFileStreaming for ${path} using ${
          algorithm.name
        }: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const entry: FileEntry = {
      path,
      size: data.length,
      compressedSize: compressed.length,
      algorithm: algorithm.name,
      offset: this.currentOffset,
      timestamp,
    };
    this.entries.push(entry);

    try {
      await this.tempFileHandle.write(
        compressed,
        0,
        compressed.length,
        Number(this.currentOffset)
      );
      this.currentOffset += BigInt(compressed.length);
    } catch (error) {
      throw new Error(
        `Failed to write compressed data to file at offset ${
          this.currentOffset
        } for ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async finishStreamingWrite(filePath: string): Promise<void> {
    if (!this.tempFileHandle) {
      throw new Error("Streaming write not started.");
    }

    const indexOffset = this.currentOffset;

    const serializeStart = performance.now();
    const indexBuffer = this.serializeIndex();
    const serializeTime = performance.now() - serializeStart;
    if (serializeTime > 100) {
      console.log(
        `    Serializing index took ${(serializeTime / 1000).toFixed(2)}s (${
          this.entries.length
        } entries, ${this.formatBytes(indexBuffer.length)})`
      );
    }

    const header: ArchiveHeader = {
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: this.entries.length,
      indexOffset,
      flags: 0,
    };

    const headerBuffer = HeaderSerializer.serialize(header);

    console.log(
      `  Writing header (${this.formatBytes(
        headerBuffer.length
      )}) and index (${this.formatBytes(indexBuffer.length)})...`
    );
    const writeStart = performance.now();
    await this.tempFileHandle.write(headerBuffer, 0, headerBuffer.length, 0);
    await this.tempFileHandle.write(
      indexBuffer,
      0,
      indexBuffer.length,
      Number(indexOffset)
    );
    await this.tempFileHandle.sync();
    const writeTime = performance.now() - writeStart;
    if (writeTime > 100) {
      console.log(
        `    Write operations took ${(writeTime / 1000).toFixed(2)}s`
      );
    }

    await this.tempFileHandle.close();

    console.log(`  Renaming temporary file to final archive...`);
    const renameStart = performance.now();
    const { rename, unlink } = await import("fs/promises");
    try {
      await rename(this.tempFilePath!, filePath);
    } catch {
      await unlink(filePath).catch(() => {});
      await rename(this.tempFilePath!, filePath);
    }
    const renameTime = performance.now() - renameStart;
    if (renameTime > 100) {
      console.log(`    Rename took ${(renameTime / 1000).toFixed(2)}s`);
    }

    this.tempFileHandle = null;
    this.tempFilePath = null;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  async write(filePath: string): Promise<void> {
    if (this.tempFileHandle) {
      await this.finishStreamingWrite(filePath);
      return;
    }

    const chunks: Uint8Array[] = [];
    let currentOffset = BigInt(
      HeaderSerializer.serialize({
        magic: MAGIC_NUMBER,
        version: VERSION,
        fileCount: 0,
        indexOffset: 0n,
        flags: 0,
      }).length
    );

    this.entries = [];

    for (const pending of this.pendingFiles) {
      const compressed = await pending.algorithm.compress(pending.data);
      const entry: FileEntry = {
        path: pending.path,
        size: pending.data.length,
        compressedSize: compressed.length,
        algorithm: pending.algorithm.name,
        offset: currentOffset,
        timestamp: pending.timestamp,
      };
      this.entries.push(entry);
      chunks.push(compressed);
      currentOffset += BigInt(compressed.length);
    }

    const dataSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const indexOffset = currentOffset;

    const indexBuffer = this.serializeIndex();
    const header: ArchiveHeader = {
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: this.entries.length,
      indexOffset,
      flags: 0,
    };

    const headerBuffer = HeaderSerializer.serialize(header);
    const totalSize = headerBuffer.length + dataSize + indexBuffer.length;

    const archive = new Uint8Array(totalSize);
    let offset = 0;

    archive.set(headerBuffer, offset);
    offset += headerBuffer.length;

    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.length;
    }

    archive.set(indexBuffer, offset);

    await writeFileBuffer(filePath, archive);
    this.pendingFiles = [];
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

    const indexStart = Number(header.indexOffset);
    this.entries = this.deserializeIndex(buffer.slice(indexStart));

    this.data = buffer;
  }

  getEntries(): FileEntry[] {
    return [...this.entries];
  }

  async extractFile(
    entry: FileEntry,
    algorithm: CompressionAlgorithm
  ): Promise<Uint8Array> {
    if (!this.data) {
      throw new Error("Archive not loaded");
    }

    const start = Number(entry.offset);
    const compressed = this.data.slice(start, start + entry.compressedSize);
    return await algorithm.decompress(compressed);
  }

  private serializeIndex(): Uint8Array {
    const entryBuffers = this.entries.map((entry) =>
      EntrySerializer.serialize(entry)
    );
    const totalSize =
      entryBuffers.reduce((sum, buf) => sum + buf.length, 0) + 4;
    const buffer = new Uint8Array(totalSize);
    let offset = BufferUtils.writeUint32(buffer, 0, this.entries.length);

    for (const entryBuffer of entryBuffers) {
      buffer.set(entryBuffer, offset);
      offset += entryBuffer.length;
    }

    return buffer;
  }

  private deserializeIndex(buffer: Uint8Array): FileEntry[] {
    if (buffer.length < 4) {
      throw new Error("Invalid archive: index buffer too small");
    }

    const count = BufferUtils.readUint32(buffer, 0);
    const entries: FileEntry[] = [];
    let offset = count.offset;

    if (count.value < 0 || count.value > 1000000) {
      throw new Error(
        `Invalid archive: file count out of range (${count.value}). This archive may have been created with a buggy version. Please re-compress your files.`
      );
    }

    const corruptedEntries: number[] = [];

    for (let i = 0; i < count.value; i++) {
      try {
        if (offset >= buffer.length) {
          throw new Error(
            `Entry ${i + 1} starts beyond buffer (offset: ${offset}, buffer: ${
              buffer.length
            })`
          );
        }

        const pathLengthCheck = BufferUtils.readUint32(buffer, offset);
        if (pathLengthCheck.value > 100000 || pathLengthCheck.value < 0) {
          throw new Error(
            `Entry ${i + 1} has invalid path length (${
              pathLengthCheck.value
            }). This suggests the archive was created with buggy serialization code. The archive format is corrupted and cannot be read. Please re-compress your files with the fixed version.`
          );
        }

        const result = EntrySerializer.deserialize(buffer, offset);
        entries.push(result.entry);
        offset = result.offset;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        corruptedEntries.push(i + 1);

        if (i === 0) {
          throw new Error(
            `Failed to deserialize first entry: ${errorMsg}\n\nThis archive appears to be corrupted, likely created with a buggy version of the compression tool. The archive format is fundamentally broken and cannot be read. Please re-compress your files.`
          );
        }

        throw new Error(
          `Failed to deserialize entry ${i + 1} of ${
            count.value
          }: ${errorMsg}\n\nThis archive was likely created with buggy serialization code. Entry ${i} was read successfully, but entry ${
            i + 1
          } is misaligned, indicating the archive format is corrupted. Please re-compress your files with the fixed version.`
        );
      }
    }

    if (corruptedEntries.length > 0 && entries.length === 0) {
      throw new Error(
        `All entries in the archive are corrupted. This archive was created with buggy serialization code and cannot be read. Please re-compress your files.`
      );
    }

    return entries;
  }
}
