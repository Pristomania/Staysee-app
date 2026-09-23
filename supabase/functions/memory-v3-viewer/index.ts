import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveVerifiedChatUser } from "../_shared/authUser.ts";
import { makeServiceClient } from "../_shared/cost.ts";
import { resolveMemoryV3DialogueEligibility } from "../_shared/memoryV3/dialogueMode.ts";
import {
  projectMemoryV3ViewerItems,
  type MemoryV3ViewerSourceItem,
} from "../_shared/memoryV3/viewerProjection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as {
      action?: string; conversationId?: string; userId?: string;
      memoryKey?: string; scope?: string;
    };
    const authorizationHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const verifiedUser = await resolveVerifiedChatUser({
      authorizationHeader,
      requestedUserId: body.userId?.trim(),
      getUser: async (token) => {
        const authClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const { data, error } = await authClient.auth.getUser(token);
        return { user: data.user, error };
      },
    });
    if (!verifiedUser.ok) {
      return new Response(JSON.stringify({ error: verifiedUser.reason }), {
        status: verifiedUser.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = verifiedUser.userId;
    const svc = makeServiceClient();

    if (body.action === "delete") {
      const memoryKey = body.memoryKey?.trim();
      if (!memoryKey || (body.scope !== "account_wide" && body.scope !== "dialogue")) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (body.scope === "dialogue") {
        const conversationId = body.conversationId?.trim();
        if (!conversationId) {
          return new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data, error } = await svc.rpc("delete_memory_v3_dialogue_item", {
          p_user_id: userId, p_conversation_id: conversationId, p_memory_key: memoryKey,
        });
        if (error) {
          console.error("[memory-v3-viewer] delete_dialogue_item:", error.message);
          return new Response(JSON.stringify({ error: "internal" }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ deleted: Boolean(data) }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await svc.rpc("delete_memory_v3_lifecycle_item", {
        p_user_id: userId, p_memory_key: memoryKey,
      });
      if (error) {
        console.error("[memory-v3-viewer] delete_lifecycle_item:", error.message);
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: Boolean(data) }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // action === "read" (default)
    const conversationId = body.conversationId?.trim();

    const { data: lifecycleRaw, error: lifecycleError } = await svc.rpc(
      "load_memory_v3_lifecycle_viewer_items",
      { p_user_id: userId },
    );
    if (lifecycleError) {
      console.error("[memory-v3-viewer] load_lifecycle_viewer_items:", lifecycleError.message);
    }
    const accountWide = projectMemoryV3ViewerItems(
      (Array.isArray(lifecycleRaw) ? lifecycleRaw : []) as MemoryV3ViewerSourceItem[],
    );

    let dialogue: ReturnType<typeof projectMemoryV3ViewerItems> = [];
    if (conversationId) {
      const eligibility = resolveMemoryV3DialogueEligibility({
        rawMode: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_MODE"),
        rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID"),
        userId,
      });
      if (eligibility.eligible) {
        const { data: dialogueRaw, error: dialogueError } = await svc.rpc(
          "load_memory_v3_dialogue_viewer_items",
          { p_user_id: userId, p_conversation_id: conversationId },
        );
        if (dialogueError) {
          console.error("[memory-v3-viewer] load_dialogue_viewer_items:", dialogueError.message);
        } else {
          dialogue = projectMemoryV3ViewerItems(
            (Array.isArray(dialogueRaw) ? dialogueRaw : []) as MemoryV3ViewerSourceItem[],
          );
        }
      }
    }

    return new Response(JSON.stringify({ accountWide, dialogue }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[memory-v3-viewer]", e);
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
