import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  hasRecallIntent,
  searchConversationArchive,
  summaryTextForRetrieval,
} from "../_shared/conversationRetrieval.ts";
import { ensureConversationEmbeddings } from "../_shared/messageEmbeddings.ts";
import { buildContextPacket, buildContextPrompt, stampMemoryUsed } from "../_shared/context.ts";
import {
  buildMemoryContinuityPrompt,
  buildRecallGroundingPrompt,
  collectMemoryCorrectionHints,
  fetchTranscriptForSummary,
  getConversationSummary,
  getParsedMemory,
  isSummaryStale,
  shouldEagerRefreshSummary,
  shouldUpdateConversationSummary,
} from "../_shared/memory.ts";
import { runConversationSummaryRefresh } from "../_shared/summaryRefresh.ts";
import {
  buildLegacySessionProcessState,
  buildStructuredSessionProcessState,
  extractSessionProcessStateFromMetadata,
  logSessionProcessStateRead,
  persistSessionProcessState,
  type SessionProcessState,
} from "../_shared/sessionProcessState.ts";
import {
  buildSessionProcessGuidance,
  sessionProcessGuidanceInjected,
} from "../_shared/sessionProcessGuidance.ts";
import {
  enforceRoleBoundedReply,
  evaluateTurnSafety,
} from "../_shared/roleEnforcement.ts";
import { logSafetyDiagnosis } from "../_shared/safetyDiagnose.ts";
import { CRISIS_LEVEL2_RESPONSE } from "../_shared/safety.ts";
import { sanitizeHistoryForModel } from "../_shared/roleGuard.ts";
import {
  buildSurgery1BasePrompt,
  SURGERY1_LAYER_ID,
} from "../_shared/surgery1Prompt.ts";
import {
  TIER_CONFIG,
  FALLBACK_CHAIN,
  findFallbackProvider,
  isDuplicateRequest,
  makeRequestKey,
  checkRateLimit,
  checkIpVelocity,
  incrementUsage,
  estimateTokens,
  trimContextForTier,
  makeServiceClient,
  CALM_ERRORS,
  type UsageTier,
  type ProviderConfig,
} from "../_shared/cost.ts";
import { semanticCrisisCheck } from "../_shared/semanticCrisisCheck.ts";
import {
  computeResponseBudget,
  continuationTokenBudget,
  OUTPUT_TOKEN_CEILING_GUIDANCE,
} from "../_shared/responseBudget.ts";
import {
  buildUncertaintyTurnGuidance,
  uncertaintyGuidanceInjected,
} from "../_shared/uncertaintyTurnGuidance.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "../_shared/explicitClosureTurnGuidance.ts";
import {
  buildOpenFigureTurnGuidance,
  openFigureGuidanceInjected,
} from "../_shared/openFigureTurnGuidance.ts";
import { detectUserGrammaticalGender } from "../_shared/userGrammaticalGender.ts";
import {
  buildUserGenderTurnGuidance,
  userGenderGuidanceInjected,
} from "../_shared/userGenderTurnGuidance.ts";
import { resolveChatModel } from "../_shared/modelRouter.ts";
import {
  ensurePublishableReply,
  isPublishableReply,
} from "../_shared/completeReply.ts";
import {
  polishAssistantOutput,
  polishMergedReply,
} from "../_shared/mergeContinuation.ts";
import {
  runReplyRecoveryRoutes,
  type ReplyRecoveryDiagnostics,
} from "../_shared/replyRecovery.ts";
import { logReplyRecoveryEvent } from "../_shared/replyRecoveryDiagnostics.ts";
import {
  logReplyCompletion,
  logSegmentMerge,
} from "../_shared/replyCompletionLog.ts";
import { buildTimeGapPrompt, classifyTimeGap, type TimeGapMeta } from "../_shared/timeGap.ts";
import {
  AI_AUDIT_COGNITIVE_SIGNATURE_VERSION,
  AI_AUDIT_CONSTITUTION_VERSION,
  AI_AUDIT_MEMORY_VERSION,
  AI_AUDIT_PROMPT_VERSION,
} from "../_shared/aiAuditVersions.ts";
import {
  buildUsageLogRow,
  logOpenRouterUsage,
  parseOpenRouterUsage,
} from "../_shared/usageAnalytics.ts";
import { computeProcessState } from "../_shared/processState.ts";
import { getStructuredTurnMode } from "../_shared/structuredTurnMode.ts";
import {
  applyStructuredShadowCallError,
  finalizeStructuredShadowAudit,
  planStructuredTurnAudit,
  type StructuredTurnDepthMeta,
} from "../_shared/structuredTurnRuntime.ts";
import { callModelStructured } from "../_shared/structuredModelCall.ts";
import {
  inspectOpenRouterMessageContent,
  legacyOpenRouterContent,
} from "../_shared/openRouterContent.ts";
import {
  beginReplyPipelineTrace,
  getReplyPipelineTraceReport,
  isContactSuspicious,
  isReplyPipelineTraceEnabled,
  recordReplyPipelineStage,
} from "../_shared/replyPipelineTrace.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ── Provider registry ────────────────────────────────────────────────────────

type AiProvider = "openrouter" | "openai" | "gemini" | "deepseek" | "mistral";

interface FullProviderConfig extends ProviderConfig {
  // intentionally empty — ProviderConfig already has all fields
}

