import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

export async function readFileBuffer(filePath: string): Promise<Uint8Array> {
  const buffer = await readFile(filePath);
  return new Uint8Array(buffer);
}

export async function writeFileBuffer(filePath: string, data: Uint8Array): Promise<void> {
  const dir = dirname(filePath);
  if (dir && dir !== "." && dir !== filePath && !existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, data);
}

export async function getFileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

