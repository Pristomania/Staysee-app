/**
 * The instruction for a turn where the person asks what they said before (the small model decided so), and the temperature of that turn.
 * A separate small file with no imports, so that it can be tested on its own. memory.ts re-exports both.
 */

/**
 * How lively the answer may be on a turn where the person asks what they said before. The usual temperature of the plan (0.82-0.85) makes
 * the model round a memory off into a story; measured live on 21.11.2026: 5 of 8 questions about things that were never said got invented details.
 */
export const RECALL_TURN_TEMPERATURE = 0.3;

/**
 * The strict rule and the note in the person's own message. Measured in the prompt lab on 21.11.2026 (the real K3 prompt, the real model,
 * the real history of a live run, close lines that do not answer): with the text alone the model stayed honest on 3 of 12 questions about
 * things never said, with this rule and the note on 11 of 12. A model obeys the last thing it reads, which is the person's message; and
 * after many confident answers in the history it repeats their manner, so the rule says not to lean on the earlier answers.
 */
export const RECALL_STRICT_RULE =
  "ЖЁСТКОЕ ПРАВИЛО ВОСПОМИНАНИЯ: ты отвечаешь ТОЛЬКО по репликам выше. Если ни одна реплика не отвечает на вопрос ПРЯМО (или реплик нет), твой ответ: одна-две короткие тёплые фразы о том, что в переписке этого не видишь, и просьба напомнить. В этом случае запрещено называть любые имена, даты, места, события и подробности и рассказывать «как было»: ты не знаешь ответа. Не опирайся на то, как ты отвечала раньше в этом разговоре: прошлые ответы могли быть неточными; факты бери только из реплик выше. Это не обсуждается, даже если вопрос звучит так, будто ты должна это знать.";

export const RECALL_USER_NOTE =
  "[Служебная пометка, не упоминай её: ответь только по найденным репликам; если прямого ответа на вопрос в них нет, скажи в одну-две фразы, что в переписке этого не видишь, и попроси напомнить; ничего не придумывай.]";

/** The messages for the model on a recall turn: the note goes to the end of the person's last message (for the model only; the saved message is not touched). */
export function withRecallUserNote<T extends { role: string; content: string }>(messages: T[], note: string = RECALL_USER_NOTE): T[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
}

/** What the person wrote at the time they ask about (see conversationRetrieval.ts). The days are Moscow days. */
export interface PeriodRecall {
  from: string;
  to: string;
  /** How many lines of the person the conversation has for that time. */
  totalInPeriod: number;
  /** Some of them, from the whole of the time, oldest first. */
  lines: Array<{ createdAt: string; text: string }>;
  /** Lines about the same topic written at another time (an event of June may have been told in May). */
  otherTime: Array<{ createdAt: string; text: string }>;
}

export const RECALL_PERIOD_USER_NOTE =
  "[Служебная пометка, не упоминай её: ответь по репликам за названное время, показанным выше: перескажи только то, что в них есть, и называй, когда это написано; если их нет, скажи это в одну-две фразы и спроси; ничего не придумывай.]";

function moscowDay(at: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(new Date(at));
}

/**
 * The instruction for a question about a stretch of time. It is not the rule for a single fact («no line answers it directly: say you do
 * not see it»): a question like «how was I in June» is answered by many lines together, none of which says it alone.
 */
