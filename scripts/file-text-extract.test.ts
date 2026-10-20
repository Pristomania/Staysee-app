import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import JSZip from 'jszip';
import * as mammothModule from 'mammoth/mammoth.browser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  DOCX_MAX_XML_BYTES,
  FileTextError,
  PDF_MAX_PAGES,
  extractDocxText,
  extractPdfText,
  readFileAsText,
} from '../src/lib/fileText.ts';

// Real Word and PDF files, built here, read through the same functions and the same libraries the browser uses
// (mammoth's browser build; pdf.js's legacy build). They prove the extraction itself; how the libraries are
// loaded in the page is checked by the site build.
const mammoth = ((mammothModule as { default?: unknown }).default ?? mammothModule) as Parameters<typeof extractDocxText>[1];

async function docxWithParagraphs(paragraphs: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`);
  return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

// A minimal PDF with one line of text per page (standard font, ASCII text).
function pdfWithPages(lines: string[]): ArrayBuffer {
  const objects: string[] = [];
  const pageIds = lines.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  lines.forEach((line, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 18 Tf 72 700 Td (${line}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

const loaders = {
  loadDocx: async () => mammoth,
  loadPdf: async () => pdfjs as never,
  loadZip: async () => JSZip as never,
};

describe('Word files', () => {
  it('gives the paragraphs of a .docx, in order, in Russian', async () => {
    const buffer = await docxWithParagraphs(['Первый абзац письма.', 'Второй абзац, про сестру Аню.']);
    const text = await extractDocxText(buffer, mammoth);
    assert.match(text, /Первый абзац письма\./);
    assert.match(text, /Второй абзац, про сестру Аню\./);
    assert.ok(text.indexOf('Первый') < text.indexOf('Второй'));
  });

  it('reads a picked .docx file end to end', async () => {
    const buffer = await docxWithParagraphs(['Текст из Word.']);
    const text = await readFileAsText(new File([buffer], 'письмо.docx'), loaders);
    assert.equal(text, 'Текст из Word.');
  });

  it('says the file cannot be read when it is not really a .docx', async () => {
    await assert.rejects(
      () => readFileAsText(new File(['это не zip'], 'сломанный.docx'), loaders),
      (error: unknown) => error instanceof FileTextError && error.problem === 'unreadable',
    );
  });
});

describe('PDF files', () => {
  it('gives the text of every page, in order', async () => {
    const text = await extractPdfText(pdfWithPages(['First page text', 'Second page text']), pdfjs as never);
    assert.match(text, /First page text/);
    assert.match(text, /Second page text/);
    assert.ok(text.indexOf('First') < text.indexOf('Second'));
  });

  it('reads a picked .pdf file end to end', async () => {
    const text = await readFileAsText(new File([pdfWithPages(['Hello from a PDF'])], 'file.pdf'), loaders);
    assert.equal(text, 'Hello from a PDF');
  });

  it('says the file cannot be read when it is not really a PDF', async () => {
    await assert.rejects(
      () => readFileAsText(new File(['просто текст'], 'сломанный.pdf'), loaders),
      (error: unknown) => error instanceof FileTextError && error.problem === 'unreadable',
    );
  });
});

describe('heavy Word files', () => {
  // A small .docx can unpack into a huge document.xml. It is refused by reading at most DOCX_MAX_XML_BYTES of the
  // real unpacked bytes (not by trusting the sizes the file declares), before anything is parsed.
  it('refuses a document.xml that unpacks beyond the limit, though the file itself is tiny', async () => {
    const buffer = await docxWithParagraphs(['а'.repeat(DOCX_MAX_XML_BYTES)]);
    assert.ok(buffer.byteLength < 200_000, `the file is only ${buffer.byteLength} bytes`);
    await assert.rejects(
      () => readFileAsText(new File([buffer], 'бомба.docx'), loaders),
      (error: unknown) => error instanceof FileTextError && error.problem === 'too_big',
    );
  });

  it('still reads an ordinary document of a few hundred kilobytes of XML', async () => {
    const buffer = await docxWithParagraphs(Array.from({ length: 2_000 }, (_, index) => `Абзац номер ${index}, про жизнь.`));
    const text = await readFileAsText(new File([buffer], 'длинный.docx'), loaders);
    assert.match(text, /Абзац номер 1999/);
  });
});

describe('heavy and leaking PDF files', () => {
  function stubPdf(options: { numPages: number; failOnPage?: number; destroyCalls: { count: number } }) {
    return {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: options.numPages,
          getPage: async (index: number) => {
            if (index === options.failOnPage) throw new Error('page failed');
            return { getTextContent: async () => ({ items: [{ str: `страница ${index}`, hasEOL: true }] }) };
          },
        }),
        destroy: async () => { options.destroyCalls.count += 1; },
      }),
    };
  }

  it('releases the document after reading, after a failure on a page, and after a failure to open it', async () => {
    const ok = { count: 0 };
    await extractPdfText(new ArrayBuffer(8), stubPdf({ numPages: 2, destroyCalls: ok }) as never);
    assert.equal(ok.count, 1);

    const failedPage = { count: 0 };
    await assert.rejects(() => extractPdfText(new ArrayBuffer(8), stubPdf({ numPages: 3, failOnPage: 2, destroyCalls: failedPage }) as never));
    assert.equal(failedPage.count, 1);

    const failedOpen = { count: 0 };
    await assert.rejects(() => extractPdfText(new ArrayBuffer(8), {
      getDocument: () => ({ promise: Promise.reject(new Error('not a pdf')), destroy: async () => { failedOpen.count += 1; } }),
    } as never));
    assert.equal(failedOpen.count, 1);
  });

  it('refuses a PDF with more pages than the limit, without reading a page, and still releases it', async () => {
    const calls = { count: 0 };
    await assert.rejects(
      () => extractPdfText(new ArrayBuffer(8), stubPdf({ numPages: PDF_MAX_PAGES + 1, destroyCalls: calls }) as never),
      (error: unknown) => error instanceof FileTextError && error.problem === 'too_many_pages',
    );
    assert.equal(calls.count, 1);
  });

  it('gives up on a file that never finishes reading, at the deadline', async () => {
    const never = { loadDocx: async () => mammoth, loadPdf: () => new Promise<never>(() => {}), loadZip: async () => JSZip as never };
    const started = Date.now();
    await assert.rejects(
      () => readFileAsText(new File([pdfWithPages(['x'])], 'вечный.pdf'), never, { deadlineMs: 50 }),
      (error: unknown) => error instanceof FileTextError && error.problem === 'unreadable',
    );
    assert.ok(Date.now() - started < 2_000);
  });
});