/** Legacy single-model override; per-depth routing: see _shared/modelRouter.ts */
const CHAT_MODEL =
  Deno.env.get("STAYSEE_CHAT_MODEL")?.trim() || "openai/gpt-4.1";

const PROVIDERS: Record<AiProvider, FullProviderConfig> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: CHAT_MODEL,
    envKey: "OPENROUTER_API_KEY",
    extraHeaders: {
      "HTTP-Referer": "https://staysee.app",
      "X-Title": "StaySee AI",
    },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-1.5-pro",
    envKey: "GEMINI_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    envKey: "MISTRAL_API_KEY",
  },
};

const ACTIVE_PROVIDER: AiProvider = "openrouter";

// ── Static prompt layers (built once at cold start) ───────────────────────────
// SURGERY1 v3-cognitive: identity + voice v3 + constitution v3 + cognitive signature — surgery1Prompt.ts
// Per-turn: evaluateTurnSafety (roleEnforcement) + memory context + time gap

const BASE_PROMPT = buildSurgery1BasePrompt();

console.log(
  `[staysee-chat] ${SURGERY1_LAYER_ID} BASE tokens≈${estimateTokens(BASE_PROMPT)}`
);

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface RequestBody {
  message: string;
  conversationId?: string;
  userId?: string;
  provider?: AiProvider;
  model?: string;
  /** Client-generated idempotency key for duplicate prevention */
  requestId?: string;
  /** Browser pause metadata — injected into system prompt only */
  timeGap?: TimeGapMeta;
}

// ── Model call with fallback ─────────────────────────────────────────────────

