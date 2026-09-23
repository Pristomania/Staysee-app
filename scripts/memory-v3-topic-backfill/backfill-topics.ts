/**
 * One-time backfill: classifies a topic for every Memory V3 lifecycle and
 * dialogue item that doesn't have one yet (pre-existing items from before
 * this feature shipped). Run once by hand -- see README.md in this
 * directory for the exact command. Never wired into the live pipeline.
 */

import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { MEMORY_V3_LIFECYCLE_TOPICS } from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import { MEMORY_V3_DIALOGUE_TOPICS } from '../../supabase/functions/_shared/memoryV3/dialogueContract.ts';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.7-flash';

interface ClassifyInput {
  claim: string;
  kind: 'event' | 'recurrence' | 'hypothesis';
  scopeLabel: string;
  topics: readonly string[];
}

export function buildSchema(topics: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['topic'],
    properties: {
      topic: { type: 'string', enum: [...topics] },
    },
  };
}

async function classifyTopic(input: ClassifyInput, apiKey: string): Promise<{
  topic: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}> {
  const system = `You classify one existing StaySEE memory claim into exactly one topic.
Topics for ${input.scopeLabel}: ${input.topics.join(', ')}.
Return JSON only, matching the given schema. Pick the single best-fitting topic; never invent a value outside the given list.`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ claim: input.claim, kind: input.kind }) },
    ],
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'topic_backfill_response', strict: true, schema: buildSchema(input.topics) },
    },
    reasoning: { effort: 'low' },
    provider: { allow_fallbacks: true, require_parameters: true, data_collection: 'deny', zdr: true },
    // 50 was too tight: low-effort reasoning still consumes some of the
    // budget before the JSON answer, and a real run hit this -- the model
    // fell back to a prose explanation instead of the strict schema
    // response, which then failed JSON.parse with no diagnostic content.
    // Production's reconciler call budgets 1_200 for a much larger
    // response; this one-field classification needs far less, but not this
    // little.
    max_tokens: 300,
    usage: { include: true },
  };
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices[0].message.content as string;
  let parsed: { topic: string };
  try {
    parsed = JSON.parse(content) as { topic: string };
  } catch {
    throw new Error(`Model response was not valid JSON. Raw content: ${content.slice(0, 500)}`);
  }
  if (!input.topics.includes(parsed.topic)) {
    throw new Error(`Model returned a topic outside the allowed list: ${parsed.topic}. Raw content: ${content.slice(0, 500)}`);
  }
  const usage = data.usage ?? {};
  return {
    topic: parsed.topic,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    costUsd: typeof usage.cost === 'number' ? usage.cost : 0,
  };
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!supabaseUrl || !serviceKey || !apiKey) {
    throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENROUTER_API_KEY before running this script.');
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: lifecycleItems, error: lifecycleError } = await supabase
    .from('memory_v3_lifecycle_shadow_items')
    .select('user_id, memory_key, claim, kind')
    .is('topic', null);
  if (lifecycleError) throw lifecycleError;

  const { data: dialogueItems, error: dialogueError } = await supabase
    .from('memory_v3_dialogue_items')
    .select('user_id, conversation_id, memory_key, claim, kind')
    .is('topic', null);
  if (dialogueError) throw dialogueError;

  console.log(`Найдено без темы: ${lifecycleItems.length} сквозных, ${dialogueItems.length} по диалогам.`);

  let totalCostUsd = 0;
  let processedCount = 0;

  for (const item of lifecycleItems) {
    const result = await classifyTopic(
      { claim: item.claim, kind: item.kind, scopeLabel: 'сквозной памяти обо всём аккаунте', topics: MEMORY_V3_LIFECYCLE_TOPICS },
      apiKey,
    );
    const { error: updateError } = await supabase
      .from('memory_v3_lifecycle_shadow_items')
      .update({ topic: result.topic })
      .eq('user_id', item.user_id)
      .eq('memory_key', item.memory_key);
    if (updateError) throw updateError;
    const { error: logError } = await supabase.from('ai_usage_logs').insert({
      user_id: item.user_id,
      model: MODEL,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      memory_tokens: 0,
      summary_tokens: 0,
      cost: result.costUsd,
      call_kind: 'memory_v3_topic_backfill',
      cost_category: 'technical',
    });
    if (logError) throw logError;
    totalCostUsd += result.costUsd;
    processedCount += 1;
    console.log(`  сквозная ${item.memory_key.slice(0, 8)}… -> ${result.topic}`);
  }

  for (const item of dialogueItems) {
    const result = await classifyTopic(
      { claim: item.claim, kind: item.kind, scopeLabel: 'памяти конкретной беседы', topics: MEMORY_V3_DIALOGUE_TOPICS },
      apiKey,
    );
    const { error: updateError } = await supabase
      .from('memory_v3_dialogue_items')
      .update({ topic: result.topic })
      .eq('user_id', item.user_id)
      .eq('conversation_id', item.conversation_id)
      .eq('memory_key', item.memory_key);
    if (updateError) throw updateError;
    const { error: logError } = await supabase.from('ai_usage_logs').insert({
      user_id: item.user_id,
      conversation_id: item.conversation_id,
      model: MODEL,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      memory_tokens: 0,
      summary_tokens: 0,
      cost: result.costUsd,
      call_kind: 'memory_v3_topic_backfill',
      cost_category: 'technical',
    });
    if (logError) throw logError;
    totalCostUsd += result.costUsd;
    processedCount += 1;
    console.log(`  беседа ${item.memory_key.slice(0, 8)}… -> ${result.topic}`);
  }

  console.log(`Готово. Разобрано записей: ${processedCount}. Потрачено: $${totalCostUsd.toFixed(4)}.`);
}

// Only run main() when this file is executed directly (e.g. via
// `npx tsx scripts/memory-v3-topic-backfill/backfill-topics.ts`), never as a
// side effect of another module importing from it (e.g. the test file
// importing `buildSchema`). Same guard pattern used elsewhere in
// scripts/memory-v3-pilot/*.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { classifyTopic };
