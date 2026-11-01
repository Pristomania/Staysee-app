import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildAll } from "./build-site-pages.mjs";
import { PAGES, SELLER, TARIFFS, mdToHtml } from "./lib/site-pages.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split("\r\n").join("\n");
const pages = buildAll();

describe("markdown to the html the site shows", () => {
  it("makes headings, numbered anchors, bold text, lists and links", () => {
    const html = mdToHtml("# Title\n## Sub\n\n## 6. Возврат\n\n**6.1.** Текст с [ссылкой](https://example.com/x) и почтой a.b@example.com.\n\n- один\n- два\n");
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<h2 id="sec-6">6\. Возврат<\/h2>/);
    assert.match(html, /<strong>6\.1\.<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com\/x">ссылкой<\/a>/);
    assert.match(html, /<a href="mailto:a\.b@example\.com">a\.b@example\.com<\/a>/);
    assert.match(html, /<ul><li>один<\/li><li>два<\/li><\/ul>/);
  });

  it("makes tables with a header, and keeps a hard line break", () => {
    const html = mdToHtml("| Поле | Значение |\n|---|---|\n| ИНН | 123 |\n\nстрока один  \nстрока два\n");
    assert.match(html, /<th>Поле<\/th><th>Значение<\/th>/);
    assert.match(html, /<td>ИНН<\/td><td>123<\/td>/);
    assert.match(html, /строка один<br>строка два/);
    assert.doesNotMatch(html, /\|---/);
  });

  it("escapes html in the text", () => {
    assert.match(mdToHtml("a < b & c > d"), /a &lt; b &amp; c &gt; d/);
  });

  it("leaves no markdown marks in the three legal pages", () => {
    for (const file of ["offer.html", "app-privacy.html", "consent.html"]) {
      const body = pages[file].split("<main")[1];
      assert.doesNotMatch(body, /\*\*/, `${file}: bold marks left`);
      assert.doesNotMatch(body, /\|\s*---/, `${file}: table marks left`);
    }
  });
});

describe("every page carries what a buyer and the payment service must see", () => {
  for (const { file } of PAGES) {
    it(`${file}: seller details, contact, the other documents, a canonical address`, () => {
      const html = pages[file];
      assert.ok(html.startsWith("<!doctype html>"), "a doctype, so the page does not open in quirks mode");
      assert.match(html, /<html lang="ru">/);
      assert.match(html, /name="viewport"/);
      assert.match(html, new RegExp(`<link rel="canonical" href="https://stayseeai\\.online/${file.replace(".", "\\.")}">`));
      assert.ok(html.includes(SELLER.inn) && html.includes(SELLER.ogrnip), "ИНН and ОГРНИП in the footer");
      assert.ok(html.includes(SELLER.email));
      for (const link of ["/pricing.html", "/offer.html", "/app-privacy.html", "/consent.html", "/contacts.html", "/privacy.html"]) {
        assert.ok(html.includes(`href="${link}"`), `${file} links to ${link}`);
      }
    });
  }

  it("the tariffs page states the price, the amount of messages and the terms", () => {
    const html = pages["pricing.html"];
    assert.ok(html.includes("1 990"), "price 1 990");
    assert.match(html, /400 сообщений на 30 дней/);
    assert.match(html, /50 сообщений/);
    assert.match(html, /Робокасса/);
    assert.match(html, /Возврат/);
    assert.match(html, /href="https:\/\/staysee\.ru\/"/, "the way into the app");
    assert.match(html, /href="\/offer\.html#sec-6"/);
    assert.ok(pages["offer.html"].includes('id="sec-6"'), "the refund section the tariffs page links to exists");
  });

  it("the tariffs page shows the premium plan and promises nothing that does not exist yet", () => {
    const html = pages["pricing.html"];
    assert.match(html, /Премиум/);
    assert.ok(html.includes("4 900"), "premium price");
    assert.match(html, /1 000 сообщений на 30 дней/);
    assert.match(html, /6 бесед/);
    // the AI voice input of premium is not built: the site must not promise it
    assert.doesNotMatch(html, /ввод[а-я]* с ИИ|распознавани[а-я]* с ИИ|ИИ-ввод/i);
    // the top-up pack is not built either
    assert.doesNotMatch(html, /докуп|пакет/i);
  });

  it("each card shows what the plan gives and, marked closed, what it does not", () => {
    const card = (id) => new RegExp(`<section class="plan[^"]*" data-plan="${id}">[^]*?</section>`).exec(pages["pricing.html"])?.[0] ?? "";
    const free = card("free");
    for (const closed of ["Сквозная память", "Динамика бесед", "Прикрепление файлов", "Голосовой ввод"]) {
      assert.match(free, new RegExp(`<li class="off">${closed}</li>`), `free: ${closed} is shown closed`);
      assert.match(card("basic"), new RegExp(`<li class="on">${closed}</li>`), `basic: ${closed}`);
      assert.match(card("premium"), new RegExp(`<li class="on">${closed}</li>`), `premium: ${closed}`);
    }
    assert.match(free, /<li class="on">1 беседа<\/li>/);
    assert.match(card("basic"), /<li class="on">3 беседы<\/li>/);
    assert.match(card("premium"), /<li class="on">6 бесед<\/li>/);
  });

  it("the authored pages use no long dash (the site's rule)", () => {
    for (const file of ["pricing.html", "contacts.html"]) {
      assert.doesNotMatch(pages[file].split("<main")[1].split("</main>")[0], /—|–/, file);
    }
  });

  it("no page promises something the offer does not say: auto-renewal", () => {
    assert.match(pages["pricing.html"], /автоматических списаний нет/);
    assert.match(pages["offer.html"], /Автоматическое списание денежных средств не производится/);
  });
});

