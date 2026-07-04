/**
 * Verbatim docx → markdown extraction for PR8 GPTs source snapshots.
 *
 * Place source files in docs/gpts-source/_source/ with exact names:
 *   Промт.docx
 *   Инструкция общения.docx
 *   Руководство для GPTs.docx
 *   Унак Методология Стэйси.docx
 *   Протокол организации сессий.docx
 *
 * Run: node scripts/extract-gpts-source-docx.mjs
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const ROOT = process.cwd();
const SOURCE_DIR = resolve(ROOT, "docs/gpts-source/_source");
const OUT_DIR = resolve(ROOT, "docs/gpts-source");

const MAP = [
  { docx: "Промт.docx", out: "01-promt.md" },
  { docx: "Инструкция общения.docx", out: "02-instrukciya-obshcheniya.md" },
  { docx: "Руководство для GPTs.docx", out: "03-rukovodstvo-gpts.md" },
  { docx: "Унак Методология Стэйси.docx", out: "04-unac-metodologiya.md" },
  { docx: "Протокол организации сессий.docx", out: "05-protokol-sessij.md" },
];

function extractDocxText(docxPath) {
  const tmp = join(tmpdir(), `gpts-docx-${randomBytes(4).toString("hex")}`);
  const zipCopy = join(tmpdir(), `gpts-docx-${randomBytes(4).toString("hex")}.zip`);
  copyFileSync(docxPath, zipCopy);
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipCopy.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force"`,
    { stdio: "pipe" }
  );
  const xmlPath = join(tmp, "word", "document.xml");
  const xml = readFileSync(xmlPath, "utf8");
  rmSync(tmp, { recursive: true, force: true });
  rmSync(zipCopy, { force: true });

  const paragraphs = xml.split(/<\/w:p>/i);
  const lines = [];
  for (const para of paragraphs) {
    const texts = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/gi)].map((m) => m[1]);
    if (texts.length === 0) continue;
    const line = texts.join("").replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n\n");
}

function headerBlock(sourceFilename) {
  const date = new Date().toISOString().slice(0, 10);
  return `# Source snapshot

- **source filename:** ${sourceFilename}
- **extraction date:** ${date}
- **extraction note:** verbatim extraction for PR8 source transplant

---

`;
}

let ok = 0;
let missing = 0;

for (const { docx, out } of MAP) {
  const src = join(SOURCE_DIR, docx);
  const dest = join(OUT_DIR, out);
  if (!existsSync(src)) {
    console.log(`SKIP (missing): ${docx}`);
    missing++;
    continue;
  }
  const body = extractDocxText(src);
  writeFileSync(dest, headerBlock(docx) + body + "\n", "utf8");
  console.log(`OK: ${out} ← ${docx} (${body.length} chars)`);
  ok++;
}

console.log(`\nExtracted ${ok}/${MAP.length}. Missing source files: ${missing}`);
if (missing > 0) {
  console.log(`Place docx in ${SOURCE_DIR} and re-run.`);
  process.exit(missing === MAP.length ? 1 : 0);
}
