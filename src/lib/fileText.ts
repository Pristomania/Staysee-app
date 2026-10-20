// Attaching a file means turning it into text in the browser and putting that text into the message box, as if the
// person had pasted it. Nothing but the text leaves the device, and the usual rules apply from there: at most
// 10,000 characters per message (messageLimits.ts), the person sees the whole text in the chat, the model reads it
// in full for ten replies and then as a short version (supabase/functions/_shared/longMessages.ts).
import { MAX_MESSAGE_CHARS } from './messageLimits';

/** Protects the browser from a huge file; the 10,000-character limit on the text is what really bounds a file. */
export const FILE_MAX_BYTES = 5 * 1024 * 1024;

const READABLE_EXTENSIONS = new Set(['txt', 'md', 'docx', 'pdf']);

export type FileTextProblem = 'unsupported' | 'too_big' | 'unreadable' | 'empty' | 'too_long';

export class FileTextError extends Error {
  readonly problem: FileTextProblem;
  readonly length: number | undefined;

  constructor(problem: FileTextProblem, length?: number) {
    super(problem);
    this.name = 'FileTextError';
    this.problem = problem;
    this.length = length;
  }
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** What can be told from the name and the size alone, before anything is read. */
export function checkFileBeforeReading(name: string, size: number): FileTextProblem | null {
  if (!READABLE_EXTENSIONS.has(fileExtension(name))) return 'unsupported';
  if (size > FILE_MAX_BYTES) return 'too_big';
  return null;
}

/** Line ends, invisible characters, runs of blank lines and trailing blanks. */
export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- a NUL character from a badly saved file has to go
    .replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** UTF-8 (with or without a mark), else the old Windows Cyrillic encoding that many Russian text files still use. */
export function decodeTextFile(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** The message that goes into the box: where the text came from, then the text. The limit counts all of it. */
export function messageFromFileText(
  name: string,
  text: string,
): { ok: true; message: string } | { ok: false; problem: 'empty' | 'too_long'; length: number } {
  const body = text.trim();
  if (body === '') return { ok: false, problem: 'empty', length: 0 };
  const message = `Из файла «${name}»:\n\n${body}`;
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, problem: 'too_long', length: message.length };
  return { ok: true, message };
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

export function fileProblemMessage(problem: FileTextProblem, length?: number): string {
  switch (problem) {
    case 'unsupported':
      return 'Такой файл я не умею читать. Подойдут .txt, .md, .docx и .pdf с текстом.';
    case 'too_big':
      return `Файл слишком большой: больше ${FILE_MAX_BYTES / (1024 * 1024)} МБ.`;
    case 'empty':
      return 'В файле нет текста. Если это скан или картинка, прочитать его пока нельзя.';
    case 'too_long':
      return `В файле ${groupDigits(length ?? 0)} символов, а в одном сообщении можно не больше ${groupDigits(MAX_MESSAGE_CHARS)}. Раздели файл на части.`;
    default:
      return 'Не получилось прочитать файл. Попробуй другой или вставь текст вручную.';
  }
}

// ── Word and PDF: the libraries are loaded only when such a file is picked ─────────────────────────────────────

/** The part of mammoth (Word) used here. */
export interface MammothLike {
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}

/** The part of pdf.js used here. */
export interface PdfJsLike {
  getDocument(source: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(index: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      }>;
    }>;
  };
}

export interface FileTextLoaders {
  loadDocx(): Promise<MammothLike>;
  loadPdf(): Promise<PdfJsLike>;
}

export async function extractDocxText(buffer: ArrayBuffer, mammoth: MammothLike): Promise<string> {
  return (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
}

// Reading stops once the text is clearly beyond the limit: the file is refused anyway.
const PDF_TEXT_CEILING = MAX_MESSAGE_CHARS * 3;

export async function extractPdfText(buffer: ArrayBuffer, pdfjs: PdfJsLike): Promise<string> {
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  let total = 0;
  for (let index = 1; index <= document.numPages && total <= PDF_TEXT_CEILING; index += 1) {
    const content = await (await document.getPage(index)).getTextContent();
    const text = content.items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`).join('');
    pages.push(text);
    total += text.length;
  }
  return pages.join('\n\n');
}

// Each library is loaded once, the first time such a file is picked. The PDF worker is bundled by the site build as
// a .js file (a separate .mjs asset would depend on the web server's MIME types).
let docxLibrary: Promise<MammothLike> | null = null;
let pdfLibrary: Promise<PdfJsLike> | null = null;

const defaultLoaders: FileTextLoaders = {
  loadDocx: () => {
    docxLibrary ??= import('mammoth/mammoth.browser').then(
      (module) => (module.default ?? module) as MammothLike,
    );
    return docxLibrary;
  },
  loadPdf: () => {
    pdfLibrary ??= Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerPort = new worker.default();
      return pdfjs as unknown as PdfJsLike;
    });
    return pdfLibrary;
  },
};

/** Reads a picked file as text. Throws FileTextError with the reason, which fileProblemMessage turns into words. */
export async function readFileAsText(file: File, loaders: FileTextLoaders = defaultLoaders): Promise<string> {
  const early = checkFileBeforeReading(file.name, file.size);
  if (early !== null) throw new FileTextError(early);
  try {
    const buffer = await file.arrayBuffer();
    const extension = fileExtension(file.name);
    let text: string;
    if (extension === 'docx') text = await extractDocxText(buffer, await loaders.loadDocx());
    else if (extension === 'pdf') text = await extractPdfText(buffer, await loaders.loadPdf());
    else text = decodeTextFile(buffer);
    return normalizeExtractedText(text);
  } catch {
    throw new FileTextError('unreadable');
  }
}
