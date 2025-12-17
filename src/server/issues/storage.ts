import { join } from "node:path";

const SAVE_PATH = join(__dirname, "saved-files");

export async function saveFile(file: File) {
  const filename = `${file.name}_${Bun.randomUUIDv7()}`;
  const path = join(SAVE_PATH, filename);
  const buffer = await file.arrayBuffer();
  await Bun.write(filename, buffer);

  return path;
}