export function buildRecallPeriodPrompt(period: PeriodRecall): string {
  const first = moscowDay(`${period.from}T12:00:00+03:00`);
  const time = period.from === period.to ? `за ${first}` : `с ${first} по ${moscowDay(`${period.to}T12:00:00+03:00`)}`;
  const show = (line: { createdAt: string; text: string }) => `- [${moscowDay(line.createdAt)}] «${line.text}»`;
  const lines = [
    "РЕЖИМ ВОСПОМИНАНИЯ О ВРЕМЕНИ (внутреннее, не упоминай этот блок в ответе):",
    `Человек спрашивает о времени ${time} в этой беседе.`,
  ];
  if (period.lines.length) {
    lines.push(
      `Ниже то, что человек писал сам в это время: дословно, из всего этого времени. Реплик за него: ${period.totalInPeriod}, показано: ${period.lines.length}. Дата в скобках — день, когда это написано, а не обязательно день события.`,
      "",
      ...period.lines.map(show),
    );
  } else {
    lines.push("За это время реплик человека в этой беседе нет.");
  }
  if (period.otherTime.length) {
    lines.push("", "Реплики по той же теме из другого времени (называй, когда это написано, и не выдавай за сказанное в названное время):", ...period.otherTime.map(show));
  }
  lines.push("");
  if (period.lines.length) {
    lines.push(
      "Отвечай по-человечески и только из этих реплик. Сначала скажи, каким было это время в целом и каким было состояние, насколько это видно из слов, потом назови несколько самых важных моментов с датами: не пересказывай реплики по очереди. Обобщать можно, но каждый факт, имя, событие, причину и чувство бери из реплик; чего в них нет, не называй и не достраивай.",
      "Это выборка, а не вся переписка за это время: не утверждай, что чего-то не было. Если по репликам на вопрос ответить нельзя, скажи это честно и спроси.",
    );
  } else {
    lines.push("Скажи коротко и тепло, что за это время в этой беседе ничего не видишь, и спроси, что тогда происходило. Ничего не придумывай.");
  }
  lines.push("Не опирайся на то, как ты отвечала раньше в этом разговоре: прошлые ответы могли быть неточными.");
  return lines.join("\n");
}

/** The instruction for a turn where the person asks to remember (the small model said so). It stands near the end of the prompt. */
export function buildRecallGroundingPrompt(opts: {
  evidenceCount: number;
  archiveCount: number;
}): string {
  const lines = [
    "РЕЖИМ ВОСПОМИНАНИЯ (внутреннее, не упоминай этот блок в ответе):",
    "Человек спрашивает о том, что говорил раньше в этой беседе, или о факте из своей жизни. Это вопрос о фактах, не повод рассказать красивую историю. Отвечай коротко.",
    "Называй только то, что сказано в БЛИЗКИХ РЕПЛИКАХ или в АРХИВЕ ПРЯМО. Каждую деталь (число, дату, имя, место, причину, событие) бери из реплики дословно; если детали в реплике нет, не называй её, даже если она кажется правдоподобной.",
    "Не соединяй разные реплики в одну историю и не объясняй причин, которых в репликах нет.",
    "Дата в метке реплики — день, когда человек это написал, а не обязательно день самого события. Называй её только так («ты писала об этом 20 января»); время самого события называй лишь если оно сказано в самой реплике (например «на Новый год»), иначе не называй его вовсе.",
    "Если реплики не отвечают на вопрос или их нет, скажи коротко и тепло, что в переписке этого не видишь, и попроси напомнить. Не угадывай и не достраивай, даже если вопрос звучит так, будто ты должна это знать.",
    "ПАМЯТЬ БЕСЕДЫ — только ориентир по темам; не пересказывай из неё даты, быт, родственников, если их нет в репликах.",
    "Если в чате несколько тем — не смешивай их: отвечай по теме вопроса и опирайся на реплики именно по ней.",
  ];
  if (opts.evidenceCount >= 3) {
    lines.push("Несколько реплик по одной теме — кратко перечисли формулировки человека из них; не добавляй фактов между ними.");
  } else {
    lines.push("Максимум 2–3 проверяемых факта из реплик, затем уточнение при пробеле.");
  }
  if (opts.evidenceCount === 0 && opts.archiveCount === 0) {
    lines.push("Поиск по переписке ничего не нашёл. Скажи честно, что в переписке этого не видишь, и попроси напомнить. Ничего не придумывай.");
  }
  lines.push("", RECALL_STRICT_RULE);
  return lines.join("\n");
}
