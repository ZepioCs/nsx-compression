import { BufferUtils } from "../utils/buffer";

const NO_PERMISSIONS_SENTINEL = 0xFFFFFFFF;

export interface FileEntry {
  path: string;
  size: number;
  compressedSize: number;
  algorithm: string;
  offset: bigint;
  timestamp: number;
  permissions?: number;
}

export class EntrySerializer {
  static serialize(entry: FileEntry): Uint8Array {
    const pathBytes = new TextEncoder().encode(entry.path);
    const algorithmBytes = new TextEncoder().encode(entry.algorithm);
    const size =
      4 + pathBytes.length +
      8 +
      8 +
      8 +
      4 +
      4 + algorithmBytes.length +
      4;
    const buffer = new Uint8Array(size);
    let offset = 0;

    offset = BufferUtils.writeUint32(buffer, offset, pathBytes.length);
    buffer.set(pathBytes, offset);
    offset += pathBytes.length;

    offset = BufferUtils.writeUint64(buffer, offset, BigInt(entry.size));
    offset = BufferUtils.writeUint64(buffer, offset, BigInt(entry.compressedSize));
    offset = BufferUtils.writeUint64(buffer, offset, entry.offset);
    offset = BufferUtils.writeUint32(buffer, offset, entry.timestamp);

    offset = BufferUtils.writeUint32(buffer, offset, algorithmBytes.length);
    buffer.set(algorithmBytes, offset);
    offset += algorithmBytes.length;

    offset = BufferUtils.writeUint32(
      buffer,
      offset,
      entry.permissions !== undefined ? entry.permissions : NO_PERMISSIONS_SENTINEL
    );

    if (offset !== size) {
      throw new Error(`Serialization size mismatch: calculated ${size} bytes but wrote ${offset} bytes. This is a bug in the serialization code.`);
    }

    return buffer;
  }

  static deserialize(buffer: Uint8Array, startOffset: number = 0): { entry: FileEntry; offset: number } {
    let offset = startOffset;

    if (offset + 4 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for path length");
    }

    const pathLength = BufferUtils.readUint32(buffer, offset);
    offset = pathLength.offset;

    if (pathLength.value < 0 || pathLength.value > 100000) {
      const hexValue = pathLength.value.toString(16).toUpperCase();
      const asciiCheck = String.fromCharCode(
        (pathLength.value >>> 24) & 0xFF,
        (pathLength.value >>> 16) & 0xFF,
        (pathLength.value >>> 8) & 0xFF,
        pathLength.value & 0xFF
      ).replace(/[^\x20-\x7E]/g, '');
      
      if (asciiCheck.length >= 2) {
        throw new Error(`Invalid entry: path length appears to be ASCII text ("${asciiCheck}") instead of a number (${pathLength.value}, 0x${hexValue}). This archive was created with buggy serialization code and is corrupted. The entry data is misaligned. Please re-compress your files with the fixed version.`);
      }
      throw new Error(`Invalid entry: path length out of range (${pathLength.value}, 0x${hexValue}). This archive may be corrupted.`);
    }

    if (offset + pathLength.value > buffer.length) {
      throw new Error(`Invalid entry: path data extends beyond buffer (offset: ${offset}, length: ${pathLength.value}, buffer: ${buffer.length})`);
    }

    const pathBytes = buffer.slice(offset, offset + pathLength.value);
    const path = new TextDecoder().decode(pathBytes);
    offset += pathLength.value;

    if (offset + 8 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for size");
    }
    const size = BufferUtils.readUint64(buffer, offset);
    offset = size.offset;

    if (offset + 8 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for compressed size");
    }
    const compressedSize = BufferUtils.readUint64(buffer, offset);
    offset = compressedSize.offset;

    if (offset + 8 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for entry offset");
    }
    const entryOffset = BufferUtils.readUint64(buffer, offset);
    offset = entryOffset.offset;

    if (offset + 4 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for timestamp");
    }
    const timestamp = BufferUtils.readUint32(buffer, offset);
    offset = timestamp.offset;

    if (offset + 4 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for algorithm length");
    }
    const algorithmLength = BufferUtils.readUint32(buffer, offset);
    offset = algorithmLength.offset;

    if (algorithmLength.value < 0 || algorithmLength.value > 100) {
      throw new Error(`Invalid entry: algorithm length out of range (${algorithmLength.value})`);
    }

    if (offset + algorithmLength.value > buffer.length) {
      throw new Error(`Invalid entry: algorithm data extends beyond buffer (offset: ${offset}, length: ${algorithmLength.value}, buffer: ${buffer.length})`);
    }

    const algorithmBytes = buffer.slice(offset, offset + algorithmLength.value);
    const algorithm = new TextDecoder().decode(algorithmBytes);
    offset += algorithmLength.value;

    if (offset + 4 > buffer.length) {
      throw new Error("Invalid entry: insufficient data for permissions");
    }
    const perm = BufferUtils.readUint32(buffer, offset);
    offset = perm.offset;
    const permissions = perm.value === NO_PERMISSIONS_SENTINEL ? undefined : perm.value;

    const entry: FileEntry = {
      path,
      size: Number(size.value),
      compressedSize: Number(compressedSize.value),
      algorithm,
      offset: entryOffset.value,
      timestamp: timestamp.value,
      permissions,
    };

    return { entry, offset };
  }
}

