/**
 * Semantic crisis detection — second-pass check using a lightweight model.
 *
 * Runs AFTER the regex-based safety.ts classifier returns "normal".
 * Catches implied crisis: hopelessness, indirect self-harm intent, emotional
 * language that doesn't contain explicit trigger words.
 *
 * Fail-safe: any error returns false (never blocks a message on classifier failure).
 * Cost: ~1–3 tokens output, haiku-class model — negligible per message.
 */

const CLASSIFIER_SYSTEM_PROMPT = `Ты классификатор безопасности. Прочти сообщение пользователя и ответь ТОЛЬКО словом "да" или "нет".

Ответь "да" ТОЛЬКО если сообщение выражает:
— мысли о самоубийстве или желание умереть (прямо или косвенно)
— намерение причинить себе вред
— ощущение что жить незачем / незачем продолжать
— передозировку или угрозу физической безопасности для самого пользователя

Ответь "нет" при: грусти, злости, усталости, горе, боли, разочаровании — без угрозы жизни.`;

export async function semanticCrisisCheck(message: string): Promise<boolean> {
  if (message.trim().length < 8) return false;

  const apiKey = typeof Deno !== "undefined"
    ? Deno.env.get("OPENROUTER_API_KEY")
    : undefined;

  if (!apiKey) return false;

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
        model: "anthropic/claude-3.5-haiku",
        max_tokens: 3,
        temperature: 0,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: message.slice(0, 400) },
        ],
      }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content ?? "").toLowerCase().trim();
    return answer.startsWith("да");
  } catch {
    return false;
  }
}