async function callModel(
  primaryProvider: string,
  primaryConfig: FullProviderConfig,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens: number,
  temperature: number,
  modelOverride?: string,
  fallbackModelOverride?: string
): Promise<{
  content: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason?: string;
  usage?: { cost?: number; total_tokens?: number };
}> {
  const tried: string[] = [];

  async function attempt(
    provider: string,
    config: FullProviderConfig,
    model: string
  ): Promise<{
    content: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    finishReason?: string;
    usage?: { cost?: number; total_tokens?: number };
  } | null> {
    const apiKey = Deno.env.get(config.envKey);
    if (!apiKey) {
      console.warn(`[staysee-chat] no key for ${provider} (env: ${config.envKey})`);
      return null;
    }

    tried.push(provider);
    console.log(`[staysee-chat] calling ${provider} model=${model} maxTokens=${maxTokens}`);

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          max_tokens: maxTokens,
          temperature,
          usage: { include: true },
        }),
      });
    } catch (fetchErr) {
      console.error(`[staysee-chat] fetch error ${provider}:`, fetchErr);
      return null;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[staysee-chat] ${provider} HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const rawMessageContent = data.choices?.[0]?.message?.content;
    const contentInspect = inspectOpenRouterMessageContent(rawMessageContent);
    const content: string = legacyOpenRouterContent(rawMessageContent);
    const finishReason: string | undefined = data.choices?.[0]?.finish_reason;
    if (!content) {
      console.error(`[staysee-chat] ${provider} empty content, raw:`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    if (isReplyPipelineTraceEnabled()) {
      recordReplyPipelineStage("provider_raw_text", contentInspect.joinedText, {
        finishReason,
        model,
        meta: {
          rawKind: contentInspect.rawKind,
          blockCount: contentInspect.blockCount ?? null,
          legacyDiffersFromJoined:
            contentInspect.legacyText !== contentInspect.joinedText,
        },
      });
      recordReplyPipelineStage("adapter_extracted_content", content, {
        finishReason,
        model,
        meta: { rawKind: contentInspect.rawKind },
      });
    }
    const usage = data.usage ?? {};
    const parsed = parseOpenRouterUsage(data);
    console.log(
      `[staysee-chat] ${provider} ok, tokens: ${parsed.totalTokens}` +
        (parsed.cost !== undefined ? ` cost=$${parsed.cost}` : "")
    );
    return {
      content,
      provider,
      model,
      promptTokens:
        parsed.promptTokens ||
        estimateTokens(systemPrompt + messages.map((m) => m.content).join(" ")),
      completionTokens: parsed.completionTokens || estimateTokens(content),
      finishReason,
      usage: { cost: parsed.cost, total_tokens: parsed.totalTokens },
    };
  }

  // Try primary
  const primaryModel = modelOverride ?? primaryConfig.model;
  const primaryResult = await attempt(primaryProvider, primaryConfig, primaryModel);
  if (primaryResult) return primaryResult;

  // Try alternate model on same provider before switching providers
  if (fallbackModelOverride && fallbackModelOverride !== primaryModel) {
    console.log(`[staysee-chat] primary model failed — model fallback: ${fallbackModelOverride}`);
    const modelFallbackResult = await attempt(primaryProvider, primaryConfig, fallbackModelOverride);
    if (modelFallbackResult) return modelFallbackResult;
  }

  // Fallback chain
  const fallback = findFallbackProvider([...tried]);
  if (fallback) {
    const fallbackResult = await attempt(fallback.provider, fallback.config as FullProviderConfig, fallback.config.model);
    if (fallbackResult) return fallbackResult;
  }

  // All failed
  return {
    content: CALM_ERRORS.unavailable,
    provider: primaryProvider,
    model: primaryModel,
    promptTokens: 0,
    completionTokens: 0,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startMs = Date.now();
  beginReplyPipelineTrace();

  try {
    const body: RequestBody = await req.json();
    const { message, conversationId, userId, provider: reqProvider, model: reqModel, requestId, timeGap } = body;

    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const providerKey: AiProvider = reqProvider ?? ACTIVE_PROVIDER;
    const config = PROVIDERS[providerKey];
    if (!config) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${providerKey}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // ── L7: IP velocity guard (spam / autoclicker) ─────────────────────────

    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";

    const ipCheck = checkIpVelocity(clientIp);
    if (!ipCheck.allowed) {
      console.warn(`[staysee-chat] IP velocity blocked: ${clientIp} reason=${ipCheck.reason}`);
      return new Response(
        JSON.stringify({ content: CALM_ERRORS.rateLimit }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── L7: Duplicate prevention ────────────────────────────────────────────

    const dedupKey = requestId ?? (userId ? makeRequestKey(userId, message) : null);
    if (dedupKey && isDuplicateRequest(dedupKey)) {
      console.warn("[staysee-chat] duplicate request blocked:", dedupKey);
      return new Response(
        JSON.stringify({ content: CALM_ERRORS.duplicate }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── L7: Rate limit check ────────────────────────────────────────────────

    let userTier: UsageTier = "free";

    if (userId && authToken && supabaseUrl && supabaseAnonKey) {
      const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${authToken}` } },
      });

      const rateLimitResult = await checkRateLimit(userSupabase, userId);
      userTier = rateLimitResult.tier;

      if (!rateLimitResult.allowed) {
        const msg = rateLimitResult.reason === "suspended"
          ? CALM_ERRORS.suspended
          : CALM_ERRORS.rateLimit;
        console.warn(`[staysee-chat] rate limit for user ${userId}: ${rateLimitResult.reason}`);
        return new Response(
          JSON.stringify({ content: msg }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const tierCfg = TIER_CONFIG[userTier];
    const gapTier = classifyTimeGap(timeGap);
    const embedApiKey = Deno.env.get(PROVIDERS[ACTIVE_PROVIDER].envKey) ?? undefined;

    // ── L4: Build context packet ────────────────────────────────────────────

    let systemPrompt = BASE_PROMPT;
    let historyMessages: ChatMessage[] = [];
    let memoryItemIds: string[] = [];
    // PR3c-2 N-1: prior-turn processState for session guidance (legacy only).
    let priorSessionProcessState: SessionProcessState | null = null;
    // Carry packet out of block for background summary task
    let packetForSummary: Awaited<ReturnType<typeof buildContextPacket>> | null = null;

    const hasContext = conversationId && userId && authToken && supabaseUrl && supabaseAnonKey;

    if (hasContext) {
      try {
        const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${authToken}` } },
        });

        let packet = await buildContextPacket({
          conversationId,
          userId,
          authToken,
          supabaseUrl,
          supabaseAnonKey,
        });

        // PR3c-1/2 N-1: Turn N reads processState_{N-1} from metadata.
        // Same-turn processState_N is computed later and must not affect this response.
        const extractedSessionProcessState = extractSessionProcessStateFromMetadata(
          packet.conversationMeta?.metadata ?? null
        );
        logSessionProcessStateRead(extractedSessionProcessState);
        priorSessionProcessState = extractedSessionProcessState.legacy;

        const summaryUpdatedAt =
          packet.conversationMeta?.summary_updated_at ?? null;
        const preTranscript = await fetchTranscriptForSummary(
          userSupabase,
          conversationId,
          summaryUpdatedAt
        );
        const preHints = [
          ...new Set([
            ...packet.corrections,
            ...collectMemoryCorrectionHints(preTranscript),
          ]),
        ];

        if (
          shouldEagerRefreshSummary({
            conversationSummary: getConversationSummary(packet.conversationMeta),
            summaryUpdatedAt,
            messagesSinceSummary: packet.messagesSinceSummary,
            transcript: preTranscript,
            hasCorrections: preHints.length > 0,
          })
        ) {
          const apiKey = Deno.env.get(PROVIDERS[ACTIVE_PROVIDER].envKey);
          if (apiKey) {
            console.log("[staysee-chat] eager summary refresh (stale or empty)");
            await runConversationSummaryRefresh({
              supabase: makeServiceClient(),
              conversationId,
              userId,
              previousSummary: getConversationSummary(packet.conversationMeta),
              transcript: preTranscript,
              memoryHints: preHints,
              model: {
                baseUrl: PROVIDERS[ACTIVE_PROVIDER].baseUrl,
                model: PROVIDERS[ACTIVE_PROVIDER].model,
                apiKey,
                extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders,
              },
            });
            packet = await buildContextPacket({
              conversationId,
              userId,
              authToken,
              supabaseUrl,
              supabaseAnonKey,
            });
          }
        }

        // L7: Trim messages and memory to tier limits
        const trimmed = trimContextForTier(
          packet.recentMessages.map((m) => ({ role: m.role, content: m.content })),
          packet.memoryItems,
          userTier
        );

        const recentUserLines = packet.recentMessages
          .filter((m) => m.role === "user")
          .slice(-4)
          .map((m) => m.content);

        const archiveSearch = await searchConversationArchive(userSupabase, {
          conversationId,
          query: message,
          excludeTailCount: trimmed.messages.length,
          queryContext: [
            ...packet.corrections,
            ...recentUserLines,
            summaryTextForRetrieval(
              getConversationSummary(packet.conversationMeta)
            ),
          ],
          userId,
          embedConfig: embedApiKey
            ? {
                apiKey: embedApiKey,
                extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders,
              }
            : undefined,
          supabaseService: embedApiKey ? makeServiceClient() : undefined,
        });

        // Preserve corrections through trim — they are high-priority context
        const trimmedPacket = {
          ...packet,
          recentMessages: trimmed.messages.map((m) => ({ ...m, created_at: "" })),
          memoryItems: trimmed.memoryItems,
          corrections: packet.corrections,
          archiveExcerpts: archiveSearch.excerpts,
          userEvidenceQuotes: archiveSearch.userEvidenceQuotes,
        };
        packetForSummary = trimmedPacket;

        systemPrompt = [BASE_PROMPT, buildContextPrompt(trimmedPacket)].join("\n\n");

        if (hasRecallIntent(message)) {
          const recallGrounding = buildRecallGroundingPrompt({
            evidenceCount: trimmedPacket.userEvidenceQuotes?.length ?? 0,
            archiveCount: trimmedPacket.archiveExcerpts?.length ?? 0,
          });
          systemPrompt = [systemPrompt, recallGrounding].join("\n\n");
          console.log(
            `[staysee-chat] recall grounding evidence=${trimmedPacket.userEvidenceQuotes?.length ?? 0} ` +
              `archive=${trimmedPacket.archiveExcerpts?.length ?? 0}`
          );
        }

        const continuity = buildMemoryContinuityPrompt({
          summaryStale: isSummaryStale(
            packet.conversationMeta?.summary_updated_at ?? null
          ),
          longPause: gapTier === "recheck",
        });
        if (continuity) {
          systemPrompt = [systemPrompt, continuity].join("\n\n");
        }

        memoryItemIds = trimmed.memoryItems.map((m) => m.id);
        historyMessages = trimmed.messages;
      } catch (ctxErr) {
        console.error("[staysee-chat] context build error:", ctxErr);
      }
    }

    // ── L5: Safety check ────────────────────────────────────────────────────

    const safety = evaluateTurnSafety(message, historyMessages);
    const diagnosis = logSafetyDiagnosis(message, historyMessages);
    console.log(
      `[staysee-chat] safety: ${safety.category} | tier: ${userTier} | thread=${safety.threadEscalated} insist=${safety.insistenceLoop} role=${safety.roleContaminated} rule=${diagnosis.matchedRule}`
    );

    if (safety.immediateResponse) {
      return new Response(
        JSON.stringify({ content: safety.immediateResponse, provider: providerKey, model: reqModel ?? config.model }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── L5b: Semantic crisis check — primary crisis gate ─────────────────────
    // Runs for all categories except prompt_attack and boundary_pressure,
    // which have their own contextual handling and don't short-circuit to a crisis card.
    // If semantic API fails → fall back to regex as silent safety net.

    if (safety.category !== "prompt_attack" && safety.category !== "boundary_pressure") {
      const semanticResult = await semanticCrisisCheck(message);
      if (semanticResult.isCrisis) {
        console.log("[staysee-chat] semantic crisis detected — specialist referral");
        return new Response(
          JSON.stringify({ content: CRISIS_LEVEL2_RESPONSE, provider: providerKey, model: reqModel ?? config.model }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (semanticResult.failed) {
        console.warn("[staysee-chat] semantic crisis check unavailable — proceeding to model");
      }
    }

    if (safety.systemGuidance) {
      systemPrompt = [systemPrompt, safety.systemGuidance].join("\n\n");
    }

    const genderMessages =
      historyMessages[historyMessages.length - 1]?.content === message
        ? historyMessages
        : [...historyMessages, { role: "user" as const, content: message }];
    const userTurnCount = genderMessages.filter((m) => m.role === "user").length;
    const parsedMem = packetForSummary?.conversationMeta
      ? getParsedMemory(packetForSummary.conversationMeta)
      : null;
    const genderResult = detectUserGrammaticalGender({
      messages: genderMessages,
      conversationPreferences: parsedMem?.preferences ?? [],
      crossMemoryItems: (packetForSummary?.memoryItems ?? []).map((m) => ({
        memory_type: m.memory_type,
        content: m.content,
      })),
    });
    const genderGuidanceOptions = {
      safetyCategory: safety.category,
      message,
      userTurnCount,
    };
    const genderGuidance = buildUserGenderTurnGuidance(
      genderResult,
      genderGuidanceOptions
    );
    const genderGuidanceOn = userGenderGuidanceInjected(
      genderResult,
      genderGuidanceOptions
    );
    if (genderGuidance) {
      systemPrompt = [systemPrompt, genderGuidance].join("\n\n");
    }

    const timeGapPrompt = buildTimeGapPrompt(timeGap);
    if (timeGapPrompt) {
      systemPrompt = [systemPrompt, timeGapPrompt].join("\n\n");
    }
    console.log(`[staysee-chat] time-gap tier: ${gapTier}`);

    // ── Build message list ───────────────────────────────────────────────────

    const messages: ChatMessage[] =
      historyMessages[historyMessages.length - 1]?.content === message
        ? historyMessages
        : [...historyMessages, { role: "user", content: message }];

    const modelMessages = sanitizeHistoryForModel(messages);

    // ── L7: Dynamic response budget + model call ─────────────────────────────

    const responseBudget = computeResponseBudget(
      message,
      safety.category,
      modelMessages,
      userTier
    );
    let { depth: responseDepth, maxTokens: outputBudget } = responseBudget;

    const explicitClosureGuidance = buildExplicitClosureTurnGuidance({
      depthReason: responseBudget.depthReason,
      message,
    });
    const explicitClosureGuidanceOn = explicitClosureGuidanceInjected({
      depthReason: responseBudget.depthReason,
      message,
    });

    const sessionProcessGuidance = buildSessionProcessGuidance({
      priorState: priorSessionProcessState,
      explicitClosureActive: explicitClosureGuidanceOn,
      safetyCategory: safety.category,
    });
    const sessionProcessGuidanceOn = sessionProcessGuidanceInjected({
      priorState: priorSessionProcessState,
      explicitClosureActive: explicitClosureGuidanceOn,
      safetyCategory: safety.category,
    });
    if (sessionProcessGuidance) {
      systemPrompt = [systemPrompt, sessionProcessGuidance].join("\n\n");
    }

    const openFigureGuidance = buildOpenFigureTurnGuidance({
      openFigure: responseBudget.openFigure,
      depthReason: responseBudget.depthReason,
      safetyCategory: safety.category,
    });
    const openFigureGuidanceOn = openFigureGuidanceInjected({
      openFigure: responseBudget.openFigure,
      depthReason: responseBudget.depthReason,
      safetyCategory: safety.category,
    });
    if (openFigureGuidance) {
      systemPrompt = [systemPrompt, openFigureGuidance].join("\n\n");
    }

    const uncertaintyGuidance = buildUncertaintyTurnGuidance({
      depthReason: responseBudget.depthReason,
      message,
      openFigure: { isOpen: responseBudget.openFigure.isOpen },
    });
    const uncertaintyGuidanceOn = uncertaintyGuidanceInjected({
      depthReason: responseBudget.depthReason,
      message,
      openFigure: { isOpen: responseBudget.openFigure.isOpen },
    });
    if (uncertaintyGuidance) {
      systemPrompt = [systemPrompt, uncertaintyGuidance].join("\n\n");
    }

    if (explicitClosureGuidance) {
      systemPrompt = [systemPrompt, explicitClosureGuidance].join("\n\n");
    }

    systemPrompt = [systemPrompt, OUTPUT_TOKEN_CEILING_GUIDANCE].join("\n\n");

    const modelRoute = resolveChatModel({
      depth: responseDepth,
      safetyCategory: safety.category,
      requestModel: reqModel,
    });
    const turnModel = modelRoute.model;

    // PR3a shadow — current-turn audit only; persisted as processState_N after response.
    const processState = computeProcessState({
      openFigure: {
        isOpen: responseBudget.openFigure.isOpen,
        intensity: responseBudget.openFigure.intensity,
        confidence: responseBudget.openFigure.confidence,
      },
      depth: responseDepth,
      explicitClosure: explicitClosureGuidanceOn,
      uncertainty: uncertaintyGuidanceOn,
      recentUserTurns: responseBudget.recentUserTurns,
      safetyCategory: safety.category,
    });

    const structuredTurnMode = getStructuredTurnMode();
    const structuredShadowPct = Deno.env.get("STAYSEE_STRUCTURED_TURN_SHADOW_PCT");
    const structuredAuditPlan = planStructuredTurnAudit(
      structuredTurnMode,
      turnModel,
      structuredShadowPct
    );

    console.log(
      `[staysee-chat] depth=${responseDepth} model=${turnModel} route=${modelRoute.source} maxTokens=${outputBudget} structured_mode=${structuredTurnMode}`
    );

    let result = await callModel(
      providerKey,
      config,
      modelMessages,
      systemPrompt,
      outputBudget,
      tierCfg.temperature,
      turnModel,
      modelRoute.fallbackModel
    );

    // ── Reply completion routes ─────────────────────────────────────────────
    const firstSegmentContent = result.content?.trim() ?? "";
    const segmentBudget = continuationTokenBudget(userTier, responseDepth);

    const recovery = await runReplyRecoveryRoutes({
      firstSegment: {
        content: firstSegmentContent,
        finishReason: result.finishReason,
      },
      baseModelMessages: modelMessages,
      unavailableMessage: CALM_ERRORS.unavailable,
      replyNotRecoveredMessage: CALM_ERRORS.replyNotRecovered,
      callModel: async (messages, kind) => {
        const tokenBudget =
          kind === "auto_continue"
            ? segmentBudget
            : kind === "finalize"
              ? Math.min(320, segmentBudget)
              : outputBudget;
        const retry = await callModel(
          providerKey,
          config,
          messages,
          systemPrompt,
          tokenBudget,
          tierCfg.temperature,
          turnModel,
          modelRoute.fallbackModel
        );
        return {
          content: retry.content ?? "",
          finishReason: retry.finishReason,
        };
      },
      onSegmentMerge: (meta) => logSegmentMerge(meta),
    });

    result = {
      ...result,
      content: recovery.content,
      finishReason: recovery.finishReason ?? result.finishReason,
    };

    let autoContinueCount = recovery.autoContinueCount;
    let finalizeCount = recovery.finalizeCount;
    let wasAutoContinued = recovery.wasAutoContinued;
    let wasFinalizeUsed = recovery.wasFinalizeUsed;
    let wasTruncated = recovery.wasTruncated;
    let replyPublishable = false;
    let lengthBeforeMerge = recovery.lengthBeforeMerge;
    let lengthAfterMerge = recovery.lengthAfterMerge;
    let lastMergeStrategy = recovery.lastMergeStrategy;
    let lastOverlapWords = recovery.lastOverlapWords;
    let usedMergeFallback = false;
    let discardedDuplicateCount = recovery.discardedDuplicateCount;
    const mergeStrategies = recovery.mergeStrategies;
    const recoveryDiagnostics: ReplyRecoveryDiagnostics = recovery.diagnostics;

  if (isReplyPipelineTraceEnabled()) {
    recordReplyPipelineStage("after_auto_continue_merge", result.content, {
      finishReason: result.finishReason,
      model: result.model,
      autoContinueUsed: wasAutoContinued,
      finalizeUsed: wasFinalizeUsed,
    });
  }

  let polishedBeforeEnsure = "";

  if (result.content?.trim()) {
    const before = result.content.length;
    polishedBeforeEnsure = polishMergedReply(result.content.trim());
    if (isReplyPipelineTraceEnabled()) {
      recordReplyPipelineStage("after_polish_merged", polishedBeforeEnsure, {
        finishReason: result.finishReason,
        model: result.model,
        autoContinueUsed: wasAutoContinued,
        finalizeUsed: wasFinalizeUsed,
      });
    }
    let safe = ensurePublishableReply(polishedBeforeEnsure);

      if (
        !isPublishableReply(safe) &&
        wasAutoContinued &&
        firstSegmentContent.length >= 12
      ) {
        safe = ensurePublishableReply(
          polishAssistantOutput(firstSegmentContent)
        );
        usedMergeFallback = true;
        lengthAfterMerge = safe.length;
      }

      if (isReplyPipelineTraceEnabled()) {
        recordReplyPipelineStage("after_ensure_publishable", safe, {
          finishReason: result.finishReason,
          model: result.model,
          autoContinueUsed: wasAutoContinued,
          finalizeUsed: wasFinalizeUsed,
          publishable: isPublishableReply(safe),
          contactComplete: !isContactSuspicious(safe),
        });
      }

      safe = enforceRoleBoundedReply(safe, safety.category, {
        insistenceLoop: safety.insistenceLoop,
        threadEscalated: safety.threadEscalated,
        userMessage: message,
        relationalLifeTurn: diagnosis.relationalLifeTurn,
      });
      result = { ...result, content: safe };

      if (isReplyPipelineTraceEnabled()) {
        recordReplyPipelineStage("after_role_bounded_reply", safe, {
          finishReason: result.finishReason,
          model: result.model,
          autoContinueUsed: wasAutoContinued,
          finalizeUsed: wasFinalizeUsed,
          publishable: isPublishableReply(safe),
          contactComplete: !isContactSuspicious(safe),
        });
      }

      replyPublishable = isPublishableReply(safe);
      if (
        wasAutoContinued ||
        wasFinalizeUsed ||
        finalizeCount > 0 ||
        autoContinueCount > 0 ||
        !replyPublishable
      ) {
        logReplyCompletion({
          finishReason: result.finishReason,
          autoContinueSegments: autoContinueCount + finalizeCount,
          finalizeAttempts: finalizeCount,
          autoContinueCount,
          finalizeCount,
          discardedDuplicateCount,
          mergeStrategies,
          lengthBeforeMerge,
          lengthAfterMerge,
          wasAutoContinued,
          wasFinalizeUsed,
          publishable: replyPublishable,
          lastMergeStrategy,
          overlapWords: lastOverlapWords,
          usedMergeFallback,
        });
      }

      if (!replyPublishable) {
        console.error("[staysee-chat] reply still not publishable after completion");
      } else if (autoContinueCount > 0 || finalizeCount > 0 || safe.length < before) {
        console.log(
          `[staysee-chat] completion auto_continue=${autoContinueCount} finalize=${finalizeCount} len=${before}->${safe.length}`
        );
      }
    }

    let structuredDepthMeta: StructuredTurnDepthMeta = structuredAuditPlan.meta;

    if (structuredAuditPlan.shouldAttemptStructuredCall) {
      try {
        const shadowResult = await callModelStructured({
          primaryProvider: providerKey,
          primaryConfig: {
            baseUrl: config.baseUrl,
            model: config.model,
            envKey: config.envKey,
            extraHeaders: config.extraHeaders,
          },
          messages: modelMessages,
          systemPrompt,
          maxTokens: outputBudget,
          temperature: tierCfg.temperature,
          modelOverride: turnModel,
        });

        if (!shadowResult) {
          structuredDepthMeta = applyStructuredShadowCallError(structuredDepthMeta);
        } else {
          structuredDepthMeta = finalizeStructuredShadowAudit(
            structuredDepthMeta,
            shadowResult.model,
            shadowResult.rawContent
          );
        }
      } catch (shadowErr) {
        console.error("[staysee-chat] structured shadow call error:", shadowErr);
        structuredDepthMeta = applyStructuredShadowCallError(structuredDepthMeta);
      }
    }

    console.log(
      `[staysee-chat] depth_meta=${JSON.stringify({
        depth: responseDepth,
        depthReason: responseBudget.depthReason,
        recentUserTurns: responseBudget.recentUserTurns,
        emotionalMomentum: responseBudget.emotionalMomentum,
        open_figure: responseBudget.openFigure.isOpen,
        open_figure_kind: responseBudget.openFigure.kind,
        open_figure_intensity: responseBudget.openFigure.intensity,
        open_figure_confidence: responseBudget.openFigure.confidence,
        open_figure_trigger: responseBudget.openFigure.trigger,
        sessionProcessGuidanceInjected: sessionProcessGuidanceOn,
        openFigureGuidanceInjected: openFigureGuidanceOn,
        uncertaintyGuidanceInjected: uncertaintyGuidanceOn,
        explicitClosureGuidanceInjected: explicitClosureGuidanceOn,
        process_contact: processState.contact,
        process_movement: processState.movement,
        process_closure: processState.closure,
        process_certainty: processState.certainty,
        process_state_source: processState.source,
        structured_turn_mode: structuredDepthMeta.structured_turn_mode,
        structured_turn_enabled: structuredDepthMeta.structured_turn_enabled,
        structured_shadow_pct: structuredDepthMeta.structured_shadow_pct,
        structured_shadow_pct_passed: structuredDepthMeta.structured_shadow_pct_passed,
        structured_model_supported: structuredDepthMeta.structured_model_supported,
        structured_attempted: structuredDepthMeta.structured_attempted,
        structured_parse_ok: structuredDepthMeta.structured_parse_ok,
        structured_fallback_reason: structuredDepthMeta.structured_fallback_reason,
        structured_process_contact: structuredDepthMeta.structured_process_contact,
        structured_process_movement: structuredDepthMeta.structured_process_movement,
        structured_process_closure: structuredDepthMeta.structured_process_closure,
        structured_process_certainty: structuredDepthMeta.structured_process_certainty,
        structured_open_figure: structuredDepthMeta.structured_open_figure,
        structured_open_figure_kind: structuredDepthMeta.structured_open_figure_kind,
        structured_model: structuredDepthMeta.structured_model,
        userGenderGuidanceInjected: genderGuidanceOn,
        userGrammaticalGender: genderResult.gender,
        userGenderSource: genderResult.source,
      })}`
    );

    // PR3c-1: persist processState_N after response (Turn N+1 will read it).
    const sessionProcessStateWrite = {
      processState: buildLegacySessionProcessState(processState),
      ...(structuredDepthMeta.structured_attempted === true &&
      structuredDepthMeta.structured_parse_ok === true &&
      structuredDepthMeta.structured_process_contact &&
      structuredDepthMeta.structured_process_movement &&
      structuredDepthMeta.structured_process_closure &&
      structuredDepthMeta.structured_process_certainty
        ? {
            processStateStructured: buildStructuredSessionProcessState({
              contact: structuredDepthMeta.structured_process_contact,
              movement: structuredDepthMeta.structured_process_movement,
              closure: structuredDepthMeta.structured_process_closure,
              certainty: structuredDepthMeta.structured_process_certainty,
            }),
          }
        : {}),
    };

    const responseMs = Date.now() - startMs;
    const totalTokens = result.promptTokens + result.completionTokens;
    const modelUnavailable = result.content === CALM_ERRORS.unavailable;
    const replyRecoveryFailed =
      recoveryDiagnostics.failClosedUsed ||
      result.content === CALM_ERRORS.replyNotRecovered;
    const generationStatus = modelUnavailable || replyRecoveryFailed
      ? "error"
      : result.content?.trim()
        ? replyPublishable
          ? "success"
          : "incomplete"
        : "error";
    const errorCode = modelUnavailable
      ? "model_unavailable"
      : replyRecoveryFailed
        ? "reply_not_recovered"
      : generationStatus === "incomplete"
        ? "reply_not_publishable"
        : generationStatus === "error"
          ? "empty_reply"
          : null;
    const errorMessage = modelUnavailable
      ? "All model providers failed"
      : replyRecoveryFailed
        ? "Reply recovery failed after stop+not_publishable"
      : generationStatus === "incomplete"
        ? "Reply failed publishability check"
        : generationStatus === "error" && !result.content?.trim()
          ? "Model returned empty content"
          : null;

    const isCalmFallbackContent =
      result.content === CALM_ERRORS.unavailable ||
      result.content === CALM_ERRORS.replyNotRecovered;

    // ── Background tasks (non-blocking) ─────────────────────────────────────

    const usageLogRow =
      userId
        ? buildUsageLogRow({
            userId,
            conversationId: conversationId ?? null,
            model: result.model,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            usage: {
              cost: result.usage?.cost,
              prompt_tokens: result.promptTokens,
              completion_tokens: result.completionTokens,
              total_tokens: result.usage?.total_tokens ?? totalTokens,
            },
            packet: packetForSummary,
            audit: {
              requestId: requestId ?? null,
              finishReason: result.finishReason ?? null,
              latencyMs: responseMs,
              wasTruncated,
              autoContinueUsed: wasAutoContinued,
              finalizeUsed: wasFinalizeUsed,
              promptVersion: AI_AUDIT_PROMPT_VERSION,
              constitutionVersion: AI_AUDIT_CONSTITUTION_VERSION,
              cognitiveSignatureVersion: AI_AUDIT_COGNITIVE_SIGNATURE_VERSION,
              memoryVersion: AI_AUDIT_MEMORY_VERSION,
              errorCode,
              errorMessage,
              generationStatus,
            },
          })
        : null;

    const clientConnected = !req.signal.aborted;

    if (isReplyPipelineTraceEnabled() && result.content?.trim()) {
      recordReplyPipelineStage("before_http_response", result.content, {
        finishReason: result.finishReason,
        model: result.model,
        generationStatus,
        autoContinueUsed: wasAutoContinued,
        finalizeUsed: wasFinalizeUsed,
        publishable: replyPublishable,
        contactComplete: !isContactSuspicious(result.content),
      });
    }

    const pipelineTrace = getReplyPipelineTraceReport();

    if (userId && clientConnected) {
      const svc = makeServiceClient();

      EdgeRuntime.waitUntil(
        Promise.all([
          // Stamp memory items used
          memoryItemIds.length > 0 && authToken && supabaseUrl && supabaseAnonKey
            ? stampMemoryUsed(
                createClient(supabaseUrl, supabaseAnonKey, {
                  global: { headers: { Authorization: `Bearer ${authToken}` } },
                }),
                memoryItemIds
              )
            : Promise.resolve(),

          // Rolling summary — full transcript fetch + merge (background)
          conversationId &&
          packetForSummary &&
          result.content &&
          !isCalmFallbackContent
            ? (async () => {
                try {
                  const baseTranscript =
                    authToken && supabaseUrl && supabaseAnonKey
                      ? await fetchTranscriptForSummary(
                          createClient(supabaseUrl, supabaseAnonKey, {
                            global: { headers: { Authorization: `Bearer ${authToken}` } },
                          }),
                          conversationId,
                          packetForSummary.conversationMeta?.summary_updated_at ?? null
                        )
                      : messages;
                  const transcriptForSummary: ChatMessage[] = (() => {
                    const tail = baseTranscript.slice(-2);
                    const hasExchange =
                      tail.length === 2 &&
                      tail[0]?.role === "user" &&
                      tail[0].content === message &&
                      tail[1]?.role === "assistant" &&
                      tail[1].content === result.content;
                    if (hasExchange) return baseTranscript;
                    return [
                      ...baseTranscript,
                      { role: "user", content: message },
                      { role: "assistant", content: result.content },
                    ];
                  })();

                  const memoryHints = [
                    ...new Set([
                      ...packetForSummary.corrections,
                      ...collectMemoryCorrectionHints(transcriptForSummary),
                    ]),
                  ];

                  if (
                    !shouldUpdateConversationSummary({
                      conversationSummary: getConversationSummary(
                        packetForSummary.conversationMeta
                      ),
                      summaryUpdatedAt:
                        packetForSummary.conversationMeta?.summary_updated_at ?? null,
                      messagesSinceSummary: packetForSummary.messagesSinceSummary + 2,
                      transcript: transcriptForSummary,
                      hasCorrections: memoryHints.length > 0,
                    })
                  ) {
                    return;
                  }

                  const apiKey = Deno.env.get(PROVIDERS[ACTIVE_PROVIDER].envKey);
                  if (!apiKey) return;

                  const previousSummary = getConversationSummary(
                    packetForSummary.conversationMeta
                  );
                  await runConversationSummaryRefresh({
                    supabase: svc,
                    conversationId,
                    userId,
                    previousSummary,
                    transcript: transcriptForSummary,
                    memoryHints,
                    model: {
                      baseUrl: PROVIDERS[ACTIVE_PROVIDER].baseUrl,
                      model: PROVIDERS[ACTIVE_PROVIDER].model,
                      apiKey,
                      extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders,
                    },
                  });
                } catch (sumErr) {
                  console.error("[staysee-chat] summary update failed:", sumErr);
                }
              })()
            : Promise.resolve(),

          // PR3c-1 — session processState_N (metadata column only; summary untouched)
          conversationId &&
          result.content &&
          !isCalmFallbackContent
            ? persistSessionProcessState(
                svc,
                conversationId,
                sessionProcessStateWrite
              ).catch((err) =>
                console.error("[staysee-chat] session_process_state_write:", err)
              )
            : Promise.resolve(),

          // Increment usage counters
          incrementUsage(svc, userId, totalTokens),

          // OpenRouter usage analytics (ai_usage_logs)
          usageLogRow ? logOpenRouterUsage(svc, usageLogRow) : Promise.resolve(),

          // Reply recovery route diagnostics (PII-free)
          logReplyRecoveryEvent(svc, {
            requestId: requestId ?? null,
            conversationId: conversationId ?? null,
            userId,
            model: result.model,
            promptVersion: AI_AUDIT_PROMPT_VERSION,
            constitutionVersion: AI_AUDIT_CONSTITUTION_VERSION,
            diagnostics: recoveryDiagnostics,
          }),

          // Embed new messages for semantic archive (this chat only)
          conversationId && embedApiKey
            ? ensureConversationEmbeddings(svc, {
                conversationId,
                userId,
                embedConfig: {
                  apiKey: embedApiKey,
                  extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders,
                },
                maxMessages: 12,
              })
            : Promise.resolve(),
        ])
      );
    } else if (userId && !clientConnected) {
      console.log("[staysee-chat] client disconnected — skip memory, usage, summary");
    }

    return new Response(
      JSON.stringify({
        content: result.content,
        provider: result.provider,
        model: result.model,
        ...(pipelineTrace.length > 0 ? { _replyPipelineTrace: pipelineTrace } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[staysee-chat] unexpected error:", err);
    return new Response(
      JSON.stringify({ content: CALM_ERRORS.unavailable }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
