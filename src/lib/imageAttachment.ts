// Attaching a picture: it is opened in the browser, shrunk to a JPEG that fits the budget and shown as a small
// preview under the message box. Nothing leaves the device until Send. The budget is the server's
// (supabase/functions/_shared/imageAttachments.ts): three pictures of at most 1,000,000 base64 characters stay
// under the 4 MB the site proxy lets through.

export const IMAGE_MAX_COUNT = 3;
export const IMAGE_MAX_BASE64_CHARS = 1_000_000;
export const IMAGE_MAX_EDGE = 2_048;
/** Protects the browser from an enormous file; shrinking is what bounds what is sent. */
export const IMAGE_PICK_BYTES_LIMIT = 30 * 1024 * 1024;
export const IMAGE_PREPARE_DEADLINE_MS = 20_000;

export type ImageProblem = 'unsupported' | 'too_many' | 'too_big_file' | 'unreadable' | 'too_big';

export class ImageAttachmentError extends Error {
  readonly problem: ImageProblem;
  constructor(problem: ImageProblem) {
    super(problem);
    this.name = 'ImageAttachmentError';
    this.problem = problem;
  }
}

const PICTURE_ENDINGS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp'];

export function isImageFile(file: { type: string; name: string }): boolean {
  if (file.type.startsWith('image/')) return true;
  const dot = file.name.lastIndexOf('.');
  return dot !== -1 && PICTURE_ENDINGS.includes(file.name.slice(dot + 1).toLowerCase());
}

export function checkImageBeforeReading(file: { type: string; size: number }, alreadyAttached: number): ImageProblem | null {
  if (alreadyAttached >= IMAGE_MAX_COUNT) return 'too_many';
  if (file.size > IMAGE_PICK_BYTES_LIMIT) return 'too_big_file';
  return null;
}

/** The longest edge fits the maximum, the shape stays, a small picture is not enlarged, no edge becomes zero. */
export function scaleToFit(width: number, height: number, maxEdge: number = IMAGE_MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export interface Attempt {
  scale: number;
  quality: number;
}

/** From the best picture down. The first attempt that fits the budget is used. */
export const ATTEMPTS: Attempt[] = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.7 },
  { scale: 0.75, quality: 0.7 },
  { scale: 0.75, quality: 0.55 },
  { scale: 0.5, quality: 0.55 },
  { scale: 0.35, quality: 0.5 },
];

/** `encode` makes the base64 text for one attempt; the first one within the budget wins, null if none is. */
export async function fitToBudget(
  encode: (attempt: Attempt) => Promise<string>,
  budget: number = IMAGE_MAX_BASE64_CHARS,
): Promise<string | null> {
  for (const attempt of ATTEMPTS) {
    const data = await encode(attempt);
    if (data.length <= budget) return data;
  }
  return null;
}

export function imageProblemMessage(problem: ImageProblem): string {
  switch (problem) {
    case 'unsupported':
      return 'Такой файл не получится прикрепить как картинку. Подойдут обычные фото и скриншоты.';
    case 'too_many':
      return `К одному сообщению можно прикрепить до ${IMAGE_MAX_COUNT} картинок.`;
    case 'too_big_file':
      return 'Файл слишком большой. Попробуй другую картинку или сделай скриншот.';
    case 'too_big':
      return 'Эта картинка слишком тяжёлая даже после сжатия. Попробуй другую или сделай скриншот.';
    default:
      return 'Не получилось открыть картинку. Попробуй другую: лучше JPEG или PNG.';
  }
}

export interface PreparedImage {
  id: string;
  name: string;
  mime: 'image/jpeg';
  /** base64 without the `data:` prefix: what is sent */
  data: string;
  /** a `data:` address for the preview; never sent */
  previewUrl: string;
}

/** Opens the picture, shrinks it to a JPEG within the budget. Throws ImageAttachmentError. Browser only. */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  const work = (async (): Promise<PreparedImage> => {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new ImageAttachmentError('unreadable');
    }
    try {
      const canvas = document.createElement('canvas');
      const base = scaleToFit(bitmap.width, bitmap.height);
      const data = await fitToBudget(async ({ scale, quality }) => {
        const width = Math.max(1, Math.round(base.width * scale));
        const height = Math.max(1, Math.round(base.height * scale));
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new ImageAttachmentError('unreadable');
        context.fillStyle = '#ffffff'; // a transparent PNG must not turn black as a JPEG
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const url = canvas.toDataURL('image/jpeg', quality);
        return url.slice(url.indexOf(',') + 1);
      });
      if (data === null) throw new ImageAttachmentError('too_big');
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mime: 'image/jpeg',
        data,
        previewUrl: `data:image/jpeg;base64,${data}`,
      };
    } finally {
      bitmap.close();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ImageAttachmentError('unreadable')), IMAGE_PREPARE_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
