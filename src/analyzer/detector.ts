export enum FileType {
  TEXT = "text",
  BINARY = "binary",
  EXECUTABLE = "executable",
  IMAGE = "image",
  AUDIO = "audio",
  VIDEO = "video",
  ARCHIVE = "archive",
  UNKNOWN = "unknown",
}

export class FileTypeDetector {
  static detect(data: Uint8Array, filename?: string): FileType {
    if (filename) {
      const ext = filename.toLowerCase().split(".").pop() || "";
      const type = this.detectByExtension(ext);
      if (type !== FileType.UNKNOWN) {
        return type;
      }
    }

    return this.detectByContent(data);
  }

  private static detectByExtension(ext: string): FileType {
    const textExtensions = [
      "txt", "md", "json", "xml", "html", "css", "js", "ts", "py", "java",
      "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "sh", "bat",
      "ps1", "yaml", "yml", "ini", "cfg", "conf", "log", "csv", "sql",
    ];
    const executableExtensions = [
      "exe", "dll", "so", "dylib", "bin", "app", "deb", "rpm", "msi",
    ];
    const imageExtensions = [
      "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tiff",
    ];
    const audioExtensions = [
      "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma",
    ];
    const videoExtensions = [
      "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v",
    ];
    const archiveExtensions = [
      "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst",
    ];

    if (textExtensions.includes(ext)) return FileType.TEXT;
    if (executableExtensions.includes(ext)) return FileType.EXECUTABLE;
    if (imageExtensions.includes(ext)) return FileType.IMAGE;
    if (audioExtensions.includes(ext)) return FileType.AUDIO;
    if (videoExtensions.includes(ext)) return FileType.VIDEO;
    if (archiveExtensions.includes(ext)) return FileType.ARCHIVE;

    return FileType.UNKNOWN;
  }

  private static detectByContent(data: Uint8Array): FileType {
    if (data.length === 0) return FileType.UNKNOWN;

    const magicBytes = data.slice(0, Math.min(16, data.length));

    if (this.isText(magicBytes, data)) {
      return FileType.TEXT;
    }

    if (this.isExecutable(magicBytes)) {
      return FileType.EXECUTABLE;
    }

    if (this.isImage(magicBytes)) {
      return FileType.IMAGE;
    }

    if (this.isAudio(magicBytes)) {
      return FileType.AUDIO;
    }

    if (this.isVideo(magicBytes)) {
      return FileType.VIDEO;
    }

    if (this.isArchive(magicBytes)) {
      return FileType.ARCHIVE;
    }

    return FileType.BINARY;
  }

  private static isText(magicBytes: Uint8Array, fullData: Uint8Array): boolean {
    const sampleSize = Math.min(1024, fullData.length);
    const sample = fullData.slice(0, sampleSize);
    let textBytes = 0;

    for (let i = 0; i < sample.length; i++) {
      const byte = sample[i];
      if (
        (byte >= 0x20 && byte < 0x7f) ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d
      ) {
        textBytes++;
      }
    }

    return textBytes / sample.length > 0.9;
  }

  private static isExecutable(magicBytes: Uint8Array): boolean {
    if (magicBytes.length < 2) return false;

    if (magicBytes[0] === 0x4d && magicBytes[1] === 0x5a) {
      return true;
    }

    if (magicBytes[0] === 0x7f && magicBytes[1] === 0x45 && magicBytes[2] === 0x4c && magicBytes[3] === 0x46) {
      return true;
    }

    if (magicBytes[0] === 0xca && magicBytes[1] === 0xfe && magicBytes[2] === 0xba && magicBytes[3] === 0xbe) {
      return true;
    }

    return false;
  }

  private static isImage(magicBytes: Uint8Array): boolean {
    if (magicBytes.length < 4) return false;

    if (magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4e && magicBytes[3] === 0x47) {
      return true;
    }

    if (magicBytes[0] === 0xff && magicBytes[1] === 0xd8 && magicBytes[2] === 0xff) {
      return true;
    }

    if (magicBytes[0] === 0x47 && magicBytes[1] === 0x49 && magicBytes[2] === 0x46) {
      return true;
    }

    if (magicBytes[0] === 0x42 && magicBytes[1] === 0x4d) {
      return true;
    }

    return false;
  }

  private static isAudio(magicBytes: Uint8Array): boolean {
    if (magicBytes.length < 4) return false;

    if (magicBytes[0] === 0x49 && magicBytes[1] === 0x44 && magicBytes[2] === 0x33) {
      return true;
    }

    if (magicBytes[0] === 0xff && (magicBytes[1] & 0xfe) === 0xfa) {
      return true;
    }

    if (magicBytes[0] === 0x4f && magicBytes[1] === 0x67 && magicBytes[2] === 0x67 && magicBytes[3] === 0x53) {
      return true;
    }

    return false;
  }

  private static isVideo(magicBytes: Uint8Array): boolean {
    if (magicBytes.length < 4) return false;

    if (magicBytes[0] === 0x00 && magicBytes[1] === 0x00 && magicBytes[2] === 0x00) {
      if (magicBytes[3] === 0x18 || magicBytes[3] === 0x20) {
        return true;
      }
    }

    if (magicBytes[0] === 0x1a && magicBytes[1] === 0x45 && magicBytes[2] === 0xdf && magicBytes[3] === 0xa3) {
      return true;
    }

    return false;
  }

  private static isArchive(magicBytes: Uint8Array): boolean {
    if (magicBytes.length < 4) return false;

    if (magicBytes[0] === 0x50 && magicBytes[1] === 0x4b) {
      return true;
    }

    if (magicBytes[0] === 0x52 && magicBytes[1] === 0x61 && magicBytes[2] === 0x72 && magicBytes[3] === 0x21) {
      return true;
    }

    if (magicBytes[0] === 0x37 && magicBytes[1] === 0x7a && magicBytes[2] === 0xbc && magicBytes[3] === 0xaf) {
      return true;
    }

    return false;
  }
}

