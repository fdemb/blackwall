import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const SAVE_PATH = "blackwall_data/uploads";
const PUBLIC_URL_PREFIX = "/uploaded-files";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
};

function getExtension(file: File): string {
  const originalExt = extname(file.name);
  if (originalExt) return originalExt;
  const byMime = MIME_TO_EXT[file.type];
  if (!byMime) throw new Error("Unknown file type");
  return byMime;
}

type SaveFileOptions = {
  /** Directory path relative to blackwall_data/uploads/ */
  directory: string;
  /** File name */
  name: string;
};

/**
 * Get a file by its full path
 * e.g., "blackwall_data/uploads/workspaces/slug/file.jpg"
 */
export async function getFile(
  filePath: string,
): Promise<{ file: Bun.BunFile; exists: boolean }> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  return { file, exists };
}

/**
 * Save a file and return its full path
 * e.g., returns "blackwall_data/uploads/workspaces/slug/file.jpg"
 */
export async function saveFile(
  file: File,
  options: SaveFileOptions,
): Promise<string> {
  const ext = getExtension(file);
  const filename = `${options.name}-${crypto.randomUUID()}${ext}`;

  const dirPath = join(SAVE_PATH, options.directory);
  const filePath = join(dirPath, filename);

  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }

  await Bun.write(filePath, file);

  return filePath;
}

/**
 * Delete a file by its full path
 * e.g., "blackwall_data/uploads/workspaces/slug/file.jpg"
 */
export function deleteFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    console.log("Failed to delete file", filePath);
  }
}

/**
 * Convert a stored file path to a public URL
 * e.g., "blackwall_data/uploads/public/avatars/foo.jpg" -> "/uploaded-files/avatars/foo.jpg"
 */
export function toPublicUrl(filePath: string): string {
  const prefix = `${SAVE_PATH}/public/`;
  if (!filePath.startsWith(prefix)) {
    throw new Error(`File path must start with ${prefix}`);
  }
  return `${PUBLIC_URL_PREFIX}/${filePath.slice(prefix.length)}`;
}

/**
 * Convert a public URL to its full storage path
 * e.g., "/uploaded-files/avatars/foo.jpg" -> "blackwall_data/uploads/public/avatars/foo.jpg"
 * Returns null if the URL doesn't match the expected format
 */
export function fromPublicUrl(url: string): string | null {
  if (!url.startsWith(`${PUBLIC_URL_PREFIX}/`)) {
    return null;
  }
  return `${SAVE_PATH}/public/${url.slice(PUBLIC_URL_PREFIX.length + 1)}`;
}

/**
 * Delete a file by its public URL
 */
export function deleteFileByUrl(url: string): void {
  const fullPath = fromPublicUrl(url);
  if (!fullPath) return;
  deleteFile(fullPath);
}
