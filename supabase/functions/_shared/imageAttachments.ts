/**
 * Photos and screenshots in the chat (design: docs/superpowers/specs/2026-10-29-image-attachments-design.md).
 *
 * The browser sends up to three small JPEGs with the message. Each is described once by a cheap vision model
 * (imageDescriber.ts); the description lines are added to the end of the message text, and from then on the
 * whole pipeline works on text. The picture itself goes to the answering model only in the main call of that
 * turn and is never stored or logged.
 */

export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGES_PER_DAY = 20;
/** One picture after the browser's compression, as base64 text. Three of them stay under the proxy's 4 MB. */
export const MAX_IMAGE_BASE64_CHARS = 1_000_000;
export const IMAGE_DESCRIPTION_MAX_CHARS = 600;
/** `ai_usage_logs.call_kind` of a description call; the daily limit counts these rows. */
export const IMAGE_CALL_KIND = "image_description";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ImageInput {
  mime: ImageMime;
  /** base64, without the `data:` prefix */
  data: string;
}

export type ImagesMode = "off" | "list" | "on";

/** Anything but `list` or `on` means off. */
export function resolveImagesMode(raw: string | null | undefined): ImagesMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "on" || value === "list" ? value : "off";
}

export function imagesAllowedForUser(mode: ImagesMode, userId: string, listRaw: string | null | undefined): boolean {
  if (mode === "on") return true;
  if (mode !== "list") return false;
  return (listRaw ?? "").split(",").map((id) => id.trim()).filter(Boolean).includes(userId);
}

export type ImageProblem = "too_many" | "bad_type" | "bad_data" | "too_big";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** What the first bytes say the picture is, or null. 16 base64 characters are 12 bytes. */
function sniffMime(data: string): ImageMime | null {
  let head: string;
  try {
    head = atob(data.slice(0, 16));
  } catch {
    return null;
  }
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff) return "image/jpeg";
  if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function validateImages(
  value: unknown,
): { ok: true; images: ImageInput[] } | { ok: false; problem: ImageProblem } {
  if (value === undefined || value === null) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, problem: "bad_data" };
  if (value.length > MAX_IMAGES_PER_MESSAGE) return { ok: false, problem: "too_many" };
  const images: ImageInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return { ok: false, problem: "bad_data" };
    const { mime, data } = item as Record<string, unknown>;
    if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return { ok: false, problem: "bad_type" };
    if (typeof data !== "string" || data.length < 16 || data.length % 4 !== 0) return { ok: false, problem: "bad_data" };
    if (data.length > MAX_IMAGE_BASE64_CHARS) return { ok: false, problem: "too_big" };
    if (!BASE64.test(data) || sniffMime(data) !== mime) return { ok: false, problem: "bad_data" };
    images.push({ mime, data });
  }
  return { ok: true, images };
}

/** One line, square brackets turned into round ones (they delimit the line), cut back to a whole sentence. */
export function cleanDescription(text: string): string {
  const line = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (line.length <= IMAGE_DESCRIPTION_MAX_CHARS) return line;
  const cut = line.slice(0, IMAGE_DESCRIPTION_MAX_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (stop > IMAGE_DESCRIPTION_MAX_CHARS / 2 ? cut.slice(0, stop + 1) : cut).trim();
}

/** The message text the whole pipeline reads: what the person typed, then one line per picture. */
export function appendPhotoBlocks(typedText: string, descriptions: readonly string[]): string {
  const lines = descriptions.map((description, index) => `[Фото ${index + 1}: ${cleanDescription(description)}]`);
  const head = typedText.trimEnd();
  return head.trim() === "" ? lines.join("\n") : `${head}\n\n${lines.join("\n")}`;
}

/** Models that take pictures in the main call. Everything else (and every repair call) gets text only. */
export function modelAcceptsImages(model: string): boolean {
  return /^(openai\/gpt-4o|anthropic\/claude|google\/gemini)/.test(model.trim());
}

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** The last user message becomes its text plus the pictures; all other messages are returned as they are. */
export function withImageParts<T extends { role: string; content: string }>(
  messages: readonly T[],
  images: readonly ImageInput[],
): Array<{ role: string; content: string | ModelContentPart[] }> {
  if (images.length === 0) return messages as unknown as Array<{ role: string; content: string }>;
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      last = i;
      break;
    }
  }
  if (last === -1) return messages as unknown as Array<{ role: string; content: string }>;
  return messages.map((message, index) =>
    index === last
      ? {
          role: message.role,
          content: [
            { type: "text" as const, text: message.content },
            ...images.map((image) => ({
              type: "image_url" as const,
              image_url: { url: `data:${image.mime};base64,${image.data}` },
            })),
          ],
        }
      : message,
  );
}
