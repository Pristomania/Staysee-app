/**
 * Scoring for scripts/memory-continuity-eval.mjs: does Stacy stay coherent over a long
 * conversation, with and without the legacy conversation summary? Pure functions, so
 * the rules are tested offline (continuity-eval-checks.test.mjs) and the live script
 * only collects replies.
 *
 * Objective checks first (a corrected fact is used, a remembered name appears, a heavy
 * topic is not dragged up unprompted, no unsolicited list of advice); a judge model is
 * used only for what needs reading (did she return to an open decision, did she link to
 * an earlier success). A human reads blind pairs for tone, which no script can judge.
 */

// The conversation plants these threads (see TURNS in the live script); each probe is a new
// message sent after a three-day pause, long after the planted messages left the 18-message window.
export const PROBES = [
  {
    id: 'open_loop',
    message: 'Привет, я вернулась из отпуска. Как ты?',
    rubric: 'Человек раньше говорил, что решит после отпуска, продлевать ли контракт на работе в библиотеке. ' +
      'Вернулась ли ассистентка к этому незавершённому решению (напомнила или мягко предложила продолжить), а не ограничилась общим приветствием?',
  },
  {
    id: 'emotional_arc',
    message: 'Завтра опять важный разговор с начальницей, очень волнуюсь.',
    rubric: 'Раньше человек волновался перед выступлением, и оно прошло хорошо, ему аплодировали. ' +
      'Связала ли ассистентка нынешнее волнение с тем прошлым успехом (напомнила, что у человека уже получалось), а не отвечает так, будто это первый такой случай?',
  },
  { id: 'correction', message: 'Хочу съездить к сестре на выходные. Что взять с собой?' },
  { id: 'sensitive_not_raised', message: 'Подскажи, как лучше планировать неделю, чтобы всё успевать?' },
  { id: 'recall_cat', message: 'Напомни, как зовут мою кошку и сколько ей лет?' },
  { id: 'listen_first', message: 'Ужасный день: начальница накричала на меня при всех. Я просто хочу выговориться.' },
  {
    id: 'mother',
    message: 'Как ты думаешь, чего мама на самом деле хочет для меня?',
    rubric: 'Человек говорил, что мама считает, что ему стоит искать работу получше, а ему нравится его библиотека. ' +
      'Опирается ли ответ на этот известный факт о маме и работе, а не на общие рассуждения о мамах вообще?',
  },
  { id: 'thread_summary', message: 'Что мы с тобой уже обсуждали важного про меня?' },
];

const TOPICS = {
  work: /работ|библиотек|контракт/i,
  cat: /кошк|мус[яеюи]/i,
  sister: /сестр|(?<![а-яё])ан[яеюи](?![а-яё])|аней/i,
  presentation: /выступлен|аплодис|клуб/i,
  mother: /(?<![а-яё])мам[аеуыой]|мать|матер/i,
  running: /бег|пробеж/i,
  preference: /выслуш|советов|советы/i,
};

export function topicCoverage(reply) {
  const covered = Object.entries(TOPICS).filter(([, pattern]) => pattern.test(reply)).map(([topic]) => topic);
  return { covered, count: covered.length };
}

const ADVICE_LINE = /^\s*(\d+[.)]|[-•*])\s+/gm;

export function hardCheck(probeId, reply) {
  const text = String(reply ?? '');
  switch (probeId) {
    case 'correction': {
      const wrong = /казан/i.test(text);
      return { pass: !wrong, note: wrong ? 'named the old city (Kazan)' : /самар/i.test(text) ? 'used the corrected city' : 'avoided naming a city' };
    }
    case 'sensitive_not_raised': {
      const raised = /никому|не нужн|одинок|одиноч/i.test(text);
      return { pass: !raised, note: raised ? 'brought up the heavy topic unprompted' : 'did not raise it' };
    }
    case 'recall_cat': {
      const name = /мус[яиеюь]|мусей/i.test(text);
      const age = /(пять|(?<!\d)5(?!\d))\s*лет|пятилетн/i.test(text);
      return { pass: name && age, note: `name ${name ? 'yes' : 'no'}, age ${age ? 'yes' : 'no'}` };
    }
    case 'listen_first': {
      const lines = (text.match(ADVICE_LINE) ?? []).length;
      return { pass: lines < 2, note: `${lines} list item(s) of advice` };
    }
    default:
      return { pass: null, note: 'needs a judge' };
  }
}

// A judge model may wrap its JSON in prose or code fences; an unreadable answer is "unknown",
// never a pass.
export function parseJudgeVerdict(text) {
  const unknown = { pass: null, reason: '' };
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return unknown;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.pass !== 'boolean') return unknown;
    return { pass: parsed.pass, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return unknown;
  }
}

export function summarizeVariants({ on, off }) {
  const perProbe = {};
  const overall = { on: { passed: 0, total: 0 }, off: { passed: 0, total: 0 } };
  let undecided = 0;
  for (const [variant, samples] of [['on', on], ['off', off]]) {
    for (const sample of samples) {
      perProbe[sample.probe] ??= { on: { passed: 0, total: 0 }, off: { passed: 0, total: 0 } };
      if (sample.pass === null || sample.pass === undefined) {
        undecided += 1;
        continue;
      }
      perProbe[sample.probe][variant].total += 1;
      overall[variant].total += 1;
      if (sample.pass) {
        perProbe[sample.probe][variant].passed += 1;
        overall[variant].passed += 1;
      }
    }
  }
  return { perProbe, overall, undecided };
}

// Pairs for a person to read without knowing which reply came from which variant.
// `key` records the truth and is kept apart from the document.
export function buildBlindPairs(replies, probeIds, rng = Math.random) {
  const key = [];
  const parts = [
    '# Слепое сравнение ответов Стейси',
    '',
    'Для каждой пары прочитай сообщение человека и два ответа и отметь, какой ответ звучит лучше: живее, связнее, точнее для этой ситуации. ' +
      'Можно выбрать А, Б или «одинаково». Какой ответ откуда, ты не знаешь.',
    '',
  ];
  probeIds.forEach((probeId, index) => {
    const probe = PROBES.find((candidate) => candidate.id === probeId);
    const sourceOn = rng() < 0.5;
    const first = sourceOn ? 'on' : 'off';
    const second = sourceOn ? 'off' : 'on';
    key.push({ pair: index + 1, probe: probeId, A: first, B: second });
    const quote = (text) => String(text).split('\n').map((line) => `> ${line}`).join('\n');
    parts.push(
      `## Пара ${index + 1}`,
      '',
      `**Сообщение человека:** ${probe?.message ?? probeId}`,
      '',
      '**Ответ А**',
      '',
      quote(replies[probeId][first][0]),
      '',
      '**Ответ Б**',
      '',
      quote(replies[probeId][second][0]),
      '',
      '**Твой выбор:** А / Б / одинаково.  **Что заметила:**',
      '',
      '---',
      '',
    );
  });
  return { markdown: parts.join('\n'), key };
}
