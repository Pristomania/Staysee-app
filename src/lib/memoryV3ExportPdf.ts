import type { jsPDF } from 'jspdf';
import ptSansFontUrl from '../assets/fonts/PTSans-Regular.ttf';
import { formatMemoryRecordedOrUpdated } from './memoryV3Formatting';
import type { MemoryV3ExportData, MemoryV3ExportItem } from './memoryV3Viewer';

const PAGE_MARGIN = 15;
const LINE_HEIGHT = 6;
const PAGE_BREAK_Y = 280;
const WRAP_WIDTH = 180;
const FONT_FILE_NAME = 'PTSans-Regular.ttf';
const FONT_NAME = 'PTSans';

// jsPDF's built-in fonts (Helvetica/Times/Courier) only cover the PDF
// standard-14 WinAnsi range -- any Cyrillic text drawn with them comes out
// as unreadable mojibake, since jsPDF just writes raw UTF-16 code units
// into a one-byte WinAnsi string. Every piece of text in this export is
// Russian, so a real Unicode-capable font must be embedded before the
// first doc.text() call. PT Sans is SIL Open Font License (OFL-1.1),
// which explicitly permits bundling inside software like this.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function embedCyrillicFont(doc: jsPDF): Promise<void> {
  const response = await fetch(ptSansFontUrl);
  const buffer = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  doc.addFileToVFS(FONT_FILE_NAME, base64);
  doc.addFont(FONT_FILE_NAME, FONT_NAME, 'normal');
  doc.setFont(FONT_NAME);
}

function topicLabel(topic: string | null): string {
  return topic ?? 'Без темы';
}

function addLine(doc: jsPDF, cursor: { y: number }, text: string, x: number, muted = false): void {
  if (cursor.y > PAGE_BREAK_Y) {
    doc.addPage();
    cursor.y = PAGE_MARGIN;
    doc.setFont(FONT_NAME);
  }
  if (muted) doc.setTextColor(120);
  doc.text(text, x, cursor.y);
  if (muted) doc.setTextColor(0);
  cursor.y += LINE_HEIGHT;
}

function writeSection(
  doc: jsPDF,
  cursor: { y: number },
  title: string,
  items: MemoryV3ExportItem[],
  emptyMessage: string,
): void {
  doc.setFontSize(14);
  addLine(doc, cursor, title, PAGE_MARGIN);
  cursor.y += LINE_HEIGHT * 0.5;
  doc.setFontSize(10);

  if (items.length === 0) {
    addLine(doc, cursor, emptyMessage, PAGE_MARGIN, true);
    cursor.y += LINE_HEIGHT;
    return;
  }

  for (const item of items) {
    const claimText = `• ${item.claim}${item.kind === 'hypothesis' ? ' (гипотеза)' : ''}`;
    for (const line of doc.splitTextToSize(claimText, WRAP_WIDTH) as string[]) {
      addLine(doc, cursor, line, PAGE_MARGIN);
    }

    const timing = formatMemoryRecordedOrUpdated(item);
    const metaParts = [
      topicLabel(item.topic),
      item.sensitivity === 'sensitive' ? 'чувствительная запись' : null,
      item.conversationId ? `беседа: ${item.conversationId.slice(0, 8)}` : null,
      timing,
    ].filter((part): part is string => Boolean(part));
    if (metaParts.length > 0) {
      addLine(doc, cursor, metaParts.join(' · '), PAGE_MARGIN + 4, true);
    }

    if (item.alternative) {
      for (const line of doc.splitTextToSize(`Альтернатива: ${item.alternative}`, WRAP_WIDTH - 4) as string[]) {
        addLine(doc, cursor, line, PAGE_MARGIN + 4, true);
      }
    }

    cursor.y += LINE_HEIGHT * 0.5;
  }
}

/** Та же выгрузка, что downloadMemoryV3ExportAsJson, но версткой на бумагу --
 * разделы "Сквозная память" / "Память бесед", автоперенос длинного текста
 * (splitTextToSize) и новая страница при переполнении, чтобы ни один пункт
 * не обрезался и не падал при длинной формулировке. jsPDF и шрифт
 * подгружаются динамически здесь же, а не при открытии экрана Память, чтобы
 * не раздувать загрузку приложения для всех, кто ни разу не нажмёт эту
 * кнопку. */
export async function downloadMemoryV3ExportAsPdf(data: MemoryV3ExportData): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  await embedCyrillicFont(doc);

  const cursor = { y: PAGE_MARGIN };
  doc.setFontSize(16);
  addLine(doc, cursor, 'StaySee — моя память', PAGE_MARGIN);
  cursor.y += LINE_HEIGHT;

  writeSection(doc, cursor, 'Сквозная память', data.accountWide, 'Пусто.');
  writeSection(
    doc,
    cursor,
    'Память бесед',
    data.dialogue,
    data.dialogueAvailable ? 'Пусто.' : 'Сейчас недоступно для выгрузки.',
  );

  doc.save(`staysee-memory-export-${new Date().toISOString().slice(0, 10)}.pdf`);
}
