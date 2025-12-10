import { exec } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import { getFileSize } from "../utils/io";
import { BenchmarkResult } from "./runner";

const execAsync = promisify(exec);

export interface FormatComparison {
  format: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  compressionTime: number;
  decompressionTime: number;
  available: boolean;
  error?: string;
}

export class FormatComparator {
  async compareWithZip(filePath: string): Promise<FormatComparison> {
    try {
      const originalSize = await getFileSize(filePath);
      const zipPath = filePath + ".zip";

      const compressStart = performance.now();
      await execAsync(`powershell Compress-Archive -Path "${filePath}" -DestinationPath "${zipPath}" -Force`);
      const compressEnd = performance.now();

      const stats = await stat(zipPath);
      const compressedSize = stats.size;

      const decompressStart = performance.now();
      await execAsync(`powershell Expand-Archive -Path "${zipPath}" -DestinationPath "${filePath}.zip_extracted" -Force`);
      const decompressEnd = performance.now();

      const compressionRatio = (1 - compressedSize / originalSize) * 100;

      return {
        format: "zip",
        originalSize,
        compressedSize,
        compressionRatio,
        compressionTime: compressEnd - compressStart,
        decompressionTime: decompressEnd - decompressStart,
        available: true,
      };
    } catch (error) {
      return {
        format: "zip",
        originalSize: 0,
        compressedSize: 0,
        compressionRatio: 0,
        compressionTime: 0,
        decompressionTime: 0,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compareWith7z(filePath: string): Promise<FormatComparison> {
    try {
      const originalSize = await getFileSize(filePath);
      const archivePath = filePath + ".7z";

      const compressStart = performance.now();
      await execAsync(`7z a -mx=9 "${archivePath}" "${filePath}"`);
      const compressEnd = performance.now();

      const stats = await stat(archivePath);
      const compressedSize = stats.size;

      const decompressStart = performance.now();
      await execAsync(`7z x "${archivePath}" -o"${filePath}.7z_extracted" -y`);
      const decompressEnd = performance.now();

      const compressionRatio = (1 - compressedSize / originalSize) * 100;

      return {
        format: "7z",
        originalSize,
        compressedSize,
        compressionRatio,
        compressionTime: compressEnd - compressStart,
        decompressionTime: decompressEnd - decompressStart,
        available: true,
      };
    } catch (error) {
      return {
        format: "7z",
        originalSize: 0,
        compressedSize: 0,
        compressionRatio: 0,
        compressionTime: 0,
        decompressionTime: 0,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compareWithTar(filePath: string): Promise<FormatComparison> {
    try {
      const originalSize = await getFileSize(filePath);
      const tarPath = filePath + ".tar.gz";

      const compressStart = performance.now();
      await execAsync(`tar -czf "${tarPath}" "${filePath}"`);
      const compressEnd = performance.now();

      const stats = await stat(tarPath);
      const compressedSize = stats.size;

      const decompressStart = performance.now();
      await execAsync(`tar -xzf "${tarPath}" -C "${filePath}.tar_extracted"`);
      const decompressEnd = performance.now();

      const compressionRatio = (1 - compressedSize / originalSize) * 100;

      return {
        format: "tar.gz",
        originalSize,
        compressedSize,
        compressionRatio,
        compressionTime: compressEnd - compressStart,
        decompressionTime: decompressEnd - decompressStart,
        available: true,
      };
    } catch (error) {
      return {
        format: "tar.gz",
        originalSize: 0,
        compressedSize: 0,
        compressionRatio: 0,
        compressionTime: 0,
        decompressionTime: 0,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compareAll(filePath: string): Promise<FormatComparison[]> {
    const results: FormatComparison[] = [];

    results.push(await this.compareWithZip(filePath));
    results.push(await this.compareWith7z(filePath));
    results.push(await this.compareWithTar(filePath));

    return results;
  }
}

