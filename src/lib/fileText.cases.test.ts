import {
  FILE_MAX_BYTES,
  checkFileBeforeReading,
  decodeTextFile,
  fileExtension,
  fileProblemMessage,
  messageFromFileText,
  normalizeExtractedText,
  readFileAsText,
} from './fileText.ts';
import { MAX_MESSAGE_CHARS } from './messageLimits.ts';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// The extension decides what a file is, in lower case, with the last dot only.
assertEqual(fileExtension('Письмо.DOCX'), 'docx', 'upper case');
assertEqual(fileExtension('архив.tar.gz'), 'gz', 'last dot');
assertEqual(fileExtension('без_расширения'), '', 'no extension');

// Only text, Markdown, Word (.docx) and PDF are read; the old binary .doc, pictures and the rest are refused up front.
for (const name of ['a.txt', 'a.md', 'a.docx', 'a.pdf', 'Письмо.DOCX']) {
  assertEqual(checkFileBeforeReading(name, 1000), null, `${name} is readable`);
}
for (const name of ['a.doc', 'photo.png', 'x.xlsx', 'noext']) {
  assertEqual(checkFileBeforeReading(name, 1000), 'unsupported', `${name} is not readable`);
}
assertEqual(checkFileBeforeReading('a.pdf', FILE_MAX_BYTES), null, 'exactly the size limit');
assertEqual(checkFileBeforeReading('a.pdf', FILE_MAX_BYTES + 1), 'too_big', 'one byte over');

// Extracted text is tidied: line ends, invisible characters, runs of blank lines, trailing blanks.
assertEqual(normalizeExtractedText('a\r\nb\rc'), 'a\nb\nc', 'line ends');
assertEqual(normalizeExtractedText('a\u0000b\u200Bc\uFEFFd'), 'abcd', 'invisible characters');
assertEqual(normalizeExtractedText('a\n\n\n\n\nb'), 'a\n\nb', 'blank lines');
assertEqual(normalizeExtractedText('  привет  \n  мир \n'), 'привет\nмир', 'edges');
assertEqual(normalizeExtractedText('a\u00a0b'), 'a b', 'non-breaking space');

// A text file may be UTF-8 (with or without a mark) or the old Windows Cyrillic encoding.
const encoder = new TextEncoder();
assertEqual(decodeTextFile(encoder.encode('Привет, мир').buffer as ArrayBuffer), 'Привет, мир', 'utf-8');
assertEqual(
  decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('Привет')]).buffer as ArrayBuffer),
  'Привет',
  'utf-8 with a mark',
);
assertEqual(
  decodeTextFile(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).buffer as ArrayBuffer),
  'Привет',
  'windows-1251',
);

// The text becomes a message with a line saying where it came from, and the limit applies to the whole message.
const ok = messageFromFileText('письмо.docx', 'Текст письма.');
assertEqual(ok, { ok: true, message: 'Из файла «письмо.docx»:\n\nТекст письма.' }, 'message');
assertEqual(messageFromFileText('a.txt', '   \n  '), { ok: false, problem: 'empty', length: 0 }, 'empty file');
const header = 'Из файла «a.txt»:\n\n';
const fits = messageFromFileText('a.txt', 'а'.repeat(MAX_MESSAGE_CHARS - header.length));
assertEqual(fits.ok, true, 'exactly the maximum fits');
const tooLong = messageFromFileText('a.txt', 'а'.repeat(MAX_MESSAGE_CHARS - header.length + 1));
assertEqual(tooLong.ok, false, 'one over does not fit');
assertEqual((tooLong as { problem: string }).problem, 'too_long', 'problem is too_long');
assertEqual((tooLong as { length: number }).length, MAX_MESSAGE_CHARS + 1, 'length counts the whole message');

// Plain words for each problem, with the numbers that matter.
assertEqual(fileProblemMessage('unsupported'), 'Такой файл я не умею читать. Подойдут .txt, .md, .docx и .pdf с текстом.', 'unsupported');
assertEqual(fileProblemMessage('too_big'), 'Файл слишком большой: больше 5 МБ.', 'too big');
assertEqual(fileProblemMessage('empty'), 'В файле нет текста. Если это скан или картинка, прочитать его пока нельзя.', 'empty');
assertEqual(fileProblemMessage('unreadable'), 'Не получилось прочитать файл. Попробуй другой или вставь текст вручную.', 'unreadable');
assertEqual(
  fileProblemMessage('too_long', 12_340),
  'В файле 12\u00a0340 символов, а в одном сообщении можно не больше 10\u00a0000. Раздели файл на части.',
  'too long',
);

// Text and Markdown files are read here; the file name and the size are checked before anything is read.
const note = new File(['Привет\r\n\r\n\r\nмир'], 'заметка.md', { type: 'text/markdown' });
assertEqual(await readFileAsText(note), 'Привет\n\nмир', 'markdown file');
const plain = new File([new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])], 'старый.txt');
assertEqual(await readFileAsText(plain), 'Привет', 'windows-1251 text file');
let refused = '';
try {
  await readFileAsText(new File(['x'], 'картинка.png'));
} catch (error) {
  refused = (error as { problem?: string }).problem ?? 'no problem field';
}
assertEqual(refused, 'unsupported', 'an unsupported file is refused with its reason');

console.log('fileText: all checks passed');
