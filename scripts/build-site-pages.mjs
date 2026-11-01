// Builds the public site's pages (tariffs, offer, app privacy policy, consent, contacts) into site-pages/.
// Those files are uploaded to the site (https://stayseeai.online) next to its index.html. The legal pages are
// rendered from docs/legal, so run `npm run build:site` after changing a document, a tariff or the layout.
// A test fails if the committed files are out of date.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildSitePages } from "./lib/site-pages.mjs";

const ROOT = new URL("../", import.meta.url);
const OUT_DIR = "site-pages";

export function readLegalDocs() {
  const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
  return {
    offer: read("docs/legal/ОФЕРТА-StaySee-2026-06-28.md"),
    privacy: read("docs/legal/ПОЛИТИКА-ПД-StaySee-2026-06-28.md"),
    consent: read("docs/legal/СОГЛАСИЕ-НА-ОПД-StaySee-2026-06-28.md"),
  };
}

export function buildAll() {
  return buildSitePages(readLegalDocs());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(new URL(`${OUT_DIR}/`, ROOT), { recursive: true });
  for (const [file, html] of Object.entries(buildAll())) {
    writeFileSync(new URL(`${OUT_DIR}/${file}`, ROOT), html, "utf8");
    console.log(`written ${OUT_DIR}/${file}`);
  }
}
