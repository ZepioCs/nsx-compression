import {
  HeaderSerializer,
  MAGIC_NUMBER,
  VERSION,
  type ArchiveHeader,
} from "./header";
import type { CompressionAlgorithm } from "../algorithms/base";
import { readFileBuffer, writeFileBuffer } from "../utils/io";
import { BufferUtils } from "../utils/buffer";
import { getConcurrency, getIOConcurrency } from "../utils/parallel";
import { stat, mkdir } from "fs/promises";
import { join, dirname } from "path";

const STREAMING_SOLID_FLAG = 0x07;
const DEFAULT_BLOCK_SIZE = 32 * 1024 * 1024;
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const LARGE_FILE_CHUNK_SIZE = 32 * 1024 * 1024;
const CHUNK_MARKER = ".__chunk__.";

interface FileInfo {
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

interface FileToRead {
  path: string;
  fullPath: string;
  timestamp?: number;
}

interface ReadResult {
  path: string;
  data: Uint8Array;
  timestamp: number;
}

export class StreamingArchive {
  private fileInfos: FileInfo[] = [];
  private blockInfos: BlockInfo[] = [];
  private compressedBlocks: Uint8Array[] = [];
  private decompressedData: Uint8Array | null = null;
  private blockSize: number = DEFAULT_BLOCK_SIZE;

  setBlockSize(size: number): void {
    this.blockSize = size;
  }

  private getExtension(path: string): string {
    const parts = path.split(".");
    return parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : "";
  }

  private getCategory(ext: string): number {
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
      mcmeta: 2,
      lang: 2,
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
  }

  private sortFilesByType<T extends { path: string }>(files: T[]): T[] {
    return [...files].sort((a, b) => {
      const extA = this.getExtension(a.path);
      const extB = this.getExtension(b.path);
      const catA = this.getCategory(extA);
      const catB = this.getCategory(extB);
      if (catA !== catB) return catA - catB;
      if (extA !== extB) return extA.localeCompare(extB);
      return a.path.localeCompare(b.path);
    });
  }

