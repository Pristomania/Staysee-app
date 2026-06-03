/** Types for future admin usage dashboard (read via service_role / RPC). */

export interface AiUsageLogRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  memory_tokens: number;
  summary_tokens: number;
  cost: number;
  created_at: string;
}

export interface DailyCostPoint {
  day: string;
  requests: number;
  total_tokens: number;
  memory_tokens: number;
  summary_tokens: number;
  total_cost_usd: number;
}

export interface UserCostRow {
  user_id: string;
  requests: number;
  total_tokens: number;
  memory_tokens: number;
  summary_tokens: number;
  total_cost_usd: number;
  last_request_at: string;
}

export interface ConversationCostRow {
  conversation_id: string;
  user_id: string;
  requests: number;
  total_tokens: number;
  total_cost_usd: number;
  last_request_at: string;
}

export interface MemorySystemUsage {
  cross_memory_tokens: number;
  conversation_summary_tokens: number;
  combined_context_tokens: number;
  total_requests: number;
  total_cost_usd: number;
}
