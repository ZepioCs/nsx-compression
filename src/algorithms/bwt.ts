import { CompressionAlgorithm } from "./base";

class SimpleBWT {
  static transform(data: Uint8Array): { transformed: Uint8Array; index: number } {
    const n = data.length;
    if (n === 0) return { transformed: new Uint8Array(0), index: 0 };

    const rotations: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const rotation = new Uint8Array(n);
      for (let j = 0; j < n; j++) {
        rotation[j] = data[(i + j) % n];
      }
      rotations.push(rotation);
    }

    rotations.sort((a, b) => {
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
          return a[i] - b[i];
        }
      }
      return 0;
    });

    const transformed = new Uint8Array(n);
    let index = -1;
    for (let i = 0; i < n; i++) {
      transformed[i] = rotations[i][n - 1];
      if (rotations[i] === data || this.arraysEqual(rotations[i], data)) {
        index = i;
      }
    }

    if (index === -1) {
      for (let i = 0; i < n; i++) {
        if (this.arraysEqual(rotations[i], data)) {
          index = i;
          break;
        }
      }
    }

    return { transformed, index: index >= 0 ? index : 0 };
  }

  static inverseTransform(transformed: Uint8Array, index: number): Uint8Array {
    const n = transformed.length;
    if (n === 0) return new Uint8Array(0);

    const count = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      count[transformed[i]]++;
    }

    const cumCount = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      cumCount[i] = sum;
      sum += count[i];
    }

    const T = new Uint32Array(n);
    const tempCount = new Uint32Array(cumCount);
    for (let i = 0; i < n; i++) {
      const c = transformed[i];
      T[tempCount[c]] = i;
      tempCount[c]++;
    }

    const result = new Uint8Array(n);
    let pos = index;
    for (let i = n - 1; i >= 0; i--) {
      result[i] = transformed[pos];
      pos = T[pos];
    }

    return result;
  }

  private static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

class MoveToFront {
  static encode(data: Uint8Array): Uint8Array {
    const alphabet = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      alphabet[i] = i;
    }

    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      let pos = 0;
      for (let j = 0; j < 256; j++) {
        if (alphabet[j] === byte) {
          pos = j;
          break;
        }
      }
      result[i] = pos;

      for (let j = pos; j > 0; j--) {
        alphabet[j] = alphabet[j - 1];
      }
      alphabet[0] = byte;
    }

    return result;
  }

  static decode(data: Uint8Array): Uint8Array {
    const alphabet = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      alphabet[i] = i;
    }

    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const pos = data[i];
      const byte = alphabet[pos];
      result[i] = byte;

      for (let j = pos; j > 0; j--) {
        alphabet[j] = alphabet[j - 1];
      }
      alphabet[0] = byte;
    }

    return result;
  }
}

class SimpleHuffman {
  static compress(data: Uint8Array): Uint8Array {
    const freq = new Map<number, number>();
    for (const byte of data) {
      freq.set(byte, (freq.get(byte) || 0) + 1);
    }

    const codes = this.buildCodes(freq);
    const encoded: number[] = [];
    let currentByte = 0;
    let bitCount = 0;

    for (const byte of data) {
      const code = codes.get(byte);
      if (!code) continue;

      for (const bit of code) {
        if (bit === 1) {
          currentByte |= 1 << (7 - bitCount);
        }
        bitCount++;

        if (bitCount === 8) {
          encoded.push(currentByte);
          currentByte = 0;
          bitCount = 0;
        }
      }
    }

    if (bitCount > 0) {
      encoded.push(currentByte);
    }

    const header = this.serializeTree(codes);
    const lengthBuffer = new Uint8Array(4);
    new DataView(lengthBuffer.buffer).setUint32(0, data.length, true);
    
    const result = new Uint8Array(4 + header.length + encoded.length);
    result.set(lengthBuffer, 0);
    result.set(header, 4);
    result.set(new Uint8Array(encoded), 4 + header.length);

    return result;
  }

  static decompress(data: Uint8Array): Uint8Array {
    if (data.length < 4) {
      throw new Error("Invalid Huffman data: too short");
    }
    
    const originalLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
    const huffmanData = new Uint8Array(data.buffer, data.byteOffset + 4, data.byteLength - 4);
    
    const { codes, offset } = this.deserializeTree(huffmanData);
    const decoded: number[] = [];
    let node = 0;

    outer: for (let i = offset; i < huffmanData.length; i++) {
      const byte = huffmanData[i];
      for (let bit = 7; bit >= 0; bit--) {
        if (decoded.length >= originalLength) {
          break outer;
        }
        
        const bitValue = (byte >> bit) & 1;
        node = node * 2 + bitValue;

        for (const [value, code] of codes.entries()) {
          if (this.codeMatches(code, node)) {
            decoded.push(value);
            node = 0;
            break;
          }
        }
      }
    }

    return new Uint8Array(decoded);
  }

  private static buildCodes(freq: Map<number, number>): Map<number, number[]> {
    const codes = new Map<number, number[]>();
    const sorted = Array.from(freq.entries()).sort((a, b) => a[1] - b[1]);

    if (sorted.length === 0) return codes;
    if (sorted.length === 1) {
      codes.set(sorted[0][0], [0]);
      return codes;
    }

    const assignCode = (items: Array<[number, number]>, prefix: number[]): void => {
      if (items.length === 1) {
        codes.set(items[0][0], prefix);
        return;
      }

      const mid = Math.ceil(items.length / 2);
      const left = items.slice(0, mid);
      const right = items.slice(mid);

      assignCode(left, [...prefix, 0]);
      assignCode(right, [...prefix, 1]);
    };

    assignCode(sorted, []);
    return codes;
  }

