import { jsPDF } from 'jspdf';
import { formatMemoryRecordedOrUpdated } from '../components/MemoryV3ItemList';
import type { MemoryV3ExportItem } from './memoryV3Viewer';

const PAGE_MARGIN = 15;
const LINE_HEIGHT = 6;
const PAGE_BREAK_Y = 280;
const WRAP_WIDTH = 180;

function topicLabel(topic: string | null): string {
  return topic ?? 'Без темы';
}

function addLine(doc: jsPDF, cursor: { y: number }, text: string, x: number, muted = false): void {
  if (cursor.y > PAGE_BREAK_Y) {
    doc.addPage();
    cursor.y = PAGE_MARGIN;
  }
  if (muted) doc.setTextColor(120);
  doc.text(text, x, cursor.y);
  if (muted) doc.setTextColor(0);
  cursor.y += LINE_HEIGHT;
}

function writeSection(doc: jsPDF, cursor: { y: number }, title: string, items: MemoryV3ExportItem[]): void {
  doc.setFontSize(14);
  addLine(doc, cursor, title, PAGE_MARGIN);
  cursor.y += LINE_HEIGHT * 0.5;
  doc.setFontSize(10);

  if (items.length === 0) {
    addLine(doc, cursor, 'Пусто.', PAGE_MARGIN, true);
    cursor.y += LINE_HEIGHT;
    return;
  }

  for (const item of items) {
    const claimText = `• ${item.claim}${item.kind === 'hypothesis' ? ' (гипотеза)' : ''}`;
    for (const line of doc.splitTextToSize(claimText, WRAP_WIDTH) as string[]) {
      addLine(doc, cursor, line, PAGE_MARGIN);
    }

    const timing = formatMemoryRecordedOrUpdated(item);
    const metaParts = [topicLabel(item.topic), timing].filter((part): part is string => Boolean(part));
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
 * не обрезался и не падал при длинной формулировке. */
export function downloadMemoryV3ExportAsPdf(
  data: { accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] },
): void {
  const doc = new jsPDF();
  const cursor = { y: PAGE_MARGIN };
  doc.setFontSize(16);
  addLine(doc, cursor, 'StaySee — моя память', PAGE_MARGIN);
  cursor.y += LINE_HEIGHT;

  writeSection(doc, cursor, 'Сквозная память', data.accountWide);
  writeSection(doc, cursor, 'Память бесед', data.dialogue);

  doc.save(`staysee-memory-export-${new Date().toISOString().slice(0, 10)}.pdf`);
}
