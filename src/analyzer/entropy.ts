export class EntropyAnalyzer {
  static calculate(data: Uint8Array): number {
    if (data.length === 0) return 0;

    const frequencies = new Map<number, number>();
    for (const byte of data) {
      frequencies.set(byte, (frequencies.get(byte) || 0) + 1);
    }

    let entropy = 0;
    const length = data.length;

    for (const count of frequencies.values()) {
      const probability = count / length;
      entropy -= probability * Math.log2(probability);
    }

    return entropy;
  }

  static getCompressibility(data: Uint8Array): number {
    const entropy = this.calculate(data);
    const maxEntropy = 8;
    return 1 - entropy / maxEntropy;
  }

  static hasRepeatingPatterns(data: Uint8Array, minPatternLength: number = 4): boolean {
    if (data.length < minPatternLength * 2) return false;

    const patternCounts = new Map<string, number>();
    for (let i = 0; i <= data.length - minPatternLength; i++) {
      const pattern = Array.from(data.slice(i, i + minPatternLength))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    }

    for (const count of patternCounts.values()) {
      if (count >= 3) {
        return true;
      }
    }

    return false;
  }

  static getByteDistribution(data: Uint8Array): Map<number, number> {
    const distribution = new Map<number, number>();
    for (const byte of data) {
      distribution.set(byte, (distribution.get(byte) || 0) + 1);
    }
    return distribution;
  }
}

