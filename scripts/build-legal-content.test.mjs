import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildLegalFiles, mdToPlainText, parseLegalDocument } from "./build-legal-content.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split("\r\n").join("\n");

describe("markdown to the plain text the app shows", () => {
  it("drops emphasis marks and rules, turns lists and tables into bullet lines, keeps link text", () => {
    const plain = mdToPlainText([
      "**Важно.** Это *очень* важно.",
      "",
      "---",
      "",
      "- первый пункт",
      "- второй [ссылка](https://example.test)",
      "",
      "| Категория | Состав |",
      "|---|---|",
      "| Email | адрес почты |",
      "| Фото | снимки |",
    ].join("\n"));
    assert.equal(
      plain,
      ["Важно. Это очень важно.", "", "• первый пункт", "• второй ссылка", "", "• Email — адрес почты", "• Фото — снимки"].join("\n"),
    );
  });

  it("keeps sub-headings as plain lines with a blank line before them", () => {
    assert.equal(mdToPlainText("Текст\n\n### 2.1. Данные\n\nещё текст"), "Текст\n\n2.1. Данные\n\nещё текст");
  });
});

describe("a legal document is split into titled sections", () => {
  it("reads the version, the date and the sections of a document with ## sections", () => {
    const doc = parseLegalDocument(
      "﻿# Политика\n## Сервис StaySee AI\n\n**Дата публикации:** 30 октября 2026 г.  \n**Редакция:** 1.2\n\n---\n\n## 1. Общие положения\n\nТекст один.\n\n---\n\n## 2. Данные\n\n- пункт\n",
      { splitLevel: 2 },
    );
    assert.equal(doc.title, "Политика");
    assert.equal(doc.subtitle, "Сервис StaySee AI");
    assert.equal(doc.version, "1.2");
    assert.equal(doc.effectiveDate, "30 октября 2026 г.");
    assert.deepEqual(doc.sections, [
      { title: "1. Общие положения", body: "Текст один." },
      { title: "2. Данные", body: "• пункт" },
    ]);
  });

  it("makes the opening of a consent (no heading of its own) the first section", () => {
    const doc = parseLegalDocument(
      "# Согласие\n## Сервис StaySee AI\n\n**Редакция:** 1.2  \n**Дата публикации:** 30 октября 2026 г.\n\n---\n\n**СОГЛАСИЕ НА ОБРАБОТКУ**\n\nЯ даю согласие.\n\n---\n\n### 1. Перечень\n\n- почта\n",
      { splitLevel: 3 },
    );
    assert.deepEqual(doc.sections[0], { title: "Согласие на обработку", body: "Я даю согласие." });
    assert.deepEqual(doc.sections[1], { title: "1. Перечень", body: "• почта" });
  });
});

describe("the texts in the app are the published documents", () => {
  const files = buildLegalFiles();

  it("are exactly what is committed in src/content/legal (run `npm run build:legal` after changing docs/legal)", () => {
    for (const [path, content] of Object.entries(files)) {
      assert.equal(read(path), content, `${path} is out of date`);
    }
  });

  it("have no drafting notes, placeholders or developer instructions, except the one field for the notification number", () => {
    for (const [path, content] of Object.entries(files)) {
      assert.doesNotMatch(content, /черновик|Рекомендуется консультация|TODO|готовится к публикации|Инструкция для разработчика|0\.1-draft/i, path);
      assert.doesNotMatch(content, /\[ \]/, `${path} has an open checklist`);
    }
    const policy = files["src/content/legal/privacy.ts"];
    assert.equal(policy.split("[заполнить дату и номер уведомления после его подачи]").length - 1, 1, "one field for the notification number");
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith("privacy.ts")) continue;
      assert.doesNotMatch(content, /\[заполнить/, path);
    }
  });

  it("say the same about pictures and about who receives the data", () => {
    for (const name of ["privacy.ts", "consent.ts"]) {
      const content = files[`src/content/legal/${name}`];
      assert.match(content, /Изображения|изображени/, `${name} mentions pictures`);
      for (const company of ["OpenRouter", "OpenAI", "Microsoft", "Google", "Anthropic", "Supabase"]) {
        assert.match(content, new RegExp(company), `${name} names ${company}`);
      }
      assert.match(content, /не хранит|не хранятся/, `${name} says pictures are not stored`);
    }
    assert.match(files["src/content/legal/privacy.ts"], /не использует изображения для распознавания/);
    assert.match(files["src/content/legal/consent.ts"], /не использует изображения для распознавания/);
  });

  it("carry the document's version and a hash of its text, for the consent log", () => {
    for (const [path, content] of Object.entries(files)) {
      assert.match(content, /"sha256": "[0-9a-f]{64}"/, path);
      assert.match(content, /"version": "\d+\.\d+"/, path);
    }
  });
});
