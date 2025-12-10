import type { BenchmarkResult } from "./runner";
import type { FormatComparison } from "./comparator";

export class BenchmarkReporter {
  static formatResults(
    algorithmResults: BenchmarkResult[],
    formatComparisons: FormatComparison[]
  ): string {
    let output = "\n" + "=".repeat(80) + "\n";
    output += "COMPRESSION BENCHMARK RESULTS\n";
    output += "=".repeat(80) + "\n\n";

    output += "Our Algorithms:\n";
    output += "-".repeat(80) + "\n";
    output += this.formatAlgorithmResults(algorithmResults);

    output += "\nComparison with Other Formats:\n";
    output += "-".repeat(80) + "\n";
    output += this.formatComparisonResults(formatComparisons);

    output += "\n" + "=".repeat(80) + "\n";

    return output;
  }

  private static formatAlgorithmResults(results: BenchmarkResult[]): string {
    let output = "";
    output += "Algorithm".padEnd(15);
    output += "Original".padStart(12);
    output += "Compressed".padStart(12);
    output += "Ratio".padStart(10);
    output += "Comp Time".padStart(12);
    output += "Decomp Time".padStart(12);
    output += "\n";

    for (const result of results) {
      output += result.algorithm.padEnd(15);
      output += this.formatBytes(result.originalSize).padStart(12);
      output += this.formatBytes(result.compressedSize).padStart(12);
      output += `${result.compressionRatio.toFixed(2)}%`.padStart(10);
      output += `${result.compressionTime.toFixed(2)}ms`.padStart(12);
      output += `${result.decompressionTime.toFixed(2)}ms`.padStart(12);
      output += "\n";
    }

    return output;
  }

  private static formatComparisonResults(results: FormatComparison[]): string {
    let output = "";
    output += "Format".padEnd(15);
    output += "Original".padStart(12);
    output += "Compressed".padStart(12);
    output += "Ratio".padStart(10);
    output += "Comp Time".padStart(12);
    output += "Decomp Time".padStart(12);
    output += "Status".padStart(10);
    output += "\n";

    for (const result of results) {
      output += result.format.padEnd(15);
      if (result.available) {
        output += this.formatBytes(result.originalSize).padStart(12);
        output += this.formatBytes(result.compressedSize).padStart(12);
        output += `${result.compressionRatio.toFixed(2)}%`.padStart(10);
        output += `${result.compressionTime.toFixed(2)}ms`.padStart(12);
        output += `${result.decompressionTime.toFixed(2)}ms`.padStart(12);
        output += "OK".padStart(10);
      } else {
        output += "N/A".padStart(12);
        output += "N/A".padStart(12);
        output += "N/A".padStart(10);
        output += "N/A".padStart(12);
        output += "N/A".padStart(12);
        output += "FAILED".padStart(10);
      }
      output += "\n";
    }

    return output;
  }

  private static formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  static generateComparisonTable(
    ourBest: BenchmarkResult,
    comparisons: FormatComparison[]
  ): string {
    let output = "\nCOMPARISON SUMMARY\n";
    output += "-".repeat(80) + "\n";
    output += `Our Best Algorithm (${
      ourBest.algorithm
    }): ${ourBest.compressionRatio.toFixed(2)}% compression\n\n`;

    for (const comp of comparisons) {
      if (comp.available) {
        const improvement = ourBest.compressionRatio - comp.compressionRatio;
        const improvementStr =
          improvement > 0
            ? `+${improvement.toFixed(2)}%`
            : `${improvement.toFixed(2)}%`;
        output += `${comp.format.padEnd(10)}: ${comp.compressionRatio.toFixed(
          2
        )}% (${improvementStr} vs ours)\n`;
      } else {
        output += `${comp.format.padEnd(10)}: Not available\n`;
      }
    }

    return output;
  }
}
