/**
 * Semantic crisis detection — primary crisis check using a lightweight model.
 *
 * Runs for all messages (except prompt_attack / boundary_pressure).
 * Replaces the regex layer as the main crisis gate — understands context
 * ("мне приснилось", "3 года назад") that keywords cannot.
 *
 * Returns { isCrisis, failed }:
 *   failed: true  — API error; caller should fall back to regex for safety
 *   failed: false — answer is reliable
 * Cost: ~1–3 tokens output, approved utility model — negligible per message.
 */

import { resolveApprovedUtilityModel } from "./approvedModels.ts";

const CLASSIFIER_SYSTEM_PROMPT = `Ты классификатор безопасности. Прочти сообщение пользователя и ответь ТОЛЬКО словом "да" или "нет".

Ответь "да" ТОЛЬКО если сообщение выражает:
— мысли о самоубийстве или желание умереть (прямо или косвенно)
— намерение причинить себе вред
— ощущение что жить незачем / незачем продолжать
— передозировку или угрозу физической безопасности для самого пользователя

Ответь "нет" при: грусти, злости, усталости, горе, боли, разочаровании — без угрозы жизни.`;

export interface SemanticCrisisResult {
  isCrisis: boolean;
  /** true when the API call failed — caller should use regex fallback */
  failed: boolean;
}

export async function semanticCrisisCheck(message: string): Promise<SemanticCrisisResult> {
  if (message.trim().length < 8) return { isCrisis: false, failed: false };

  const apiKey = typeof Deno !== "undefined"
    ? Deno.env.get("OPENROUTER_API_KEY")
    : undefined;

  if (!apiKey) return { isCrisis: false, failed: true };

  const classifierModel = resolveApprovedUtilityModel(
    "STAYSEE_CRISIS_CLASSIFIER_MODEL",
  ).primary;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://staysee.app",
        "X-Title": "StaySee Safety Classifier",
      },
      body: JSON.stringify({
        model: classifierModel,
        max_tokens: 3,
        temperature: 0,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: message.slice(0, 400) },
        ],
      }),
    });

    if (!res.ok) return { isCrisis: false, failed: true };

    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content ?? "").toLowerCase().trim();
    return { isCrisis: answer.startsWith("да"), failed: false };
  } catch {
    return { isCrisis: false, failed: true };
  }
}
