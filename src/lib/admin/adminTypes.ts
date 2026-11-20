import type { CostClass } from './format';

/** What admin-api hands over (the jsonb of the admin_* SQL functions in migration 097). Numbers may come as text from the database. */

export interface AdminLabel {
  key: string;
  title: string;
  color: string | null;
  cost_class: CostClass;
}

export interface AdminPersonRow {
  user_id: string;
  email: string;
  registered_at: string;
  last_sign_in_at: string | null;
  label_key: string;
  label_title: string;
  tier: string | null;
  conversations: number;
  user_messages: number;
  cost_user_usd: number | string;
  cost_technical_usd: number | string;
}

export interface AdminPeoplePage {
  total: number;
  rows: AdminPersonRow[];
}

export interface RatingCount {
  up: number;
  down: number;
}

export interface AdminOverview {
  people: {
    total: number;
    registered_7d: number;
    registered_30d: number;
    by_label: Array<{ key: string; title: string; count: number }>;
    by_tier: Array<{ tier: string; count: number }>;
  };
  costs: { user_usd: number | string; technical_usd: number | string };
  errors_7d: number;
  feedback: { answers: RatingCount; dynamics: RatingCount };
}

export interface AdminCostKind {
  cost_class: CostClass;
  kind: string;
  calls: number;
  usd: number | string;
}

export interface AdminCosts {
  totals: { user_usd: number | string; technical_usd: number | string };
  by_day: Array<{ day: string; cost_class: CostClass; usd: number | string }>;
  by_kind: AdminCostKind[];
  by_person: Array<{ user_id: string; email: string | null; cost_class: CostClass; usd: number | string }>;
}

export interface AdminPersonCard {
  person: Pick<AdminPersonRow, 'user_id' | 'email' | 'registered_at' | 'last_sign_in_at' | 'label_key' | 'label_title' | 'tier' | 'conversations' | 'user_messages'>;
  consents: Array<{ consent_type: string; document_version: string; consented_at: string }>;
  tier: { tier: string; max_conversations_override: number | null; is_suspended: boolean } | null;
  packs: Array<{ messages_total: number; messages_left: number; purchased_at: string; expires_at: string }>;
  costs: { by_kind: AdminCostKind[] };
  feedback: { answers: RatingCount; dynamics: RatingCount };
  errors_7d: number;
}

export interface AdminAnswerFeedbackRow {
  created_at: string;
  verdict: string;
  rating: 1 | -1;
  comment: string | null;
  email: string | null;
  tier: string | null;
  reply_excerpt: string | null;
  previous_user_message: string | null;
}

export interface AdminDynamicsFeedbackRow {
  created_at: string;
  verdict: string;
  rating: 1 | -1;
  comment: string | null;
  email: string | null;
  tier: string | null;
  entry_date: string | null;
  dynamics_excerpt: string | null;
}

export interface AdminFeedbackPage<Row> {
  total: number;
  rows: Row[];
}

export interface AdminErrors {
  by_code: Array<{ error_code: string; count: number }>;
  recent: Array<{ created_at: string; model: string | null; call_kind: string | null; error_code: string; error_message: string | null; user_id: string | null }>;
}