  async compressStreaming(
    filesToRead: FileToRead[],
    algorithm: CompressionAlgorithm,
    onProgress?: (
      phase: string,
      current: number,
      total: number,
      extra?: string
    ) => void
  ): Promise<{
    compressedBlocksMap: Map<
      number,
      { compressed: Uint8Array; uncompressedSize: number }
    >;
    nextBlockIndex: number;
    totalUncompressedSize: number;
  }> {
    this.fileInfos = [];
    this.blockInfos = [];
    this.compressedBlocks = [];

    const cpuConcurrency = getConcurrency();
    const ioConcurrency = getIOConcurrency();

    onProgress?.("sorting", 0, 1);
    const sortedFiles = this.sortFilesByType(filesToRead);
    onProgress?.("sorting", 1, 1);

    const totalFiles = sortedFiles.length;
    let totalBytesRead = 0;
    let filesRead = 0;
    let blocksCompressed = 0;

    const pendingData: ReadResult[] = [];
    let currentBlockData: Uint8Array[] = [];
    let currentBlockSize = 0;

    const blocksToCompress: {
      index: number;
      data: Uint8Array;
      uncompressedSize: number;
    }[] = [];
    const compressedBlocksMap = new Map<
      number,
      { compressed: Uint8Array; uncompressedSize: number }
    >();
    let nextBlockIndex = 0;
    let currentBlockOffset = 0;
    let compressionDone = false;

    const timings = {
      readStartTime: 0,
      readEndTime: 0,
      compressStartTime: 0,
      compressEndTime: 0,
      finalizeTime: 0,
      totalBytesRead: 0,
    };

    const compressWorker = async () => {
      while (!compressionDone || blocksToCompress.length > 0) {
        const blockTask = blocksToCompress.shift();
        if (blockTask) {
          const compressed = await algorithm.compress(blockTask.data);
          compressedBlocksMap.set(blockTask.index, {
            compressed,
            uncompressedSize: blockTask.uncompressedSize,
          });
          blocksCompressed++;
          const estimatedTotal = Math.ceil(
            (totalBytesRead * totalFiles) /
              Math.max(filesRead, 1) /
              this.blockSize
          );
          onProgress?.(
            "compressing",
            blocksCompressed,
            Math.max(estimatedTotal, blocksCompressed),
            `${blocksToCompress.length} queued`
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    };

    const compressionWorkers: Promise<void>[] = [];
    for (let i = 0; i < cpuConcurrency; i++) {
      compressionWorkers.push(compressWorker());
    }

    const flushBlock = () => {
      if (currentBlockData.length === 0) return;

      const blockData = new Uint8Array(currentBlockSize);
      let offset = 0;
      for (const chunk of currentBlockData) {
        blockData.set(chunk, offset);
        offset += chunk.length;
      }

      blocksToCompress.push({
        index: nextBlockIndex,
        data: blockData,
        uncompressedSize: currentBlockSize,
      });
      nextBlockIndex++;
      currentBlockOffset = 0;

      currentBlockData = [];
      currentBlockSize = 0;
    };

    const addFileToBlock = (result: ReadResult) => {
      if (
        currentBlockSize + result.data.length > this.blockSize &&
        currentBlockSize > 0
      ) {
        flushBlock();
      }

      const fileOffset = nextBlockIndex * this.blockSize + currentBlockOffset;
      this.fileInfos.push({
        path: result.path,
        size: result.data.length,
        offset: fileOffset,
        timestamp: result.timestamp,
      });

      let dataOffset = 0;
      let remaining = result.data.length;

      while (remaining > 0) {
        const spaceInBlock = this.blockSize - currentBlockSize;
        const toAdd = Math.min(remaining, spaceInBlock);

        currentBlockData.push(
          result.data.subarray(dataOffset, dataOffset + toAdd)
        );
        currentBlockSize += toAdd;
        currentBlockOffset += toAdd;
        dataOffset += toAdd;
        remaining -= toAdd;

        if (currentBlockSize >= this.blockSize) {
          flushBlock();
        }
      }
    };

    const skippedFiles: { path: string; size: number; reason: string }[] = [];
    const largeFiles: { path: string; size: number }[] = [];

    const readFileChunked = async (
      file: FileToRead,
      fileSize: number
    ): Promise<ReadResult[]> => {
      const results: ReadResult[] = [];
      const totalChunks = Math.ceil(fileSize / LARGE_FILE_CHUNK_SIZE);

      largeFiles.push({ path: file.path, size: fileSize });

      const fileHandle = Bun.file(file.fullPath);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * LARGE_FILE_CHUNK_SIZE;
        const end = Math.min(start + LARGE_FILE_CHUNK_SIZE, fileSize);
        const chunkData = await fileHandle.slice(start, end).arrayBuffer();
        const chunk = new Uint8Array(chunkData);

        timings.totalBytesRead += chunk.length;
        results.push({
          path: `${file.path}${CHUNK_MARKER}${i}.${totalChunks}`,
          data: chunk,
          timestamp: file.timestamp || Date.now(),
        });
      }

      return results;
    };

    const readFile = async (file: FileToRead): Promise<ReadResult[] | null> => {
      try {
        const fileStats = await stat(file.fullPath);

        if (fileStats.size > MAX_FILE_SIZE) {
          return await readFileChunked(file, fileStats.size);
        }

        const data = await readFileBuffer(file.fullPath);
        timings.totalBytesRead += data.length;
        return [
          {
            path: file.path,
            data,
            timestamp: file.timestamp || Date.now(),
          },
        ];
      } catch (error) {
        skippedFiles.push({
          path: file.path,
          size: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    onProgress?.("reading", 0, totalFiles);
    timings.readStartTime = Date.now();
    timings.compressStartTime = Date.now();

    let readIndex = 0;
    const activeReads: Promise<{
      index: number;
      results: ReadResult[] | null;
    }>[] = [];
    const completedReads = new Map<number, ReadResult[] | null>();
    let nextToProcess = 0;

    while (nextToProcess < totalFiles) {
      while (activeReads.length < ioConcurrency && readIndex < totalFiles) {
        const file = sortedFiles[readIndex]!;
        const currentIndex = readIndex;
        activeReads.push(
          readFile(file).then((results) => ({ index: currentIndex, results }))
        );
        readIndex++;
      }

      if (activeReads.length === 0) break;

      const completed = await Promise.race(activeReads);
      const completedIndex = activeReads.findIndex((p) =>
        p.then((r) => r.index === completed.index).catch(() => false)
      );

      completedReads.set(completed.index, completed.results);
      if (completed.results) {
        for (const result of completed.results) {
          totalBytesRead += result.data.length;
        }
      }
      filesRead++;

      const newActiveReads: typeof activeReads = [];
      for (const read of activeReads) {
        const resolved = await Promise.race([read, Promise.resolve(null)]);
        if (resolved === null) {
          newActiveReads.push(read);
        } else if (resolved.index !== completed.index) {
          completedReads.set(resolved.index, resolved.results);
          if (resolved.results) {
            for (const result of resolved.results) {
              totalBytesRead += result.data.length;
            }
          }
          filesRead++;
        }
      }
      activeReads.length = 0;
      activeReads.push(...newActiveReads);

      while (completedReads.has(nextToProcess)) {
        const results = completedReads.get(nextToProcess);
        if (results) {
          for (const result of results) {
            addFileToBlock(result);
          }
        }
        completedReads.delete(nextToProcess);
        nextToProcess++;

        if (nextToProcess % 500 === 0 || nextToProcess === totalFiles) {
          onProgress?.(
            "reading",
            nextToProcess,
            totalFiles,
            `${(totalBytesRead / (1024 * 1024)).toFixed(0)} MB`
          );
        }
      }
    }

    for (const read of activeReads) {
      const completed = await read;
      completedReads.set(completed.index, completed.results);
      if (completed.results) {
        for (const result of completed.results) {
          totalBytesRead += result.data.length;
        }
      }
      filesRead++;
    }

    while (completedReads.has(nextToProcess)) {
      const results = completedReads.get(nextToProcess);
      if (results) {
        for (const result of results) {
          addFileToBlock(result);
        }
      }
      completedReads.delete(nextToProcess);
      nextToProcess++;
    }

    flushBlock();
    timings.readEndTime = Date.now();

    const skippedCount = skippedFiles.length;
    const largeCount = largeFiles.length;
    let statusInfo = "";
    if (largeCount > 0) {
      statusInfo += ` (${largeCount} chunked)`;
    }
    if (skippedCount > 0) {
      statusInfo += ` (${skippedCount} skipped)`;
    }
    onProgress?.(
      "reading",
      totalFiles,
      totalFiles,
      `${(totalBytesRead / (1024 * 1024)).toFixed(0)} MB total${statusInfo}`
    );

    if (largeFiles.length > 0) {
      console.log(
        `\n📦 Chunked ${largeFiles.length} large file(s) (64 MB chunks):`
      );
      for (const large of largeFiles.slice(0, 5)) {
        const chunks = Math.ceil(large.size / LARGE_FILE_CHUNK_SIZE);
        console.log(
          `  - ${large.path}: ${(large.size / (1024 * 1024 * 1024)).toFixed(
            2
          )} GB → ${chunks} chunks`
        );
      }
      if (largeFiles.length > 5) {
        console.log(`  ... and ${largeFiles.length - 5} more`);
      }
    }

    if (skippedFiles.length > 0) {
      console.log(`\n⚠ Skipped ${skippedFiles.length} file(s):`);
      for (const skipped of skippedFiles.slice(0, 10)) {
        console.log(`  - ${skipped.path}: ${skipped.reason}`);
      }
      if (skippedFiles.length > 10) {
        console.log(`  ... and ${skippedFiles.length - 10} more`);
      }
    }

    compressionDone = true;
    await Promise.all(compressionWorkers);
    timings.compressEndTime = Date.now();

    const finalizeStart = Date.now();

    this.blockInfos = [];
    let compressedOffset = 0;
    let totalUncompressedSize = 0;

    for (let i = 0; i < nextBlockIndex; i++) {
      const blockData = compressedBlocksMap.get(i)!;

      this.blockInfos.push({
        compressedOffset,
        compressedSize: blockData.compressed.length,
        uncompressedSize: blockData.uncompressedSize,
      });
      compressedOffset += blockData.compressed.length;
      totalUncompressedSize += blockData.uncompressedSize;
    }

    const finalizeEnd = Date.now();

    this.lastTimings = {
      readTime: timings.readEndTime - timings.readStartTime,
      compressTime: timings.compressEndTime - timings.compressStartTime,
      finalizeTime: finalizeEnd - finalizeStart,
      totalBytesRead: timings.totalBytesRead,
    };

    return {
      compressedBlocksMap,
      nextBlockIndex,
      totalUncompressedSize,
    };
  }

  private lastTimings: {
    readTime: number;
    compressTime: number;
    finalizeTime: number;
    totalBytesRead: number;
  } | null = null;

  getTimings() {
    return (
      this.lastTimings || {
        readTime: 0,
        compressTime: 0,
        finalizeTime: 0,
        totalBytesRead: 0,
      }
    );
  }

  async write(
    filePath: string,
    filesToRead: FileToRead[],
    algorithm: CompressionAlgorithm,
    onProgress?: (
      phase: string,
      current: number,
      total: number,
      extra?: string
    ) => void
  ): Promise<void> {
    const result = await this.compressStreaming(
      filesToRead,
      algorithm,
      onProgress
    );

    onProgress?.("writing", 0, result.nextBlockIndex + 2, "preparing header");

    const totalCompressedSize = this.blockInfos.reduce(
      (sum, b) => sum + b.compressedSize,
      0
    );

    const header: ArchiveHeader = {
      magic: MAGIC_NUMBER,
      version: VERSION,
      fileCount: this.fileInfos.length,
      indexOffset: BigInt(24 + totalCompressedSize),
      flags: STREAMING_SOLID_FLAG,
    };

    const headerBuffer = HeaderSerializer.serialize(header);
    const indexBuffer = this.serializeIndex();
    const blockIndexBuffer = this.serializeBlockIndex();

    const file = Bun.file(filePath);
    const writer = file.writer();

    await writer.write(headerBuffer);

    onProgress?.(
      "writing",
      1,
      result.nextBlockIndex + 2,
      "streaming blocks to disk"
    );

    for (let i = 0; i < result.nextBlockIndex; i++) {
      const blockData = result.compressedBlocksMap.get(i)!;
      await writer.write(blockData.compressed);

      result.compressedBlocksMap.delete(i);

      if (i % 10 === 0 || i === result.nextBlockIndex - 1) {
        onProgress?.(
          "writing",
          i + 1,
          result.nextBlockIndex + 2,
          `block ${i + 1}/${result.nextBlockIndex}`
        );
      }
    }

    const metaBuffer = new Uint8Array(12);
    BufferUtils.writeUint64(
      metaBuffer,
      0,
      BigInt(result.totalUncompressedSize)
    );
    BufferUtils.writeUint32(metaBuffer, 8, this.blockSize);
    await writer.write(metaBuffer);

    await writer.write(blockIndexBuffer);
    await writer.write(indexBuffer);

    await writer.end();

    onProgress?.(
      "writing",
      result.nextBlockIndex + 2,
      result.nextBlockIndex + 2,
      "done"
    );
  }

  private archiveFilePath: string | null = null;
  private decompressedBlocksMap: Map<number, Uint8Array> = new Map();

  async read(filePath: string): Promise<void> {
    this.archiveFilePath = filePath;

    const file = Bun.file(filePath);
    const fileSize = file.size;

    const headerBuffer = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    const header = HeaderSerializer.deserialize(headerBuffer);

    if (header.magic !== MAGIC_NUMBER) {
      throw new Error("Invalid archive format");
    }

    if ((header.flags & STREAMING_SOLID_FLAG) !== STREAMING_SOLID_FLAG) {
      throw new Error("Not a streaming archive");
    }

    const indexStart = Number(header.indexOffset);

    const indexAndMetaBuffer = new Uint8Array(
      await file.slice(indexStart, fileSize).arrayBuffer()
    );

    let offset = 8;
    const blockSizeRead = BufferUtils.readUint32(indexAndMetaBuffer, offset);
    this.blockSize = blockSizeRead.value;
    offset = blockSizeRead.offset;

    const blockCount = BufferUtils.readUint32(indexAndMetaBuffer, offset);
    offset = blockCount.offset;

    this.blockInfos = [];
    for (let i = 0; i < blockCount.value; i++) {
      const compressedOffset = BufferUtils.readUint64(
        indexAndMetaBuffer,
        offset
      );
      offset = compressedOffset.offset;
      const compressedSize = BufferUtils.readUint32(indexAndMetaBuffer, offset);
      offset = compressedSize.offset;
      const uncompSize = BufferUtils.readUint32(indexAndMetaBuffer, offset);
      offset = uncompSize.offset;

      this.blockInfos.push({
        compressedOffset: Number(compressedOffset.value),
        compressedSize: compressedSize.value,
        uncompressedSize: uncompSize.value,
      });
    }

    this.fileInfos = this.deserializeIndex(
      indexAndMetaBuffer.slice(offset),
      header.fileCount
    );

    this.compressedBlocks = [];
    this.decompressedBlocksMap.clear();
  }

  async decompressBlock(
    blockIndex: number,
    algorithm: CompressionAlgorithm
  ): Promise<Uint8Array> {
    if (this.decompressedBlocksMap.has(blockIndex)) {
      return this.decompressedBlocksMap.get(blockIndex)!;
    }

    if (!this.archiveFilePath) {
      throw new Error("Archive not loaded");
    }

    const blockInfo = this.blockInfos[blockIndex];
    if (!blockInfo) {
      throw new Error(`Block ${blockIndex} not found`);
    }

    const file = Bun.file(this.archiveFilePath);
    const start = 24 + blockInfo.compressedOffset;
    const end = start + blockInfo.compressedSize;

    const compressedData = new Uint8Array(
      await file.slice(start, end).arrayBuffer()
    );
    const decompressed = await algorithm.decompress(compressedData);

    this.decompressedBlocksMap.set(blockIndex, decompressed);
    return decompressed;
  }

  async decompress(
    algorithm: CompressionAlgorithm,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    if (!this.archiveFilePath) {
      throw new Error("Archive not loaded");
    }

    const concurrency = getConcurrency();
    const numBlocks = this.blockInfos.length;
    let completedBlocks = 0;

    const queue: number[] = Array.from({ length: numBlocks }, (_, i) => i);
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(concurrency, numBlocks); i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const index = queue.shift();
            if (index !== undefined) {
              await this.decompressBlock(index, algorithm);
              completedBlocks++;
              onProgress?.(completedBlocks, numBlocks);
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    const totalSize = this.blockInfos.reduce(
      (sum, b) => sum + b.uncompressedSize,
      0
    );
    this.decompressedData = new Uint8Array(totalSize);
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const block = this.decompressedBlocksMap.get(i)!;
      this.decompressedData.set(block, offset);
      offset += block.length;
    }

    this.decompressedBlocksMap.clear();
  }

  async streamingExtract(
    outputDir: string,
    algorithm: CompressionAlgorithm,
    onProgress?: (
      phase: string,
      current: number,
      total: number,
      extra?: string
    ) => void,
    unsafe?: boolean
  ): Promise<{
    extracted: number;
    failed: number;
    chunkedReassembled: number;
    skippedBlocks: number;
  }> {
    if (!this.archiveFilePath) {
      throw new Error("Archive not loaded");
    }

    const reassembledFiles = this.getReassembledFileInfos();
    const chunkedCount = reassembledFiles.filter(
      (f) => f.chunks.length > 1
    ).length;

    const maxBlockIndex = this.blockInfos.length - 1;
    const allNeededBlocks = new Set<number>();
    const invalidBlocks = new Set<number>();

    for (const fileEntry of reassembledFiles) {
      for (const chunk of fileEntry.chunks) {
        if (chunk.size === 0) continue;
        const startBlock = Math.floor(chunk.offset / this.blockSize);
        const endBlock = Math.floor(
          (chunk.offset + chunk.size - 1) / this.blockSize
        );
        for (let b = startBlock; b <= endBlock; b++) {
          if (b > maxBlockIndex) {
            invalidBlocks.add(b);
          } else {
            allNeededBlocks.add(b);
          }
        }
      }
    }

    if (invalidBlocks.size > 0) {
      const msg = `Warning: ${invalidBlocks.size} block(s) referenced but not in archive (max: ${maxBlockIndex})`;
      if (!unsafe) {
        throw new Error(`${msg}. Use --unsafe to extract available files.`);
      }
      console.error(msg);
    }

    const sortedBlocks = Array.from(allNeededBlocks).sort((a, b) => a - b);
    const numBlocks = sortedBlocks.length;
    const concurrency = getConcurrency();

    onProgress?.("decompressing", 0, numBlocks, "streaming from disk");

    const blockDataMap = new Map<number, Uint8Array>();
    let completedBlocks = 0;

    const blockQueue = [...sortedBlocks];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(concurrency, numBlocks); i++) {
      workers.push(
        (async () => {
          while (blockQueue.length > 0) {
            const blockIndex = blockQueue.shift();
            if (blockIndex !== undefined) {
              const decompressed = await this.decompressBlock(
                blockIndex,
                algorithm
              );
              blockDataMap.set(blockIndex, decompressed);
              completedBlocks++;
              onProgress?.("decompressing", completedBlocks, numBlocks);
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    onProgress?.("extracting", 0, reassembledFiles.length);

    let extracted = 0;
    let failed = 0;

    const extractFile = async (fileEntry: {
      original: string;
      chunks: FileInfo[];
    }) => {
      try {
        const totalSize = fileEntry.chunks.reduce((sum, c) => sum + c.size, 0);
        const fileData = new Uint8Array(totalSize);
        let writeOffset = 0;

        for (const chunk of fileEntry.chunks) {
          if (chunk.size === 0) continue;

          const startBlock = Math.floor(chunk.offset / this.blockSize);
          const endBlock = Math.floor(
            (chunk.offset + chunk.size - 1) / this.blockSize
          );
          let bytesWritten = 0;

          for (let b = startBlock; b <= endBlock; b++) {
            const blockData = blockDataMap.get(b);
            if (!blockData) continue;
            const blockStart = b * this.blockSize;
            const readStart = Math.max(0, chunk.offset - blockStart);
            const readEnd = Math.min(
              blockData.length,
              chunk.offset + chunk.size - blockStart
            );
            if (readEnd > readStart && readStart < blockData.length) {
              const toCopy = readEnd - readStart;
              const destPos = writeOffset + bytesWritten;
              if (destPos + toCopy <= fileData.length) {
                fileData.set(blockData.subarray(readStart, readEnd), destPos);
              }
              bytesWritten += toCopy;
            }
          }
          writeOffset += chunk.size;
        }

        const filePath = join(outputDir, fileEntry.original);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFileBuffer(filePath, fileData);
        extracted++;
      } catch (error) {
        failed++;
        console.error(`Failed to extract ${fileEntry.original}: ${error}`);
      }
    };

    const extractQueue = [...reassembledFiles];
    const extractWorkers: Promise<void>[] = [];
    let extractedCount = 0;

    for (let i = 0; i < Math.min(concurrency, reassembledFiles.length); i++) {
      extractWorkers.push(
        (async () => {
          while (extractQueue.length > 0) {
            const fileEntry = extractQueue.shift();
            if (fileEntry) {
              await extractFile(fileEntry);
              extractedCount++;
              if (
                extractedCount % 50 === 0 ||
                extractedCount === reassembledFiles.length
              ) {
                onProgress?.(
                  "extracting",
                  extractedCount,
                  reassembledFiles.length
                );
              }
            }
          }
        })()
      );
    }

    await Promise.all(extractWorkers);

    this.decompressedBlocksMap.clear();
    blockDataMap.clear();

    return {
      extracted,
      failed,
      chunkedReassembled: chunkedCount,
      skippedBlocks: invalidBlocks.size,
    };
  }

  getFileInfos(): FileInfo[] {
    return [...this.fileInfos];
  }

  getReassembledFileInfos(): { original: string; chunks: FileInfo[] }[] {
    const chunkedFiles = new Map<
      string,
      { chunks: FileInfo[]; totalChunks: number }
    >();
    const regularFiles: { original: string; chunks: FileInfo[] }[] = [];

    for (const info of this.fileInfos) {
      const chunkMatch = info.path.match(
        new RegExp(`(.+)${CHUNK_MARKER.replace(/\./g, "\\.")}(\\d+)\\.(\\d+)$`)
      );

      if (chunkMatch) {
        const originalPath = chunkMatch[1]!;
        const chunkIndex = parseInt(chunkMatch[2]!, 10);
        const totalChunks = parseInt(chunkMatch[3]!, 10);

        if (!chunkedFiles.has(originalPath)) {
          chunkedFiles.set(originalPath, { chunks: [], totalChunks });
        }
        const entry = chunkedFiles.get(originalPath)!;
        entry.chunks[chunkIndex] = info;
      } else {
        regularFiles.push({ original: info.path, chunks: [info] });
      }
    }

    const result = [...regularFiles];
    for (const [originalPath, { chunks }] of chunkedFiles) {
      result.push({ original: originalPath, chunks });
    }

    return result;
  }

  extractFile(fileInfo: FileInfo): Uint8Array {
    if (!this.decompressedData) {
      throw new Error("Archive not decompressed");
    }
    return this.decompressedData.slice(
      fileInfo.offset,
      fileInfo.offset + fileInfo.size
    );
  }

  extractReassembledFile(chunks: FileInfo[]): Uint8Array {
    if (!this.decompressedData) {
      throw new Error("Archive not decompressed");
    }

    if (chunks.length === 1) {
      return this.extractFile(chunks[0]!);
    }

    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      const data = this.extractFile(chunk);
      result.set(data, offset);
      offset += data.length;
    }

    return result;
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
  ): FileInfo[] {
    const count = BufferUtils.readUint32(buffer, 0);
    const infos: FileInfo[] = [];
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

  static isStreamingArchive(buffer: Uint8Array): boolean {
    if (buffer.length < 24) return false;
    const header = HeaderSerializer.deserialize(buffer);
    return (header.flags & STREAMING_SOLID_FLAG) === STREAMING_SOLID_FLAG;
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
