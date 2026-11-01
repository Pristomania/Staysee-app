// Pages for the public site (https://stayseeai.online): tariffs, the offer, the app's privacy policy, the consent and
// the contacts. The app itself stays on https://staysee.ru and shows no prices: everything a buyer reads lives here.
// The legal pages are rendered from the same documents the app shows (docs/legal), so the two never drift apart.
// The look copies the site's existing document page (privacy.html). Authored copy follows the site's rule: no long dash.

export const SITE_URL = "https://stayseeai.online";
export const APP_URL = "https://staysee.ru/";

export const SELLER = {
  name: "Индивидуальный предприниматель Успенская Анастасия Сергеевна",
  short: "ИП Успенская Анастасия Сергеевна",
  inn: "332709365323",
  ogrnip: "321332800043821",
  address: "600022, Владимирская обл., г. Владимир, ул. Верхняя Дуброва, д. 23",
  email: "support.stayseeai@gmail.com",
};

/** The numbers must match supabase/migrations/*_085_usage_limits.sql (a test compares them). Premium is not sold yet. */
export const TARIFFS = {
  free: { messages: 50, renewMonths: 3 },
  basic: { priceRub: 1990, periodDays: 30, messages: 400 },
};

export const PAGES = [
  { file: "pricing.html", title: "Тарифы", nav: "Тарифы" },
  { file: "offer.html", title: "Договор-оферта", nav: "Договор-оферта" },
  { file: "app-privacy.html", title: "Политика обработки персональных данных приложения", nav: null },
  { file: "consent.html", title: "Согласие на обработку персональных данных", nav: null },
  { file: "contacts.html", title: "Контакты и реквизиты", nav: "Контакты" },
];

const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** "1 месяц", "3 месяца", "6 месяцев". */
const formatMonths = (count) => {
  const last = count % 10;
  const word = count % 100 >= 11 && count % 100 <= 14 ? "месяцев" : last === 1 ? "месяц" : last >= 2 && last <= 4 ? "месяца" : "месяцев";
  return `${count} ${word}`;
};
const formatRub = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

// ── Markdown (the subset docs/legal uses) to HTML ───────────────────────────────────────────────────────────

function inline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => keep(`<a href="${url}">${label}</a>`));
  s = s.replace(/https?:\/\/[^\s<)]*[^\s<).,;:!?*]/g, (url) => keep(`<a href="${url}">${url}</a>`));
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (mail) => keep(`<a href="mailto:${mail}">${mail}</a>`));
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)]);
}

