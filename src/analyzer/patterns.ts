export class PatternDetector {
  static detectLongestRepeatedSubstring(data: Uint8Array, minLength: number = 4): {
    pattern: Uint8Array;
    occurrences: number;
  } | null {
    if (data.length < minLength * 2) return null;

    let bestPattern: Uint8Array | null = null;
    let bestOccurrences = 0;

    for (let len = Math.min(256, data.length / 2); len >= minLength; len--) {
      const patterns = new Map<string, number[]>();

      for (let i = 0; i <= data.length - len; i++) {
        const pattern = data.slice(i, i + len);
        const key = this.arrayToKey(pattern);
        if (!patterns.has(key)) {
          patterns.set(key, []);
        }
        patterns.get(key)!.push(i);
      }

      for (const [key, positions] of patterns.entries()) {
        if (positions.length >= 2) {
          const pattern = this.keyToArray(key);
          if (pattern.length > (bestPattern?.length || 0)) {
            bestPattern = pattern;
            bestOccurrences = positions.length;
          }
        }
      }

      if (bestPattern) break;
    }

    return bestPattern ? { pattern: bestPattern, occurrences: bestOccurrences } : null;
  }

  static detectStructure(data: Uint8Array): {
    hasFixedSizeBlocks: boolean;
    blockSize?: number;
    hasHeaders: boolean;
  } {
    const result = {
      hasFixedSizeBlocks: false,
      blockSize: undefined as number | undefined,
      hasHeaders: false,
    };

    if (data.length < 16) return result;

    const candidateSizes = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
    for (const size of candidateSizes) {
      if (data.length % size === 0 && data.length >= size * 2) {
        const firstBlock = data.slice(0, size);
        let matches = 1;
        for (let i = size; i < data.length; i += size) {
          const block = data.slice(i, i + size);
          if (this.arraysEqual(firstBlock, block)) {
            matches++;
          }
        }
        if (matches >= 2) {
          result.hasFixedSizeBlocks = true;
          result.blockSize = size;
          break;
        }
      }
    }

    if (data.length >= 32) {
      const firstBytes = data.slice(0, 16);
      let headerMatches = 0;
      for (let i = 16; i < Math.min(data.length, 1024); i += 16) {
        const block = data.slice(i, i + 16);
        if (this.arraysEqual(firstBytes, block)) {
          headerMatches++;
        }
      }
      result.hasHeaders = headerMatches > 0;
    }

    return result;
  }

  private static arrayToKey(arr: Uint8Array): string {
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private static keyToArray(key: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < key.length; i += 2) {
      bytes.push(parseInt(key.substr(i, 2), 16));
    }
    return new Uint8Array(bytes);
  }

  private static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

