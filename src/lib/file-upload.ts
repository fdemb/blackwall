import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

const SAVE_PATH = "blackwall_data/uploads";

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
  return MIME_TO_EXT[file.type] ?? "";
}

type SaveFileOptions = {
  /** Directory path relative to public/ */
  directory: string;
  /** Prefix for the filename */
  prefix: string;
};

export async function saveFile(
  file: File,
  options: SaveFileOptions,
): Promise<string> {
  const ext = getExtension(file);
  const filename = `${options.prefix}-${Date.now()}${ext}`;

  const dirPath = join(SAVE_PATH, options.directory);
  const filePath = join(dirPath, filename);

  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }

  await Bun.write(filePath, file);

  return `/uploaded-files/${options.directory}/${filename}`;
}

export function deleteFile(uploadedFileUrl: string | null | undefined): void {
  if (
    !uploadedFileUrl ||
    uploadedFileUrl.startsWith("data:") ||
    !uploadedFileUrl.startsWith("/uploaded-files/")
  )
    return;

  // deletes /uploaded-files/ from the path
  const urlWithoutPrefix = uploadedFileUrl.split("/").slice(2).join("/");
  if (!urlWithoutPrefix) return;

  const filePath = join(SAVE_PATH, urlWithoutPrefix);

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {}
}