/** Markdown to HTML. A numbered heading ("## 6. Возврат") gets id="sec-6", so another page can link to it. */
export function mdToHtml(md) {
  const lines = md.replace(/^﻿/, "").split(/\r?\n/);
  const out = [];
  const usedIds = new Set();
  let paragraph = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const html = paragraph
      .map((line, position) => {
        const last = position === paragraph.length - 1;
        return inline(line.trimEnd()) + (last ? "" : /\s{2,}$/.test(line) ? "<br>" : " ");
      })
      .join("");
    out.push(`<p>${html}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const number = /^(\d+)\.\s/.exec(text)?.[1];
      const id = number && !usedIds.has(number) ? ` id="sec-${number}"` : "";
      if (number) usedIds.add(number);
      out.push(`<h${level}${id}>${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*-{3,}\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushParagraph();
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(lines[index].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
        index += 1;
      }
      const hasHeader = rows.length > 1 && rows[1].every((cell) => /^:?-{2,}:?$/.test(cell));
      const head = hasHeader ? rows[0] : null;
      const body = hasHeader ? rows.slice(2) : rows;
      const cells = (row, tag) => row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join("");
      out.push(
        `<div class="table-wrap"><table>${head ? `<thead><tr>${cells(head, "th")}</tr></thead>` : ""}<tbody>${body
          .map((row) => `<tr>${cells(row, "td")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return out.join("\n    ");
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────────────────

const CSS = `
    :root{--bg:#0e1117;--panel:#161c27;--gold:#c9a96e;--light:#ece9e3;--text:#bec4cd;--muted:#8994a3;--line:rgba(42,53,69,.82)}
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.65 "Segoe UI Variable Text","Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
    a{color:var(--gold);text-underline-offset:3px}
    .shell{width:calc(100% - 40px);max-width:780px;margin:auto}
    header{padding:26px 0;border-bottom:1px solid var(--line)}
    header .shell{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px}
    .brand{color:var(--light);font-size:10px;letter-spacing:.26em;text-decoration:none;text-transform:uppercase}
    .nav{display:flex;flex-wrap:wrap;gap:6px 22px}
    .nav a{color:var(--muted);font-size:13px;text-decoration:none}
    .nav a:hover,.nav a[aria-current]{color:var(--gold)}
    main{padding:72px 0 90px}
    .eyebrow{margin:0 0 16px;color:var(--gold);font-size:10px;font-weight:650;letter-spacing:.2em;text-transform:uppercase}
    h1,h2,h3{color:var(--light);font-family:"Segoe UI Variable Display","Segoe UI",Arial,sans-serif;font-weight:350;letter-spacing:-.03em}
    h1{max-width:700px;margin:0 0 22px;font-size:clamp(34px,6vw,56px);line-height:1.06}
    h2{margin:42px 0 12px;font-size:25px;line-height:1.2}
    h3{margin:30px 0 10px;font-size:19px;line-height:1.25}
    p,li{color:var(--text)}
    strong{color:var(--light);font-weight:600}
    .lead{font-size:18px;color:#cbd0d7}
    .note{margin:30px 0;padding:20px;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--muted)}
    ul,ol{padding-left:22px}
    li{margin:6px 0}
    hr{margin:34px 0;border:0;border-top:1px solid var(--line)}
    .table-wrap{margin:22px 0;overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:15px}
    th,td{padding:11px 14px 11px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
    th{color:var(--gold);font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
    .details{display:grid;grid-template-columns:180px 1fr;margin:28px 0;border-top:1px solid var(--line)}
    .details div{padding:14px 0;border-bottom:1px solid var(--line)}
    .details div:nth-child(odd){color:var(--gold);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
    .plans{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:34px 0 26px}
    .plan{margin:0;padding:26px 24px 20px;border:1px solid var(--line);border-radius:20px;background:var(--panel)}
    .plan--main{border-color:rgba(201,169,110,.55)}
    .plan-name{margin:0 0 6px;color:var(--gold);font-size:11px;font-weight:650;letter-spacing:.18em;text-transform:uppercase}
    .price{margin:0 0 14px;color:var(--light);font:350 40px/1.1 "Segoe UI Variable Display","Segoe UI",Arial,sans-serif;letter-spacing:-.03em}
    .price span{color:var(--muted);font-size:15px;letter-spacing:0}
    .plan ul{margin:0;padding-left:20px}
    .btn{display:inline-block;padding:14px 26px;border:1px solid rgba(201,169,110,.55);border-radius:999px;color:var(--gold);font-size:15px;text-decoration:none;transition:background .2s}
    .btn:hover{background:rgba(201,169,110,.1)}
    footer{padding:34px 0 40px;border-top:1px solid var(--line);color:#788493;font-size:13px;line-height:1.6}
    footer .cols{display:grid;grid-template-columns:1fr 1fr;gap:30px}
    footer p{margin:0 0 4px;color:#788493}
    footer .foot-title{margin-bottom:10px;color:var(--gold);font-size:10px;font-weight:650;letter-spacing:.18em;text-transform:uppercase}
    footer a{display:block;margin:3px 0;color:#9aa5b3;text-decoration:none}
    footer a:hover{color:var(--gold)}
    footer .fine{margin-top:26px;font-size:11px}
    @media(max-width:640px){
      .shell *{overflow-wrap:anywhere}
      main{padding-top:52px}
      .details,.plans,footer .cols{grid-template-columns:1fr}
      .details div:nth-child(odd){padding-bottom:0;border-bottom:0}
    }`;

function layout({ file, title, description, eyebrow, body }) {
  const nav = PAGES.filter((page) => page.nav)
    .map((page) => `<a href="/${page.file}"${page.file === file ? ' aria-current="page"' : ""}>${page.nav}</a>`)
    .join("");
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index,follow">
  <meta name="theme-color" content="#0e1117">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/favicon-48.png" type="image/png" sizes="48x48">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
  <link rel="canonical" href="${SITE_URL}/${file}">
  <title>${esc(title)} · StaySee AI</title>
  <style>${CSS}
  </style>
</head>
<body>
  <header><div class="shell"><a class="brand" href="/">StaySee AI</a><nav class="nav" aria-label="Разделы">${nav}</nav></div></header>
  <main class="shell">
    <p class="eyebrow">${esc(eyebrow)}</p>
    ${body}
  </main>
  <footer>
    <div class="shell">
      <div class="cols">
        <div>
          <p class="foot-title">Документы</p>
          <a href="/pricing.html">Тарифы</a>
          <a href="/offer.html">Договор-оферта</a>
          <a href="/app-privacy.html">Политика обработки персональных данных приложения</a>
          <a href="/consent.html">Согласие на обработку персональных данных</a>
          <a href="/privacy.html">Политика обработки данных листа ожидания</a>
          <a href="/contacts.html">Контакты и реквизиты</a>
        </div>
        <div>
          <p class="foot-title">Продавец</p>
          <p>${esc(SELLER.short)}</p>
          <p>ИНН ${SELLER.inn} · ОГРНИП ${SELLER.ogrnip}</p>
          <p>${esc(SELLER.address)}</p>
          <p><a href="mailto:${SELLER.email}">${SELLER.email}</a></p>
        </div>
      </div>
      <p class="fine">StaySee AI · Оплата принимается через платёжный сервис Робокасса · Для лиц старше 18 лет</p>
    </div>
  </footer>
</body>
</html>
`;
}

// ── Authored pages ──────────────────────────────────────────────────────────────────────────────────────────────

function pricingBody() {
  const { free, basic } = TARIFFS;
  return `<h1>Тарифы StaySee AI</h1>
    <p class="lead">StaySee AI - приложение для спокойного разговора с ИИ-собеседником Стэйси. Объём тарифа измеряется в сообщениях: одно ваше сообщение вместе с ответом Стэйси считается за одно.</p>

    <div class="plans">
      <section class="plan">
        <p class="plan-name">Бесплатный</p>
        <p class="price">0&nbsp;₽</p>
        <ul>
          <li>${free.messages} сообщений</li>
          <li>новые ${free.messages} сообщений появляются через ${formatMonths(free.renewMonths)} после вашего последнего сообщения</li>
          <li>банковская карта не нужна</li>
        </ul>
      </section>
      <section class="plan plan--main">
        <p class="plan-name">Базовый</p>
        <p class="price">${formatRub(basic.priceRub)}&nbsp;₽ <span>за ${basic.periodDays} дней</span></p>
        <ul>
          <li>${basic.messages} сообщений на ${basic.periodDays} дней</li>
          <li>неиспользованные сообщения не переносятся на следующий период</li>
          <li>каждый период оплачивается отдельно, автоматических списаний нет</li>
        </ul>
      </section>
    </div>
    <p><a class="btn" href="${APP_URL}">Открыть приложение</a></p>

    <h2>Как это работает</h2>
    <ol>
      <li>Создайте учётную запись в приложении по адресу электронной почты и подтвердите её по ссылке из письма.</li>
      <li>Используйте ${free.messages} бесплатных сообщений. Платить для этого не нужно.</li>
      <li>Когда сообщения закончатся, приложение сообщит об этом. Чтобы продолжить сразу, оплатите тариф «Базовый». Или подождите: бесплатные сообщения возвращаются через ${formatMonths(free.renewMonths)} после вашего последнего сообщения.</li>
    </ol>

    <h2>Оплата и получение доступа</h2>
    <ul>
      <li>Оплата проходит через платёжный сервис Робокасса (ООО «Робо.Ру»). Способы оплаты, например банковские карты и СБП, определяет платёжный сервис.</li>
      <li>Это услуга в электронном виде, доставки нет. Доступ к оплаченному тарифу открывается автоматически на вашей учётной записи сразу после подтверждения оплаты.</li>
      <li>Кассовый чек приходит на адрес электронной почты, указанный при оплате.</li>
      <li>Стоимость указана в рублях. Изменение тарифов не затрагивает уже оплаченные периоды.</li>
    </ul>

    <h2>Возврат</h2>
    <p>В течение 3 календарных дней после первой оплаты можно запросить полный возврат, если за это время проведено не более 3 диалоговых сеансов. Напишите на <a href="mailto:${SELLER.email}">${SELLER.email}</a> с темой письма «Возврат». Возврат делается в течение 10 рабочих дней тем же способом, которым вы платили. Полные условия - в <a href="/offer.html#sec-6">разделе 6 договора-оферты</a>.</p>

    <h2>Важно знать</h2>
    <p class="note">StaySee AI не является психологической, психотерапевтической или медицинской помощью и не заменяет консультацию специалиста. Если вам тяжело, обратитесь к специалисту. Бесплатная психологическая помощь: телефон доверия 8-800-2000-122 (круглосуточно, звонок бесплатный). Сервис предназначен для лиц старше 18 лет.</p>
    <p>Подробнее об условиях: <a href="/offer.html">договор-оферта</a> и <a href="/contacts.html">контакты продавца</a>.</p>`;
}

function contactsBody() {
  return `<h1>Контакты и реквизиты</h1>
    <p class="lead">Если нужна помощь, вопрос по оплате или возврат, напишите на электронную почту. Ответ на письмо с претензией мы отправляем в течение 10 рабочих дней.</p>

    <div class="details">
      <div>Продавец</div><div>${esc(SELLER.name)}</div>
      <div>ИНН</div><div>${SELLER.inn}</div>
      <div>ОГРНИП</div><div>${SELLER.ogrnip}</div>
      <div>Адрес</div><div>${esc(SELLER.address)}</div>
      <div>Электронная почта</div><div><a href="mailto:${SELLER.email}">${SELLER.email}</a></div>
      <div>Сайт</div><div>stayseeai.online</div>
      <div>Приложение</div><div><a href="${APP_URL}">staysee.ru</a></div>
    </div>

    <h2>О чём писать</h2>
    <ul>
      <li>Возврат оплаты: тема письма «Возврат».</li>
      <li>Претензия: тема письма «Претензия».</li>
      <li>Вопросы по работе приложения, тарифам и оплате.</li>
      <li>Вопросы о персональных данных: подробности в <a href="/app-privacy.html">политике обработки персональных данных</a>.</li>
    </ul>`;
}

function documentBody(md) {
  const html = mdToHtml(md);
  // "# Title" then "## Subtitle": the subtitle reads as the page's lead line.
  return html.replace(/^(<h1>.*?<\/h1>)\s*<h2>(.*?)<\/h2>/s, '$1\n    <p class="lead">$2</p>');
}

/** All pages as { file: html }. `docs` carries the markdown of the three legal documents. */
export function buildSitePages(docs) {
  const description = {
    "pricing.html": "Тарифы StaySee AI: бесплатный на 50 сообщений и тариф «Базовый». Стоимость, состав, оплата и возврат.",
    "offer.html": "Договор-оферта сервиса StaySee AI.",
    "app-privacy.html": "Политика обработки персональных данных приложения StaySee AI.",
    "consent.html": "Согласие на обработку персональных данных при использовании приложения StaySee AI.",
    "contacts.html": "Контакты и реквизиты продавца сервиса StaySee AI.",
  };
  const bodies = {
    "pricing.html": { eyebrow: "Тарифы", body: pricingBody() },
    "offer.html": { eyebrow: "Документы", body: documentBody(docs.offer) },
    "app-privacy.html": { eyebrow: "Документы", body: documentBody(docs.privacy) },
    "consent.html": { eyebrow: "Документы", body: documentBody(docs.consent) },
    "contacts.html": { eyebrow: "Контакты", body: contactsBody() },
  };
  const pages = {};
  for (const page of PAGES) {
    pages[page.file] = layout({
      file: page.file,
      title: page.title,
      description: description[page.file],
      eyebrow: bodies[page.file].eyebrow,
      body: bodies[page.file].body,
    });
  }
  return pages;
}
