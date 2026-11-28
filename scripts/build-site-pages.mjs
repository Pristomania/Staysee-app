// Builds the public site's pages (tariffs, offer, app privacy policy, consent, contacts) into site-pages/.
// Those files are uploaded to the site (https://stayseeai.online) next to its index.html. The legal pages are
// rendered from docs/legal, so run `npm run build:site` after changing a document, a tariff or the layout.
// A test fails if the committed files are out of date.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildSitePages } from "./lib/site-pages.mjs";
import { loadLegalDocs } from './lib/legal-documents.mjs';
import { parseLegalDocument } from './build-legal-content.mjs';
import { createHash } from 'node:crypto';

const ROOT = new URL("../", import.meta.url);
const OUT_DIR = "site-pages";

export function readLegalDocs() {
  return loadLegalDocs();
}

export function buildAll() {
  return buildSitePages(readLegalDocs());
}

/** Keep older files on publication: an already-open app must show the version whose hash it records. */
export function buildVersionedPages() {
  const docs = readLegalDocs();
  const pages = buildSitePages(docs);
  const pinned = {};
  for (const [key, file, splitLevel] of [['offer', 'offer', 2], ['privacy', 'app-privacy', 2], ['consent', 'consent', 3]]) {
    const version = parseLegalDocument(docs[key], {splitLevel}).version;
    const hash = createHash('sha256').update(docs[key]).digest('hex');
    pinned[`${file}-v${version}-${hash.slice(0, 12)}.html`] = pages[`${file}.html`];
  }
  return pinned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(new URL(`${OUT_DIR}/`, ROOT), { recursive: true });
  for (const [file, html] of Object.entries({...buildAll(), ...buildVersionedPages()})) {
    writeFileSync(new URL(`${OUT_DIR}/${file}`, ROOT), html, "utf8");
    console.log(`written ${OUT_DIR}/${file}`);
  }
}