describe("the site and the app agree on the numbers", () => {
  it("the tariffs match the limits the database enforces (migration 085)", () => {
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const file = readdirSync(dir).find((name) => name.endsWith("_085_usage_limits.sql"));
    assert.ok(file, "migration 085 exists");
    const sql = readFileSync(new URL(file, dir), "utf8");
    const free = /\(\s*'free'\s*,\s*'lifetime'\s*,\s*(\d+)\s*,/.exec(sql);
    const basic = /\(\s*'basic'\s*,\s*'month'\s*,\s*(\d+)\s*,/.exec(sql);
    assert.equal(Number(free?.[1]), TARIFFS.free.messages, "free messages");
    assert.equal(Number(basic?.[1]), TARIFFS.basic.messages, "basic messages");
    assert.equal(TARIFFS.basic.periodDays, 30, "the month plan renews after 30 days in the database");
    assert.match(sql, /interval\s+'30 days'/);
  });

  it("the free messages come back after the same number of months in the page, the offer and the database (migration 086)", () => {
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const file = readdirSync(dir).find((name) => name.endsWith("_086_free_tariff_renewal.sql"));
    assert.ok(file, "migration 086 exists");
    const sql = readFileSync(new URL(file, dir), "utf8");
    const months = /SET renew_after_idle_months\s*=\s*(\d+)\s+WHERE tier\s*=\s*'free'/i.exec(sql);
    assert.equal(Number(months?.[1]), TARIFFS.free.renewMonths, "months in the database and on the page");
    assert.match(pages["pricing.html"], /бесплатные сообщения возвращаются через 3 месяца после вашего последнего сообщения/);
    assert.match(pages["pricing.html"], /новые через 3 месяца после последнего/);
    assert.match(pages["pricing.html"], /Бесплатный/);
    assert.doesNotMatch(pages["pricing.html"], /один раз на учётную запись/, "the old one-time promise is gone");
    assert.match(pages["offer.html"], /возобновляются через 3 \(три\) месяца после последнего сообщения Пользователя/);
  });

  it("the offer names the site and the app, in the first clause and in the requisites", () => {
    const html = pages["offer.html"];
    const clause11 = /<strong>1\.1\.<\/strong>[^]*?<\/p>/.exec(html)?.[0] ?? "";
    assert.match(clause11, /href="https:\/\/staysee\.ru">https:\/\/staysee\.ru<\/a>[^]*«Приложение»/, "the app address in 1.1");
    assert.match(clause11, /href="https:\/\/stayseeai\.online">https:\/\/stayseeai\.online<\/a>[^]*«Сайт»/, "the site address in 1.1");
    assert.match(html, /<td>Сайт<\/td><td><a href="https:\/\/stayseeai\.online">/);
    assert.match(html, /<td>Приложение<\/td><td><a href="https:\/\/staysee\.ru">/);
    assert.match(html, /href="https:\/\/stayseeai\.online\/pricing\.html"/, "5.1 names the tariff page");
  });
});

describe("the published pages are the committed ones", () => {
  it("are exactly what is in site-pages (run `npm run build:site` after changing docs/legal or the layout)", () => {
    for (const [file, html] of Object.entries(pages)) {
      assert.equal(read(`site-pages/${file}`), html, `site-pages/${file} is out of date`);
    }
  });
});
