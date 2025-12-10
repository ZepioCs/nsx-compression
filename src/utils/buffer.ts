export class BufferUtils {
  static writeUint32(
    buffer: Uint8Array,
    offset: number,
    value: number
  ): number {
    buffer[offset] = (value >>> 24) & 0xff;
    buffer[offset + 1] = (value >>> 16) & 0xff;
    buffer[offset + 2] = (value >>> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
    return offset + 4;
  }

  static readUint32(
    buffer: Uint8Array,
    offset: number
  ): { value: number; offset: number } {
    const value =
      buffer[offset]! * 0x1000000 +
      buffer[offset + 1]! * 0x10000 +
      buffer[offset + 2]! * 0x100 +
      buffer[offset + 3]!;
    return { value, offset: offset + 4 };
  }

  static writeUint64(
    buffer: Uint8Array,
    offset: number,
    value: bigint
  ): number {
    const high = Number((value >> 32n) & 0xffffffffn);
    const low = Number(value & 0xffffffffn);
    this.writeUint32(buffer, offset, high);
    this.writeUint32(buffer, offset + 4, low);
    return offset + 8;
  }

  static readUint64(
    buffer: Uint8Array,
    offset: number
  ): { value: bigint; offset: number } {
    const high = this.readUint32(buffer, offset);
    const low = this.readUint32(buffer, high.offset);
    const highBig = BigInt(high.value >>> 0);
    const lowBig = BigInt(low.value >>> 0);
    const value = (highBig << 32n) | lowBig;
    return { value, offset: low.offset };
  }

  static writeString(buffer: Uint8Array, offset: number, str: string): number {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(str);
    offset = this.writeUint32(buffer, offset, encoded.length);
    buffer.set(encoded, offset);
    return offset + encoded.length;
  }

  static readString(
    buffer: Uint8Array,
    offset: number
  ): { value: string; offset: number } {
    const length = this.readUint32(buffer, offset);
    const decoder = new TextDecoder();
    const value = decoder.decode(
      buffer.slice(length.offset, length.offset + length.value)
    );
    return { value, offset: length.offset + length.value };
  }
}
