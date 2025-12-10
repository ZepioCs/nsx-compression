import { BufferUtils } from "../utils/buffer";

export const MAGIC_NUMBER = 0x434d5052;
export const VERSION = 1;

export interface ArchiveHeader {
  magic: number;
  version: number;
  fileCount: number;
  indexOffset: bigint;
  flags: number;
}

export class HeaderSerializer {
  static serialize(header: ArchiveHeader): Uint8Array {
    const buffer = new Uint8Array(24);
    let offset = 0;

    offset = BufferUtils.writeUint32(buffer, offset, header.magic);
    offset = BufferUtils.writeUint32(buffer, offset, header.version);
    offset = BufferUtils.writeUint32(buffer, offset, header.fileCount);
    offset = BufferUtils.writeUint64(buffer, offset, header.indexOffset);
    offset = BufferUtils.writeUint32(buffer, offset, header.flags);

    return buffer;
  }

  static deserialize(buffer: Uint8Array): ArchiveHeader {
    let offset = 0;

    const magic = BufferUtils.readUint32(buffer, offset);
    offset = magic.offset;

    const version = BufferUtils.readUint32(buffer, offset);
    offset = version.offset;

    const fileCount = BufferUtils.readUint32(buffer, offset);
    offset = fileCount.offset;

    const indexOffset = BufferUtils.readUint64(buffer, offset);
    offset = indexOffset.offset;

    const flags = BufferUtils.readUint32(buffer, offset);

    return {
      magic: magic.value,
      version: version.value,
      fileCount: fileCount.value,
      indexOffset: indexOffset.value,
      flags: flags.value,
    };
  }
}

