import type { CliOptions } from "./parser";
import type { CompressionAlgorithm } from "../algorithms/base";
import { Archive } from "../container/archive";
import { SolidArchive } from "../container/solid-archive";
import { ParallelSolidArchive } from "../container/parallel-solid-archive";
import { StreamingArchive } from "../container/streaming-archive";
import { AlgorithmSelector } from "../algorithms/selector";
import { readFileBuffer, writeFileBuffer, fileExists } from "../utils/io";
import { readdir, stat } from "fs/promises";
import { join, dirname, basename, relative, resolve } from "path";
import { mkdir } from "fs/promises";
import {
  getConcurrency,
  getIOConcurrency,
  parallelBatch,
  ProgressTracker,
} from "../utils/parallel";

export class Commands {
  private selector: AlgorithmSelector;

  constructor() {
    this.selector = new AlgorithmSelector();
  }

  async compress(options: CliOptions): Promise<void> {
    if (options.input.length === 0) {
      throw new Error("No input files specified");
    }

    const compressionLevel = options.level ?? 6;
    this.selector.setCompressionLevel(compressionLevel);
    console.log(
      `Compression level: ${compressionLevel}${
        compressionLevel >= 10
          ? " (ultra - this will be slow!)"
          : compressionLevel >= 7
          ? " (best)"
          : compressionLevel >= 4
          ? " (balanced)"
          : " (fast)"
      }`
    );

    const firstInput = options.input[0]!;
    let outputPath =
      options.output ||
      (firstInput.endsWith("/") || firstInput.endsWith("\\")
        ? firstInput + "archive"
        : firstInput);

    if (!outputPath.toLowerCase().endsWith(".nsx")) {
      if (outputPath.endsWith("/") || outputPath.endsWith("\\")) {
        outputPath = outputPath + "archive.nsx";
      } else {
        outputPath = outputPath + ".nsx";
      }
    }

    if (options.solid !== false) {
      await this.compressSolid(options, outputPath);
      return;
    }

    const archive = new Archive();

    console.log("Scanning files...");
    const filesToProcess: Array<{
      path: string;
      fullPath: string;
      isDir: boolean;
      basePath?: string;
    }> = [];

    for (const rawInputPath of options.input) {
      const inputPath = this.normalizePath(rawInputPath);

      if (!(await fileExists(inputPath))) {
        console.warn(`Warning: File or directory not found: ${inputPath}`);
        continue;
      }

      const stats = await stat(inputPath);
      if (stats.isDirectory()) {
        const files = await this.getAllFiles(inputPath);
        for (const file of files) {
          const relativePath = relative(inputPath, file);
          filesToProcess.push({
            path: relativePath.replace(/\\/g, "/"),
            fullPath: file,
            isDir: false,
            basePath: inputPath,
          });
        }
      } else {
        filesToProcess.push({
          path: basename(inputPath),
          fullPath: inputPath,
          isDir: false,
        });
      }
    }

    const totalFiles = filesToProcess.length;
    console.log(`Found ${totalFiles} file(s) to compress\n`);

    if (totalFiles === 0) {
      console.log("No files to compress.");
      return;
    }

    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    const COMPRESSION_TIMEOUT = 30000;
    const NO_COMPRESS_EXTENSIONS = [
      "zip",
      "rar",
      "7z",
      "gz",
      "bz2",
      "xz",
      "zst",
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "mp3",
      "mp4",
      "avi",
      "mkv",
      "mov",
      "wmv",
      "flv",
      "webm",
      "pdf",
      "exe",
      "dll",
      "so",
      "dylib",
      "bin",
      "iso",
      "img",
      "vmdk",
      "qcow2",
    ];
    const resolvedOutput = resolve(outputPath);
    const startTime = Date.now();
    const concurrency = getConcurrency();

    console.log(
      `Phase 1: Reading and compressing files (${concurrency} parallel workers)...\n`
    );

    interface CompressedFile {
      path: string;
      displayPath: string;
      data: Uint8Array;
      compressed: Uint8Array;
      algorithm: CompressionAlgorithm;
      useStore: boolean;
      skipped: boolean;
      skipReason?: string;
      error?: string;
    }

    const compressProgress = new ProgressTracker(totalFiles);

    const compressResults = await parallelBatch<
      (typeof filesToProcess)[0],
      CompressedFile
    >(
      filesToProcess,
      async (fileInfo, i) => {
        const displayPath = fileInfo.basePath
          ? relative(fileInfo.basePath, fileInfo.fullPath)
          : fileInfo.path;

        const fileStats = await stat(fileInfo.fullPath);

        if (fileStats.size > MAX_FILE_SIZE) {
          return {
            path: fileInfo.path,
            displayPath,
            data: new Uint8Array(0),
            compressed: new Uint8Array(0),
            algorithm: this.selector.getAlgorithm("store")!,
            useStore: true,
            skipped: true,
            skipReason: `large file (${this.formatBytes(fileStats.size)})`,
          };
        }

        const data = await readFileBuffer(fileInfo.fullPath);
        let algorithm: CompressionAlgorithm | undefined;
        let useStore = false;
        let compressed: Uint8Array = data;

        const fileExt = fileInfo.fullPath.toLowerCase().split(".").pop() || "";
        const shouldSkipCompression = NO_COMPRESS_EXTENSIONS.includes(fileExt);

        if (options.algorithm && options.algorithm !== "auto") {
          algorithm = this.selector.getAlgorithm(options.algorithm);
          if (!algorithm) {
            throw new Error(`Unknown algorithm: ${options.algorithm}`);
          }
          if (options.level !== undefined) {
            algorithm.setCompressionLevel(options.level);
          }
        } else if (shouldSkipCompression) {
          algorithm = this.selector.getAlgorithm("store")!;
          useStore = true;
        } else if (data.length === 0) {
          algorithm = this.selector.getAlgorithm("store")!;
          useStore = true;
        } else {
          if (fileStats.size > 5 * 1024 * 1024) {
            const gzipAlgo = this.selector.getAlgorithm("gzip");
            if (gzipAlgo) {
              algorithm = gzipAlgo;
            } else {
              algorithm = await this.selector.selectBestAlgorithm(
                data,
                fileInfo.fullPath
              );
            }
          } else {
            algorithm = await this.selector.selectBestAlgorithm(
              data,
              fileInfo.fullPath
            );

            const bwtAlgo = this.selector.getAlgorithm("bwt");
            if (algorithm === bwtAlgo && fileStats.size > 1 * 1024 * 1024) {
              const gzipAlgo = this.selector.getAlgorithm("gzip");
              if (gzipAlgo) {
                algorithm = gzipAlgo;
              }
            }
          }
        }

        if (!useStore && data.length > 0) {
          try {
            const compressionPromise = algorithm!.compress(data);
            const timeoutPromise = new Promise<Uint8Array>((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Compression timeout after ${COMPRESSION_TIMEOUT}ms`
                    )
                  ),
                COMPRESSION_TIMEOUT
              );
            });

            compressed = await Promise.race([
              compressionPromise,
              timeoutPromise,
            ]);

            if (!compressed || compressed.length === 0) {
              throw new Error("Compression returned empty result");
            }

            if (compressed.length >= data.length) {
              algorithm = this.selector.getAlgorithm("store")!;
              useStore = true;
              compressed = data;
            }
          } catch (compressionError) {
            algorithm = this.selector.getAlgorithm("store")!;
            useStore = true;
            compressed = data;
          }
        }

        const current = compressProgress.increment();
        if (current % 20 === 0 || current === totalFiles) {
          process.stdout.write(
            `\r[${current}/${totalFiles}] Compressing... (${(
              (current / totalFiles) *
              100
            ).toFixed(0)}%)`
          );
        }

        return {
          path: fileInfo.path,
          displayPath,
          data,
          compressed,
          algorithm: algorithm!,
          useStore,
          skipped: false,
        };
      },
      concurrency
    );

    console.log(`\n\nPhase 2: Writing archive...\n`);

    await archive.startStreamingWrite(resolvedOutput);

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < compressResults.length; i++) {
      const result = compressResults[i]!;
      processed++;

      if (!result.success) {
        console.log(
          `[${processed}/${totalFiles}] ✗ Error: ${result.error?.message}`
        );
        skipped++;
        continue;
      }

      const file = result.result!;

      if (file.skipped) {
        console.log(
          `[${processed}/${totalFiles}] ⚠ Skipping: ${file.displayPath} (${file.skipReason})`
        );
        skipped++;
        continue;
      }

      try {
        await archive.writeFileStreaming(file.path, file.data, file.algorithm);

        if (file.useStore) {
          if (options.verbose) {
            console.log(
              `[${processed}/${totalFiles}] ⊙ Stored: ${
                file.displayPath
              } (${this.formatBytes(file.data.length)})`
            );
          }
        } else {
          const ratio = (
            (1 - file.compressed.length / file.data.length) *
            100
          ).toFixed(1);
          if (options.verbose) {
            console.log(
              `[${processed}/${totalFiles}] ✓ Compressed: ${
                file.displayPath
              } (${this.formatBytes(file.data.length)} → ${this.formatBytes(
                file.compressed.length
              )}, ${ratio}%) [${file.algorithm.name}]`
            );
          }
        }

        if (
          !options.verbose &&
          (processed % 50 === 0 || processed === totalFiles)
        ) {
          process.stdout.write(
            `\r[${processed}/${totalFiles}] Writing archive... (${(
              (processed / totalFiles) *
              100
            ).toFixed(0)}%)`
          );
        }
      } catch (error) {
        console.log(
          `\n[${processed}/${totalFiles}] ✗ Error writing: ${
            file.displayPath
          } - ${error instanceof Error ? error.message : String(error)}`
        );
        skipped++;
      }
    }

    console.log(`\n`);

    console.log(`\nFinalizing archive...`);
    const entryCount = archive.getEntries().length;
    console.log(`  Serializing index (${entryCount} entries)...`);
    const finalizeStart = Date.now();
    try {
      await archive.finishStreamingWrite(resolvedOutput);
      const finalizeTime = ((Date.now() - finalizeStart) / 1000).toFixed(2);
      console.log(`  ✓ Archive finalized in ${finalizeTime}s`);
    } catch (error) {
      console.error(
        `  ✗ Error finalizing archive: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
    const stats = await stat(resolvedOutput);
    const totalInputSize = await this.getTotalSize(options.input);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n✓ Compression complete!`);
    console.log(`  Output: ${resolvedOutput}`);
    console.log(`  Files processed: ${processed - skipped}/${totalFiles}`);
    if (skipped > 0) {
      console.log(`  Files skipped: ${skipped} (large files or errors)`);
    }
    console.log(`  Original size: ${this.formatBytes(totalInputSize)}`);
    console.log(`  Compressed size: ${this.formatBytes(stats.size)}`);
    console.log(
      `  Compression ratio: ${((1 - stats.size / totalInputSize) * 100).toFixed(
        2
      )}%`
    );
    console.log(`  Time taken: ${totalTime}s`);
  }

  private normalizePath(inputPath: string): string {
    let normalized = inputPath
      .replace(/^["']|["']$/g, "")
      .replace(/[\\/]+$/, "")
      .trim();
    return resolve(normalized);
  }

  private async compressSolid(
    options: CliOptions,
    outputPath: string
  ): Promise<void> {
    console.log("Scanning files...");
    const filesToProcess: Array<{
      path: string;
      fullPath: string;
      basePath?: string;
    }> = [];

    for (const rawInputPath of options.input) {
      const inputPath = this.normalizePath(rawInputPath);

      if (!(await fileExists(inputPath))) {
        console.warn(`Warning: File or directory not found: ${inputPath}`);
        continue;
      }

      const stats = await stat(inputPath);
      if (stats.isDirectory()) {
        const files = await this.getAllFiles(inputPath);
        for (const file of files) {
          const relativePath = relative(inputPath, file);
          filesToProcess.push({
            path: relativePath.replace(/\\/g, "/"),
            fullPath: file,
            basePath: inputPath,
          });
        }
      } else {
        filesToProcess.push({
          path: basename(inputPath),
          fullPath: inputPath,
        });
      }
    }

    const totalFiles = filesToProcess.length;
    const cpuCores = getConcurrency();
    const ioConcurrency = getIOConcurrency();

    console.log(`Found ${totalFiles} file(s) to compress`);
    console.log(`CPU cores: ${cpuCores} | I/O workers: ${ioConcurrency}`);
    console.log(`Mode: STREAMING PIPELINE (read + compress in parallel)\n`);

    if (totalFiles === 0) {
      console.log("No files to compress.");
      return;
    }

    const startTime = Date.now();
    const resolvedOutput = resolve(outputPath);

    let algorithm: CompressionAlgorithm;
    if (options.algorithm && options.algorithm !== "auto") {
      algorithm = this.selector.getAlgorithm(options.algorithm)!;
      if (!algorithm) {
        throw new Error(`Unknown algorithm: ${options.algorithm}`);
      }
      if (options.level !== undefined) {
        algorithm.setCompressionLevel(options.level);
      }
    } else {
      algorithm = this.selector.getAlgorithm("brotli")!;
    }

    console.log(
      `Algorithm: ${algorithm.name} (level ${algorithm.getCompressionLevel()})`
    );
    console.log(`Block size: 32 MB (more parallelism)\n`);

    const streamingArchive = new StreamingArchive();
    streamingArchive.setBlockSize(32 * 1024 * 1024);

    const compressStart = Date.now();
    let lastPhase = "";

    const filesToRead = filesToProcess.map((f) => ({
      path: f.path,
      fullPath: f.fullPath,
    }));

    try {
      await streamingArchive.write(
        resolvedOutput,
        filesToRead,
        algorithm,
        (phase, current, total, extra) => {
          if (phase !== lastPhase) {
            if (lastPhase) {
              process.stdout.write("\x1b[K\n");
            }
            lastPhase = phase;
          }

          const percent = Math.round((current / total) * 100);
          const elapsed = ((Date.now() - compressStart) / 1000).toFixed(0);

          process.stdout.write("\r\x1b[K");

          if (phase === "sorting") {
            process.stdout.write(`Sorting files by type...`);
          } else if (phase === "reading") {
            process.stdout.write(
              `[${current}/${total}] Reading + compressing... (${percent}%) ${
                extra || ""
              } - ${elapsed}s`
            );
          } else if (phase === "compressing") {
            process.stdout.write(
              `Compressing blocks: ${current}/${total} (${percent}%) ${
                extra || ""
              } - ${elapsed}s`
            );
          } else if (phase === "writing") {
            process.stdout.write(
              `Writing to disk: ${current}/${total} (${percent}%) ${
                extra || ""
              } - ${elapsed}s`
            );
          }
        }
      );
      process.stdout.write("\n\n");
    } catch (error) {
      throw new Error(
        `Compression failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const archiveStats = await stat(resolvedOutput);
    const compressionStats = streamingArchive.getCompressionStats();
    const timings = streamingArchive.getTimings();

    const ratio = (
      (1 - archiveStats.size / compressionStats.totalUncompressed) *
      100
    ).toFixed(2);

    console.log(`✓ Streaming compression complete!`);
    console.log(`  Output: ${resolvedOutput}`);
    console.log(`  Files processed: ${totalFiles}`);
    console.log(
      `  Original size: ${this.formatBytes(compressionStats.totalUncompressed)}`
    );
    console.log(`  Compressed size: ${this.formatBytes(archiveStats.size)}`);
    console.log(`  Compression ratio: ${ratio}%`);
    console.log(
      `  Blocks: ${compressionStats.blockCount} × ${this.formatBytes(
        compressionStats.blockSize
      )}`
    );
    console.log(`  Total time: ${totalTime}s`);
    console.log(`  Algorithm: ${algorithm.name} (streaming pipeline)`);
    console.log(`  Workers: ${cpuCores} CPU + ${ioConcurrency} I/O`);

    console.log(`\n  ⏱ Timing breakdown:`);
    console.log(
      `    Read I/O:    ${(timings.readTime / 1000).toFixed(
        2
      )}s (${this.formatBytes(timings.totalBytesRead)} read)`
    );
    console.log(
      `    Compression: ${(timings.compressTime / 1000).toFixed(2)}s`
    );
    console.log(
      `    Finalize:    ${(timings.finalizeTime / 1000).toFixed(2)}s`
    );
  }

  private async getAllFiles(
    dirPath: string,
    excludePatterns: string[] = [".git", "node_modules", ".DS_Store"]
  ): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const shouldExclude = excludePatterns.some(
        (pattern) =>
          entry.name === pattern || fullPath.includes(join(pattern, ""))
      );

      if (shouldExclude) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await this.getAllFiles(fullPath, excludePatterns);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  async decompress(options: CliOptions): Promise<void> {
    if (options.input.length === 0) {
      throw new Error("No archive file specified");
    }

    const archivePath = this.normalizePath(options.input[0]!);

    if (!(await fileExists(archivePath))) {
      throw new Error(`Archive not found: ${archivePath}`);
    }

    const archiveStats = await stat(archivePath);
    if (archiveStats.isDirectory()) {
      throw new Error(
        `Input must be an archive file (.nsx), not a directory: ${archivePath}\nDid you mean to compress instead? Use: compress ${archivePath} -o ${archivePath}.nsx`
      );
    }

    if (!archiveStats.isFile()) {
      throw new Error(`Input is not a regular file: ${archivePath}`);
    }

    if (!archivePath.toLowerCase().endsWith(".nsx")) {
      console.warn(
        `Warning: Input file does not have .nsx extension: ${archivePath}`
      );
    }

    console.log(
      `Reading archive: ${archivePath} (${this.formatBytes(
        archiveStats.size
      )})...`
    );

    const archiveBuffer = await readFileBuffer(archivePath);
    console.log(`Archive loaded into memory`);

    const isStreaming = StreamingArchive.isStreamingArchive(archiveBuffer);
    const isParallelSolid =
      !isStreaming &&
      ParallelSolidArchive.isParallelSolidArchive(archiveBuffer);
    const isSolid =
      !isStreaming &&
      !isParallelSolid &&
      SolidArchive.isSolidArchive(archiveBuffer);

    if (isStreaming) {
      console.log(`Archive type: STREAMING (pipeline compression)`);
    } else if (isParallelSolid) {
      console.log(`Archive type: PARALLEL SOLID (block-based)`);
    } else if (isSolid) {
      console.log(`Archive type: SOLID (single stream)`);
    } else {
      console.log(`Archive type: Standard (per-file)`);
    }

    const outputDir = options.output
      ? resolve(options.output)
      : resolve("./extracted");

    try {
      await mkdir(outputDir, { recursive: true });
    } catch (error) {
      throw new Error(
        `Failed to create output directory ${outputDir}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (isStreaming) {
      await this.decompressStreaming(archivePath, outputDir, options);
      return;
    }

    if (isParallelSolid) {
      await this.decompressParallelSolid(archivePath, outputDir, options);
      return;
    }

    if (isSolid) {
      await this.decompressSolid(archivePath, outputDir, options);
      return;
    }

    console.log(`Parsing archive index...`);
    const archive = new Archive();
    try {
      await archive.read(archivePath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (
        errorMsg.includes("path length") ||
        errorMsg.includes("misaligned") ||
        errorMsg.includes("buggy")
      ) {
        throw new Error(
          `\n✗ Archive is corrupted: ${errorMsg}\n\nThis archive was created with a buggy version that had serialization errors.\nThe archive format is fundamentally broken and cannot be read.\n\nSolution: Re-compress your original files to create a new archive with the fixed format.`
        );
      }
      throw new Error(`Failed to read archive file: ${errorMsg}`);
    }

    const entries = archive.getEntries();
    if (entries.length === 0) {
      throw new Error("Archive contains no files");
    }

    const concurrency = getConcurrency();
    console.log(`Found ${entries.length} file(s)`);
    console.log(
      `Extracting to ${outputDir} (${concurrency} parallel extractors)...\n`
    );

    const extractStartTime = Date.now();
    const extractProgress = new ProgressTracker(entries.length);

    const extractResults = await parallelBatch(
      entries,
      async (entry, i) => {
        if (!entry.path || entry.path.length === 0) {
          throw new Error("Entry has empty or missing path");
        }
        if (!entry.algorithm || entry.algorithm.length === 0) {
          throw new Error("Entry has empty or missing algorithm");
        }
        if (entry.size < 0 || entry.compressedSize < 0) {
          throw new Error(
            `Entry has invalid size values (size: ${entry.size}, compressed: ${entry.compressedSize})`
          );
        }

        const algorithm = this.selector.getAlgorithm(entry.algorithm);
        if (!algorithm) {
          throw new Error(`Unknown algorithm: ${entry.algorithm || "(empty)"}`);
        }

        const data = await archive.extractFile(entry, algorithm);

        if (data.length !== entry.size) {
          throw new Error(
            `Decompressed size mismatch: expected ${entry.size} bytes, got ${data.length} bytes`
          );
        }

        const filePath = join(outputDir, entry.path);
        const outputDirPath = dirname(filePath);

        await mkdir(outputDirPath, { recursive: true });
        await writeFileBuffer(filePath, data);

        const current = extractProgress.increment();

        if (options.verbose) {
          console.log(
            `[${current}/${entries.length}] ✓ Extracted: ${
              entry.path
            } (${this.formatBytes(data.length)}) [${entry.algorithm}]`
          );
        } else if (current % 20 === 0 || current === entries.length) {
          process.stdout.write(
            `\r[${current}/${entries.length}] Extracting files... (${(
              (current / entries.length) *
              100
            ).toFixed(0)}%)`
          );
        }

        return data.length;
      },
      concurrency
    );

    let extracted = 0;
    let failed = 0;
    for (let i = 0; i < extractResults.length; i++) {
      const result = extractResults[i]!;
      if (result.success) {
        extracted++;
      } else {
        failed++;
        const entry = entries[i]!;
        console.error(
          `\n✗ Failed to extract ${entry.path}: ${result.error?.message}`
        );
        if (options.verbose && result.error?.stack) {
          console.error(`  Stack: ${result.error.stack}`);
        }
      }
    }

    console.log(`\n`);
    const extractTime = ((Date.now() - extractStartTime) / 1000).toFixed(2);
    console.log(`✓ Extraction complete!`);
    console.log(`  Extracted: ${extracted}/${entries.length} files`);
    if (failed > 0) {
      console.log(`  Failed: ${failed} files`);
    }
    console.log(`  Output directory: ${outputDir}`);
    console.log(`  Time taken: ${extractTime}s`);
  }

  private async decompressSolid(
    archivePath: string,
    outputDir: string,
    options: CliOptions
  ): Promise<void> {
    console.log(`Archive type: SOLID (single compressed stream)`);

    const solidArchive = new SolidArchive();
    await solidArchive.read(archivePath);

    const fileInfos = solidArchive.getFileInfos();
    console.log(`Found ${fileInfos.length} file(s) in solid archive\n`);

    let algorithm: CompressionAlgorithm;
    if (options.algorithm && options.algorithm !== "auto") {
      algorithm = this.selector.getAlgorithm(options.algorithm)!;
      if (!algorithm) {
        throw new Error(`Unknown algorithm: ${options.algorithm}`);
      }
    } else {
      algorithm = this.selector.getAlgorithm("brotli")!;
    }

    console.log(`Decompressing solid block with ${algorithm.name}...`);
    const decompressStart = Date.now();
    await solidArchive.decompress(algorithm);
    const decompressTime = ((Date.now() - decompressStart) / 1000).toFixed(2);
    console.log(`Decompression took ${decompressTime}s\n`);

    const concurrency = getConcurrency();
    console.log(
      `Extracting ${fileInfos.length} file(s) to ${outputDir} (${concurrency} parallel writers)...\n`
    );

    const extractStart = Date.now();
    const extractProgress = new ProgressTracker(fileInfos.length);

    const extractResults = await parallelBatch(
      fileInfos,
      async (fileInfo, i) => {
        const data = solidArchive.extractFile(fileInfo);

        const filePath = join(outputDir, fileInfo.path);
        const outputDirPath = dirname(filePath);

        await mkdir(outputDirPath, { recursive: true });
        await writeFileBuffer(filePath, data);

        const current = extractProgress.increment();

        if (options.verbose) {
          console.log(
            `[${current}/${fileInfos.length}] ✓ Extracted: ${
              fileInfo.path
            } (${this.formatBytes(data.length)})`
          );
        } else if (current % 20 === 0 || current === fileInfos.length) {
          process.stdout.write(
            `\r[${current}/${fileInfos.length}] Extracting files... (${(
              (current / fileInfos.length) *
              100
            ).toFixed(0)}%)`
          );
        }

        return data.length;
      },
      concurrency
    );

    let extracted = 0;
    let failed = 0;
    for (let i = 0; i < extractResults.length; i++) {
      const result = extractResults[i]!;
      if (result.success) {
        extracted++;
      } else {
        failed++;
        const fileInfo = fileInfos[i]!;
        console.error(
          `\n✗ Failed to extract ${fileInfo.path}: ${result.error?.message}`
        );
      }
    }

    console.log(`\n`);
    const extractTime = ((Date.now() - extractStart) / 1000).toFixed(2);
    console.log(`✓ Extraction complete!`);
    console.log(`  Extracted: ${extracted}/${fileInfos.length} files`);
    if (failed > 0) {
      console.log(`  Failed: ${failed} files`);
    }
    console.log(`  Output directory: ${outputDir}`);
    console.log(`  Time taken: ${extractTime}s`);
  }

  private async decompressParallelSolid(
    archivePath: string,
    outputDir: string,
    options: CliOptions
  ): Promise<void> {
    console.log(`Archive type: PARALLEL SOLID (block-based compression)`);

    const parallelArchive = new ParallelSolidArchive();
    await parallelArchive.read(archivePath);

    const fileInfos = parallelArchive.getFileInfos();
    const compressionStats = parallelArchive.getCompressionStats();
    console.log(
      `Found ${fileInfos.length} file(s) in ${compressionStats.blockCount} blocks\n`
    );

    let algorithm: CompressionAlgorithm;
    if (options.algorithm && options.algorithm !== "auto") {
      algorithm = this.selector.getAlgorithm(options.algorithm)!;
      if (!algorithm) {
        throw new Error(`Unknown algorithm: ${options.algorithm}`);
      }
    } else {
      algorithm = this.selector.getAlgorithm("brotli")!;
    }

    const concurrency = getConcurrency();
    console.log(
      `Decompressing ${compressionStats.blockCount} blocks with ${algorithm.name} (${concurrency} parallel workers)...`
    );

    const decompressStart = Date.now();
    await parallelArchive.decompress(algorithm, (current, total) => {
      process.stdout.write(
        `\rDecompressing blocks: ${current}/${total} (${Math.round(
          (current / total) * 100
        )}%)`
      );
    });
    process.stdout.write("\n");

    const decompressTime = ((Date.now() - decompressStart) / 1000).toFixed(2);
    console.log(`Decompression took ${decompressTime}s\n`);

    console.log(
      `Extracting ${fileInfos.length} file(s) to ${outputDir} (${concurrency} parallel writers)...\n`
    );

    const extractStart = Date.now();
    const extractProgress = new ProgressTracker(fileInfos.length);

    const extractResults = await parallelBatch(
      fileInfos,
      async (fileInfo, i) => {
        const data = parallelArchive.extractFile(fileInfo);

        const filePath = join(outputDir, fileInfo.path);
        const outputDirPath = dirname(filePath);

        await mkdir(outputDirPath, { recursive: true });
        await writeFileBuffer(filePath, data);

        const current = extractProgress.increment();

        if (options.verbose) {
          console.log(
            `[${current}/${fileInfos.length}] ✓ Extracted: ${
              fileInfo.path
            } (${this.formatBytes(data.length)})`
          );
        } else if (current % 20 === 0 || current === fileInfos.length) {
          process.stdout.write(
            `\r[${current}/${fileInfos.length}] Extracting files... (${(
              (current / fileInfos.length) *
              100
            ).toFixed(0)}%)`
          );
        }

        return data.length;
      },
      concurrency
    );

    let extracted = 0;
    let failed = 0;
    for (let i = 0; i < extractResults.length; i++) {
      const result = extractResults[i]!;
      if (result.success) {
        extracted++;
      } else {
        failed++;
        const fileInfo = fileInfos[i]!;
        console.error(
          `\n✗ Failed to extract ${fileInfo.path}: ${result.error?.message}`
        );
      }
    }

    console.log(`\n`);
    const extractTime = ((Date.now() - extractStart) / 1000).toFixed(2);
    console.log(`✓ Extraction complete!`);
    console.log(`  Extracted: ${extracted}/${fileInfos.length} files`);
    if (failed > 0) {
      console.log(`  Failed: ${failed} files`);
    }
    console.log(`  Output directory: ${outputDir}`);
    console.log(`  Time taken: ${extractTime}s`);
  }

  private async decompressStreaming(
    archivePath: string,
    outputDir: string,
    options: CliOptions
  ): Promise<void> {
    const streamingArchive = new StreamingArchive();
    await streamingArchive.read(archivePath);

    const rawFileInfos = streamingArchive.getFileInfos();
    const reassembledFiles = streamingArchive.getReassembledFileInfos();
    const compressionStats = streamingArchive.getCompressionStats();
    const cpuCores = getConcurrency();

    const chunkedCount = reassembledFiles.filter(
      (f) => f.chunks.length > 1
    ).length;
    const regularCount = reassembledFiles.length - chunkedCount;

    console.log(
      `Found ${rawFileInfos.length} entries in ${compressionStats.blockCount} blocks`
    );
    if (chunkedCount > 0) {
      console.log(
        `  → ${regularCount} regular files + ${chunkedCount} chunked large files`
      );
    }
    console.log();

    let algorithm: CompressionAlgorithm;
    if (options.algorithm && options.algorithm !== "auto") {
      algorithm = this.selector.getAlgorithm(options.algorithm)!;
      if (!algorithm) {
        throw new Error(`Unknown algorithm: ${options.algorithm}`);
      }
    } else {
      algorithm = this.selector.getAlgorithm("brotli")!;
    }

    console.log(`Mode: STREAMING EXTRACTION (memory efficient)`);
    console.log(`Using ${algorithm.name} with ${cpuCores} parallel workers\n`);

    const startTime = Date.now();
    let lastPhase = "";

    const result = await streamingArchive.streamingExtract(
      outputDir,
      algorithm,
      (phase, current, total, extra) => {
        if (phase !== lastPhase) {
          if (lastPhase) process.stdout.write("\x1b[K\n");
          lastPhase = phase;
        }

        const percent = Math.round((current / total) * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

        process.stdout.write("\r\x1b[K");

        if (phase === "decompressing") {
          process.stdout.write(
            `Decompressing blocks: ${current}/${total} (${percent}%) - ${elapsed}s`
          );
        } else if (phase === "extracting") {
          process.stdout.write(
            `Extracting files: ${current}/${total} (${percent}%) - ${elapsed}s`
          );
        }
      },
      options.unsafe
    );

    process.stdout.write("\x1b[K\n\n");

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ Extraction complete!`);
    console.log(
      `  Extracted: ${result.extracted}/${reassembledFiles.length} files`
    );
    if (result.chunkedReassembled > 0) {
      console.log(`  Large files reassembled: ${result.chunkedReassembled}`);
    }
    if (result.failed > 0) {
      console.log(`  Failed: ${result.failed} files`);
    }
    if (result.skippedBlocks > 0) {
      console.log(
        `  Skipped blocks: ${result.skippedBlocks} (missing from archive)`
      );
    }
    console.log(`  Output directory: ${outputDir}`);
    console.log(`  Time taken: ${totalTime}s`);
  }

  async list(options: CliOptions): Promise<void> {
    if (options.input.length === 0) {
      throw new Error("No archive file specified");
    }

    const archivePath = this.normalizePath(options.input[0]!);
    if (!(await fileExists(archivePath))) {
      throw new Error(`Archive not found: ${archivePath}`);
    }

    const archiveBuffer = await readFileBuffer(archivePath);
    const isStreaming = StreamingArchive.isStreamingArchive(archiveBuffer);
    const isParallelSolid =
      !isStreaming &&
      ParallelSolidArchive.isParallelSolidArchive(archiveBuffer);
    const isSolid =
      !isStreaming &&
      !isParallelSolid &&
      SolidArchive.isSolidArchive(archiveBuffer);
    const stats = await stat(archivePath);

    console.log(`Archive: ${archivePath}`);
    console.log(`Total size: ${this.formatBytes(stats.size)}`);

    if (isStreaming) {
      console.log(`Type: STREAMING (pipeline compression)\n`);

      const streamingArchive = new StreamingArchive();
      await streamingArchive.read(archivePath);
      const fileInfos = streamingArchive.getFileInfos();
      const compressionStats = streamingArchive.getCompressionStats();

      console.log(`Files: ${fileInfos.length}`);
      console.log(
        `Blocks: ${compressionStats.blockCount} × ${this.formatBytes(
          compressionStats.blockSize
        )}\n`
      );

      let totalOriginal = 0;
      for (const info of fileInfos) {
        totalOriginal += info.size;
        const date = new Date(info.timestamp).toLocaleString();
        console.log(
          `${info.path.padEnd(50)} ${this.formatBytes(info.size).padStart(
            10
          )} ${date}`
        );
      }

      console.log(`\nTotal uncompressed: ${this.formatBytes(totalOriginal)}`);
      console.log(`Archive size: ${this.formatBytes(stats.size)}`);
      console.log(
        `Compression ratio: ${((1 - stats.size / totalOriginal) * 100).toFixed(
          2
        )}%`
      );
      return;
    }

    if (isParallelSolid) {
      console.log(`Type: PARALLEL SOLID (block-based compression)\n`);
    } else if (isSolid) {
      console.log(`Type: SOLID (single compressed stream)\n`);
    } else {
      console.log(`Type: Standard (per-file compression)\n`);
    }

    if (isParallelSolid) {
      const parallelArchive = new ParallelSolidArchive();
      await parallelArchive.read(archivePath);
      const fileInfos = parallelArchive.getFileInfos();
      const compressionStats = parallelArchive.getCompressionStats();

      console.log(`Files: ${fileInfos.length}`);
      console.log(
        `Blocks: ${compressionStats.blockCount} × ${this.formatBytes(
          compressionStats.blockSize
        )}\n`
      );

      let totalOriginal = 0;
      for (const info of fileInfos) {
        totalOriginal += info.size;
        const date = new Date(info.timestamp).toLocaleString();
        console.log(
          `${info.path.padEnd(50)} ${this.formatBytes(info.size).padStart(
            10
          )} ${date}`
        );
      }

      console.log(`\nTotal uncompressed: ${this.formatBytes(totalOriginal)}`);
      console.log(`Archive size: ${this.formatBytes(stats.size)}`);
      console.log(
        `Compression ratio: ${((1 - stats.size / totalOriginal) * 100).toFixed(
          2
        )}%`
      );
      return;
    }

    if (isSolid) {
      const solidArchive = new SolidArchive();
      await solidArchive.read(archivePath);
      const fileInfos = solidArchive.getFileInfos();

      console.log(`Files: ${fileInfos.length}\n`);

      let totalOriginal = 0;
      for (const info of fileInfos) {
        totalOriginal += info.size;
        const date = new Date(info.timestamp).toLocaleString();
        console.log(
          `${info.path.padEnd(50)} ${this.formatBytes(info.size).padStart(
            10
          )} ${date}`
        );
      }

      console.log(`\nTotal uncompressed: ${this.formatBytes(totalOriginal)}`);
      console.log(`Archive size: ${this.formatBytes(stats.size)}`);
      console.log(
        `Compression ratio: ${((1 - stats.size / totalOriginal) * 100).toFixed(
          2
        )}%`
      );
      return;
    }

    const archive = new Archive();
    try {
      await archive.read(archivePath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (
        errorMsg.includes("ASCII text") ||
        errorMsg.includes("buggy serialization") ||
        errorMsg.includes("corrupted") ||
        errorMsg.includes("misaligned")
      ) {
        throw new Error(
          `\n✗ Archive is corrupted: ${errorMsg}\n\nThis archive was created with a buggy version that had serialization errors.\nThe archive format is fundamentally broken and cannot be read.\n\nSolution: Re-compress your original files to create a new archive with the fixed format.`
        );
      }
      throw new Error(`Failed to read archive: ${errorMsg}`);
    }

    const entries = archive.getEntries();

    console.log(`Files: ${entries.length}\n`);

    let totalOriginal = 0;
    let totalCompressed = 0;
    let validEntries = 0;
    let corruptedEntries = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) {
        corruptedEntries++;
        console.error(
          `[${i + 1}/${
            entries.length
          }] ✗ Corrupted entry: Entry is null or undefined`
        );
        continue;
      }

      try {
        if (!entry.path || entry.path.length === 0) {
          throw new Error("Empty or missing path");
        }
        if (!entry.algorithm || entry.algorithm.length === 0) {
          throw new Error("Empty or missing algorithm");
        }
        if (entry.size < 0 || entry.compressedSize < 0) {
          throw new Error("Invalid size values");
        }
        if (entry.size === 0) {
          totalOriginal += 0;
          totalCompressed += 0;
        } else {
          totalOriginal += entry.size;
          totalCompressed += entry.compressedSize;
        }
        const ratio =
          entry.size > 0
            ? ((1 - entry.compressedSize / entry.size) * 100).toFixed(2)
            : "0.00";
        const date = new Date(entry.timestamp).toLocaleString();
        console.log(
          `${entry.path.padEnd(50)} ${this.formatBytes(entry.size).padStart(
            10
          )} -> ${this.formatBytes(entry.compressedSize).padStart(
            10
          )} (${ratio}%) [${entry.algorithm}] ${date}`
        );
        validEntries++;
      } catch (error) {
        corruptedEntries++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[${i + 1}/${entries.length}] ✗ Corrupted entry: ${errorMsg}`
        );
        if (options.verbose) {
          console.error(`  Path: ${entry.path || "(unknown)"}`);
          console.error(`  Algorithm: ${entry.algorithm || "(unknown)"}`);
          console.error(
            `  Size: ${entry.size}, Compressed: ${entry.compressedSize}`
          );
        }
      }
    }

    if (corruptedEntries > 0) {
      console.log(
        `\n⚠ Warning: ${corruptedEntries} corrupted entry/entries found`
      );
    }

    if (validEntries > 0 && totalOriginal > 0) {
      console.log(
        `\nTotal: ${this.formatBytes(totalOriginal)} -> ${this.formatBytes(
          totalCompressed
        )} (${((1 - totalCompressed / totalOriginal) * 100).toFixed(2)}%)`
      );
    } else if (validEntries === 0) {
      console.log(
        `\n✗ No valid entries found in archive. Archive may be corrupted.`
      );
    }
  }

  async benchmark(options: CliOptions): Promise<void> {
    if (options.input.length === 0) {
      console.log("No input files specified. Using src/ folder for benchmark.");
      options.input = ["src"];
    }

    console.log("═".repeat(70));
    console.log("  NSX COMPRESSION BENCHMARK");
    console.log("═".repeat(70));

    const filesToProcess: { path: string; fullPath: string }[] = [];
    let totalOriginalSize = 0;

    for (const rawInputPath of options.input) {
      const inputPath = this.normalizePath(rawInputPath);

      if (!(await fileExists(inputPath))) {
        console.warn(`Warning: File or directory not found: ${inputPath}`);
        continue;
      }

      const stats = await stat(inputPath);
      if (stats.isDirectory()) {
        const files = await this.getAllFiles(inputPath);
        for (const file of files) {
          const fileStats = await stat(file);
          totalOriginalSize += fileStats.size;
          const relativePath = relative(inputPath, file);
          filesToProcess.push({
            path: relativePath.replace(/\\/g, "/"),
            fullPath: file,
          });
        }
      } else {
        totalOriginalSize += stats.size;
        filesToProcess.push({
          path: basename(inputPath),
          fullPath: inputPath,
        });
      }
    }

    if (filesToProcess.length === 0) {
      console.log("No files to benchmark.");
      return;
    }

    console.log(`\nInput: ${options.input.join(", ")}`);
    console.log(`Files: ${filesToProcess.length}`);
    console.log(`Total size: ${this.formatBytes(totalOriginalSize)}\n`);

    const results: {
      name: string;
      size: number;
      ratio: number;
      compressTime: number;
      decompressTime: number;
      error?: string;
    }[] = [];

    const tempDir = join(process.cwd(), ".benchmark_temp");
    await mkdir(tempDir, { recursive: true });

    console.log("Testing NSX algorithms...\n");

    const algorithms = ["brotli", "gzip", "store"];
    const levels = [1, 6, 9, 11];

    for (const algo of algorithms) {
      for (const level of levels) {
        if (algo === "store" && level !== 1) continue;
        if (algo === "gzip" && level > 9) continue;

        const testName = algo === "store" ? "store" : `${algo}-${level}`;
        const outputPath = join(tempDir, `test_${testName}.nsx`);
        const extractPath = join(tempDir, `extract_${testName}`);

        process.stdout.write(`  Testing ${testName.padEnd(12)}...`);

        try {
          const streamingArchive = new StreamingArchive();
          const algorithm = this.selector.getAlgorithm(algo)!;
          algorithm.setCompressionLevel(level);

          const compressStart = Date.now();
          await streamingArchive.write(
            outputPath,
            filesToProcess.map((f) => ({
              path: f.path,
              fullPath: f.fullPath,
            })),
            algorithm,
            () => {}
          );
          const compressTime = Date.now() - compressStart;

          const archiveStats = await stat(outputPath);
          const compressedSize = archiveStats.size;

          const decompressStart = Date.now();
          const readArchive = new StreamingArchive();
          await readArchive.read(outputPath);
          await readArchive.streamingExtract(
            extractPath,
            algorithm,
            () => {},
            true
          );
          const decompressTime = Date.now() - decompressStart;

          const ratio = (1 - compressedSize / totalOriginalSize) * 100;

          results.push({
            name: `NSX (${testName})`,
            size: compressedSize,
            ratio,
            compressTime,
            decompressTime,
          });

          console.log(
            ` ${this.formatBytes(compressedSize).padStart(10)} (${ratio.toFixed(
              1
            )}%) ${(compressTime / 1000).toFixed(2)}s`
          );
        } catch (error) {
          results.push({
            name: `NSX (${testName})`,
            size: 0,
            ratio: 0,
            compressTime: 0,
            decompressTime: 0,
            error: error instanceof Error ? error.message : String(error),
          });
          console.log(` FAILED`);
        }
      }
    }

    console.log("\nTesting external formats...\n");

    const zipPath = join(tempDir, "test.zip");
    process.stdout.write(`  Testing ZIP...`.padEnd(30));
    try {
      const zipStart = Date.now();
      const inputForZip = options.input
        .map((p) => `"${this.normalizePath(p)}"`)
        .join(",");

      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          const { exec } = require("child_process");
          exec(
            `powershell -Command "Compress-Archive -Path ${inputForZip} -DestinationPath '${zipPath}' -Force"`,
            (error: Error | null) => {
              if (error) reject(error);
              else resolve();
            }
          );
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const { exec } = require("child_process");
          exec(
            `zip -r "${zipPath}" ${options.input
              .map((p) => `"${this.normalizePath(p)}"`)
              .join(" ")}`,
            (error: Error | null) => {
              if (error) reject(error);
              else resolve();
            }
          );
        });
      }
      const zipTime = Date.now() - zipStart;

      const zipStats = await stat(zipPath);
      const zipRatio = (1 - zipStats.size / totalOriginalSize) * 100;

      results.push({
        name: "ZIP",
        size: zipStats.size,
        ratio: zipRatio,
        compressTime: zipTime,
        decompressTime: 0,
      });

      console.log(
        ` ${this.formatBytes(zipStats.size).padStart(10)} (${zipRatio.toFixed(
          1
        )}%) ${(zipTime / 1000).toFixed(2)}s`
      );
    } catch (error) {
      results.push({
        name: "ZIP",
        size: 0,
        ratio: 0,
        compressTime: 0,
        decompressTime: 0,
        error: "Not available",
      });
      console.log(` Not available`);
    }

    const sevenZipPath = join(tempDir, "test.7z");
    process.stdout.write(`  Testing 7z...`.padEnd(30));
    try {
      const sevenZipStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        const { exec } = require("child_process");
        const inputFor7z = options.input
          .map((p) => `"${this.normalizePath(p)}"`)
          .join(" ");
        exec(
          `7z a -mx=9 "${sevenZipPath}" ${inputFor7z}`,
          (error: Error | null) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });
      const sevenZipTime = Date.now() - sevenZipStart;

      const sevenZipStats = await stat(sevenZipPath);
      const sevenZipRatio = (1 - sevenZipStats.size / totalOriginalSize) * 100;

      results.push({
        name: "7z (LZMA2)",
        size: sevenZipStats.size,
        ratio: sevenZipRatio,
        compressTime: sevenZipTime,
        decompressTime: 0,
      });

      console.log(
        ` ${this.formatBytes(sevenZipStats.size).padStart(
          10
        )} (${sevenZipRatio.toFixed(1)}%) ${(sevenZipTime / 1000).toFixed(2)}s`
      );
    } catch {
      results.push({
        name: "7z (LZMA2)",
        size: 0,
        ratio: 0,
        compressTime: 0,
        decompressTime: 0,
        error: "Not available (install 7-Zip and add to PATH)",
      });
      console.log(` Not available`);
    }

    await new Promise<void>((resolve) => {
      const { exec } = require("child_process");
      if (process.platform === "win32") {
        exec(`rmdir /s /q "${tempDir}"`, () => resolve());
      } else {
        exec(`rm -rf "${tempDir}"`, () => resolve());
      }
    });

    console.log("\n" + "═".repeat(80));
    console.log("  RESULTS SUMMARY (sorted by compression ratio)");
    console.log("═".repeat(80));

    const validResults = results
      .filter((r) => !r.error)
      .sort((a, b) => a.size - b.size);

    const speedMBps = (size: number, timeMs: number) =>
      timeMs > 0 ? (size / 1024 / 1024 / (timeMs / 1000)).toFixed(1) : "∞";

    console.log(
      "\n" +
        "Format".padEnd(20) +
        "Size".padStart(12) +
        "Ratio".padStart(10) +
        "Time".padStart(10) +
        "Speed".padStart(12)
    );
    console.log("─".repeat(64));

    for (const result of validResults) {
      const speed = speedMBps(totalOriginalSize, result.compressTime);
      console.log(
        result.name.padEnd(20) +
          this.formatBytes(result.size).padStart(12) +
          `${result.ratio.toFixed(1)}%`.padStart(10) +
          `${(result.compressTime / 1000).toFixed(2)}s`.padStart(10) +
          `${speed} MB/s`.padStart(12)
      );
    }

    if (validResults.length > 0) {
      const bestRatio = validResults[0]!;
      const fastestNsx = validResults
        .filter((r) => r.name.startsWith("NSX") && r.ratio > 0)
        .sort((a, b) => a.compressTime - b.compressTime)[0];
      const zip = validResults.find((r) => r.name === "ZIP");
      const sevenZ = validResults.find((r) => r.name === "7z (LZMA2)");

      console.log("\n" + "─".repeat(64));
      console.log("\nCOMPARISON:");

      console.log(`\nBest Compression: ${bestRatio.name}`);
      console.log(
        `   Ratio: ${bestRatio.ratio.toFixed(1)}% | Time: ${(
          bestRatio.compressTime / 1000
        ).toFixed(2)}s`
      );

      if (fastestNsx && fastestNsx.name !== bestRatio.name) {
        console.log(`\nFastest NSX: ${fastestNsx.name}`);
        console.log(
          `   Ratio: ${fastestNsx.ratio.toFixed(1)}% | Time: ${(
            fastestNsx.compressTime / 1000
          ).toFixed(2)}s`
        );
      }

      if (zip && !zip.error) {
        const ratioVsZip = bestRatio.ratio - zip.ratio;
        const timeVsZip =
          zip.compressTime / Math.max(bestRatio.compressTime, 1);
        const fastestTimeVsZip = fastestNsx
          ? zip.compressTime / Math.max(fastestNsx.compressTime, 1)
          : 0;

        console.log(`\nvs ZIP:`);
        console.log(
          `   Compression: ${ratioVsZip > 0 ? "+" : ""}${ratioVsZip.toFixed(
            1
          )}% ${ratioVsZip > 0 ? "better" : "worse"}`
        );
        console.log(
          `   Speed: ${timeVsZip.toFixed(1)}x ${
            timeVsZip > 1 ? "faster" : "slower"
          } (best compression)`
        );
        if (fastestNsx && fastestTimeVsZip > 0) {
          console.log(
            `   Speed: ${fastestTimeVsZip.toFixed(1)}x ${
              fastestTimeVsZip > 1 ? "faster" : "slower"
            } (fastest NSX)`
          );
        }
      }

      if (sevenZ && !sevenZ.error) {
        const ratioVs7z = bestRatio.ratio - sevenZ.ratio;
        const timeVs7z =
          sevenZ.compressTime / Math.max(bestRatio.compressTime, 1);

        console.log(`\nvs 7z:`);
        console.log(
          `   Compression: ${ratioVs7z > 0 ? "+" : ""}${ratioVs7z.toFixed(
            1
          )}% ${ratioVs7z > 0 ? "better" : "worse"}`
        );
        console.log(
          `   Speed: ${timeVs7z.toFixed(1)}x ${
            timeVs7z > 1 ? "faster" : "slower"
          }`
        );
      }

      const recommended = validResults.find(
        (r) => r.name.startsWith("NSX") && r.name.includes("brotli-6")
      );
      if (recommended) {
        console.log(
          `\nRecommended: ${recommended.name} (balanced speed & compression)`
        );
        console.log(
          `   Ratio: ${recommended.ratio.toFixed(1)}% | Time: ${(
            recommended.compressTime / 1000
          ).toFixed(2)}s | Speed: ${speedMBps(
            totalOriginalSize,
            recommended.compressTime
          )} MB/s`
        );
      }
    }

    console.log("\n" + "═".repeat(80) + "\n");
  }

  private async getTotalSize(paths: string[]): Promise<number> {
    let total = 0;
    for (const path of paths) {
      try {
        const stats = await stat(path);
        if (stats.isDirectory()) {
          const files = await this.getAllFiles(path);
          for (const file of files) {
            try {
              const fileStats = await stat(file);
              total += fileStats.size;
            } catch {
              // Ignore errors
            }
          }
        } else {
          total += stats.size;
        }
      } catch {
        // Ignore errors
      }
    }
    return total;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}
