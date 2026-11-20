import { createDynamicsFeedbackDeps } from './dynamicsFeedbackDeps';
import { supabase } from './supabase';

/** The real steps of the thumbs under a weekly dynamics, against the database (table dynamics_feedback, migration 096). */
export const supabaseDynamicsFeedbackDeps = createDynamicsFeedbackDeps(supabase);