  private static codeMatches(code: number[], value: number): boolean {
    if (code.length === 0) return value === 0;
    let temp = value;
    for (let i = code.length - 1; i >= 0; i--) {
      if ((temp & 1) !== code[i]) return false;
      temp >>= 1;
    }
    return temp === 0;
  }

  private static serializeTree(codes: Map<number, number[]>): Uint8Array {
    const entries: number[] = [];
    entries.push(codes.size);
    for (const [byte, code] of codes.entries()) {
      entries.push(byte);
      entries.push(code.length);
      entries.push(...code);
    }
    return new Uint8Array(entries);
  }

  private static deserializeTree(data: Uint8Array): { codes: Map<number, number[]>; offset: number } {
    const codes = new Map<number, number[]>();
    let offset = 0;
    const count = data[offset++];
    for (let i = 0; i < count; i++) {
      const byte = data[offset++];
      const codeLen = data[offset++];
      const code: number[] = [];
      for (let j = 0; j < codeLen; j++) {
        code.push(data[offset++]);
      }
      codes.set(byte, code);
    }
    return { codes, offset };
  }
}

export class BWTAlgorithm implements CompressionAlgorithm {
  name = "bwt";
  private compressionLevel: number = 6;

  constructor(compressionLevel: number = 6) {
    this.compressionLevel = compressionLevel;
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    if (data.length === 0) {
      const indexBuffer = new Uint8Array(4);
      new DataView(indexBuffer.buffer).setUint32(0, 0, true);
      return indexBuffer;
    }

    if (data.length > 2 * 1024 * 1024) {
      throw new Error(`BWT cannot compress files larger than 2MB (file size: ${data.length} bytes). Use gzip instead.`);
    }

    const blockSize = Math.min(900000, data.length);
    const blocks: Uint8Array[] = [];

    for (let i = 0; i < data.length; i += blockSize) {
      const block = data.slice(i, Math.min(i + blockSize, data.length));
      const bwt = SimpleBWT.transform(block);
      const mtf = MoveToFront.encode(bwt.transformed);
      const huffman = SimpleHuffman.compress(mtf);

      const indexBuffer = new Uint8Array(4);
      new DataView(indexBuffer.buffer).setUint32(0, bwt.index, true);

      const result = new Uint8Array(4 + huffman.length);
      result.set(indexBuffer, 0);
      result.set(huffman, 4);
      blocks.push(result);
    }

    const blockCountBuffer = new Uint8Array(4);
    new DataView(blockCountBuffer.buffer).setUint32(0, blocks.length, true);

    const totalSize = 4 + blocks.reduce((sum, block) => sum + 4 + block.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    result.set(blockCountBuffer, offset);
    offset += 4;

    for (const block of blocks) {
      const sizeBuffer = new Uint8Array(4);
      new DataView(sizeBuffer.buffer).setUint32(0, block.length, true);
      result.set(sizeBuffer, offset);
      offset += 4;
      result.set(block, offset);
      offset += block.length;
    }

    return result;
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 4) {
      throw new Error("Invalid BWT compressed data");
    }

    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const blockCount = dataView.getUint32(0, true);
    const blocks: Uint8Array[] = [];
    let offset = 4;

    for (let i = 0; i < blockCount; i++) {
      if (offset + 4 > data.length) {
        throw new Error("Invalid BWT compressed data: block size missing");
      }
      const blockSize = dataView.getUint32(offset, true);
      offset += 4;

      if (offset + blockSize > data.length) {
        throw new Error("Invalid BWT compressed data: block data incomplete");
      }

      const blockData = new Uint8Array(data.buffer, data.byteOffset + offset, blockSize);
      offset += blockSize;

      if (blockSize === 4) {
        const blockView = new DataView(blockData.buffer, blockData.byteOffset, blockData.byteLength);
        const index = blockView.getUint32(0, true);
        if (index === 0) {
          blocks.push(new Uint8Array(0));
          continue;
        }
      }

      const blockView = new DataView(blockData.buffer, blockData.byteOffset, blockData.byteLength);
      const index = blockView.getUint32(0, true);
      const huffmanData = new Uint8Array(blockData.buffer, blockData.byteOffset + 4, blockData.byteLength - 4);
      const mtf = SimpleHuffman.decompress(huffmanData);
      const bwt = SimpleBWT.inverseTransform(mtf, index);
      blocks.push(bwt);
    }

    const totalSize = blocks.reduce((sum, block) => sum + block.length, 0);
    const result = new Uint8Array(totalSize);
    let resultOffset = 0;

    for (const block of blocks) {
      result.set(block, resultOffset);
      resultOffset += block.length;
    }

    return result;
  }

  getCompressionLevel(): number {
    return this.compressionLevel;
  }

  setCompressionLevel(level: number): void {
    if (level < 0 || level > 9) {
      throw new Error("BWT compression level must be between 0 and 9");
    }
    this.compressionLevel = level;
  }
}

