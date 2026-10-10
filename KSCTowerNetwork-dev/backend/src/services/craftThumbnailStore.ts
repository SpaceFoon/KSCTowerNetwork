import sharp from "sharp";

export const CRAFT_THUMBNAIL_MAX_BYTES = 256 * 1024;
const IDLE_MS = 5 * 60_000;
const MAX_SESSIONS = 128;
type Thumbnail = { png: Buffer; craftName: string; updatedAtMs: number };
const thumbnails = new Map<string, Thumbnail>();

export async function normalizeCraftThumbnail(bytes: Buffer): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: 4_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error("Expected a PNG thumbnail");
  const png = await image.resize({ width: 960, height: 540, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  if (png.length > CRAFT_THUMBNAIL_MAX_BYTES) throw new Error("Normalized thumbnail exceeds size limit");
  return png;
}

export function putCraftThumbnail(sessionId: string, craftName: string, png: Buffer, now = Date.now()): void {
  for (const [id, entry] of thumbnails) if (now - entry.updatedAtMs > IDLE_MS) thumbnails.delete(id);
  thumbnails.delete(sessionId);
  if (thumbnails.size >= MAX_SESSIONS) thumbnails.delete(thumbnails.keys().next().value!);
  thumbnails.set(sessionId, { png, craftName, updatedAtMs: now });
}

export function getCraftThumbnail(sessionId: string, craftName: string, now = Date.now()): Thumbnail | null {
  const entry = thumbnails.get(sessionId);
  if (!entry) return null;
  if (now - entry.updatedAtMs > IDLE_MS) { thumbnails.delete(sessionId); return null; }
  return entry.craftName === craftName ? entry : null;
}
