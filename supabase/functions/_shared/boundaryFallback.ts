/**
 * Human boundary fallbacks — contextual, not a fixed emotion menu.
 * Prefer model output; static copy only when reply is clearly out of role.
 */

import { userImposedRoleOverride } from "./roleGuard.ts";
import { isRelationalLifeTurn } from "./safety.ts";

export type BoundaryFallbackTone =
  | "role_reset"
  | "joy"
  | "continuation"
  | "instrumental"
  | "compliance"
  | "frustration";

export function userFrustrationAtBot(text: string): boolean {
  const t = text.trim();
  return (
    /(?:бесишь|бесит|достал\w*|раздража\w*|злюсь\s+на\s+тебя|ненавижу\s+тебя)/i.test(t) ||
    /(?:ты\s+туп\w*|бесполезн|одно\s+и\s+то\s+же|шаблон|как\s+робот|отстань)/i.test(t) ||
    /(?:задолбал\w*|надоел\w*|выбесил\w*)/i.test(t)
  );
}

export function userDemandsCompliance(text: string): boolean {
  const t = text.trim();
  return (
    /(?:не\s+хочу\s+(?:ничего\s+)?рассказывать|не\s+буду\s+рассказывать)/i.test(t) ||
    /(?:делай|сделай)\s+что\s+я\s+скажу/i.test(t) ||
    /мне\s+надо\s+чтоб\w*\s+ты\s+делал/i.test(t) ||
    /ты\s+ии\b/i.test(t) ||
    /(?:выполняй|слушайся)\s+команд/i.test(t)
  );
}

export function detectBoundaryTone(userMessage: string): BoundaryFallbackTone {
  const t = userMessage.trim();
  if (!t) return "instrumental";
  if (isRelationalLifeTurn(t)) return "instrumental"; // unused when relational exempt
  if (userFrustrationAtBot(t)) return "frustration";
  if (userImposedRoleOverride(t)) return "role_reset";
  if (userDemandsCompliance(t)) return "compliance";
  if (/готовый\s+текст/i.test(t) || /^текст$/i.test(t)) return "instrumental";

  const wantsContinuation =
    /(?:дальше|продолж|следующ|допиши?|(?<!\p{L})пиши(?!\p{L})|напиши|погнали|ещё\s+день|следующий\s+день)/iu.test(
      t,
    );
  const soundsLight =
    /(?:^ок\b|погнали|давай|круто|ура|отлично|класс|супер|здорово|радост|получилось|вперёд|вперед)/i.test(
      t,
    );
  const soundsHeavy =
    /(?:страшно|боюсь|кризис|умер|суицид)/i.test(t);

  if (wantsContinuation && soundsLight && !soundsHeavy) return "joy";
  if (wantsContinuation) return "continuation";
  if (soundsLight && !soundsHeavy) return "joy";
  if (/(?:напиши|составь|сделай|сгенерируй|хочу\s+чтобы\s+ты|готовый)/i.test(t)) {
    return "instrumental";
  }
  return "instrumental";
}

const COPY: Record<BoundaryFallbackTone, string> = {
  role_reset:
    "Я остаюсь StaySee — не врач и не автор текстов по команде. Могу быть рядом с тем, что ты чувствуешь вокруг этой просьбы. Что для тебя сейчас важнее услышать от себя?",
  joy:
    "Слышу живость — хорошо. Готовый кусок за тебя не напишу, StaySee про тебя, не про сценарий. Что в этом «дальше» для тебя — радость, интерес, отдых?",
  continuation:
    "Поняла — хочется следующий кусок. Я не дописываю за тебя, но могу помочь услышать, зачем тебе это «дальше». Что там главное — движение, завершение, что-то ещё?",
  instrumental:
    "Похоже, нужен готовый текст под ключ — я так не работаю. Могу помочь понять, что за этой просьбой, без выдачи материала. Что ты хочешь получить, когда текст уже есть?",
  compliance:
    "Слышу: рассказывать не хочется, а хочется, чтобы я делала по команде. Я не исполнитель команд, но могу остаться рядом — что для тебя в этом важнее: контроль, усталость от разговоров, что-то ещё?",
  frustration:
    "Понимаю — бесит, когда снова не то, что просишь. Я не стану делать по команде, но могу ответить по-новому, без той же отбивки. Что сейчас раздражает сильнее — что нет готового текста или что я как робот?",
};

export function pickBoundaryFallback(
  userMessage: string,
  opts?: { wrongRoleInReply?: boolean }
): string {
  if (isRelationalLifeTurn(userMessage)) {
    return "";
  }
  if (opts?.wrongRoleInReply) {
    return COPY.role_reset;
  }
  return COPY[detectBoundaryTone(userMessage)];
}

/** True if static fallback would repeat the same script the user is rejecting. */
export function isStaleBoundaryScript(assistantText: string, fallback: string): boolean {
  const a = assistantText.toLowerCase();
  const f = fallback.toLowerCase();
  if (a.includes("готовые куски") && f.includes("готовые куски")) return true;
  if (a.includes("своими словами") && f.includes("своими словами")) return true;
  return false;
}
