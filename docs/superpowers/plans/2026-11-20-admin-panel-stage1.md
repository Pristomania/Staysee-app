# Admin panel, stage 1 (look + labels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a closed `/admin` section where the owner sees people, tariffs, ratings, costs (technical vs user) and errors, and puts labels on accounts, with every change in an audit log.

**Architecture:** admin data lives behind SQL functions callable only by the service role; one edge function `admin-api` verifies the token, the admin flag and a fresh password entry, then relays to those functions; the browser opens `/admin` as a separately loaded chunk and talks only to `admin-api`.

**Tech Stack:** Postgres/PostgREST (Supabase), Deno edge function, React + TypeScript (Vite), tests: `node:test` via tsx for `_shared`, plain tsx cases for `src`, real-database tests in `tests/db`.

**Spec:** `docs/superpowers/specs/2026-11-20-admin-panel-design.md`

## Global Constraints

- Entry only at `/admin` (and below); a person without admin rights is sent to the normal app and sees nothing of the panel.
- Browser never reads other people's data directly; every `admin_*` SQL function is executable by `service_role` only (revoked from PUBLIC, anon, authenticated).
- No conversation text. Allowed: the rated answer, the question before it, notes (as in the existing `*_feedback_review` views).
- Emails shown in full in the panel; the audit log stores ids only, never emails.
- Admin access = admin flag + password entered within the last **30 minutes** (absolute, from the password entry; my call, stricter than "inactivity").
- Dates in Moscow time; lists 50 rows per page (max 100); search by email is a case-insensitive prefix match with `%` `_` `\` taken literally.
- Costs split by account label: **user** vs **technical**; rows with `cost_category = 'technical'` are always technical.
- Every label starts as `человек` (no assignment row); the owner sets labels herself; nothing is labelled automatically.
- Migration number 097 (096 is taken in `main`); the payment branch of Codex may use the same numbers: renumber one when both are merged. Migration is applied to production **before** the site is merged. Merge one pull request at a time. Do not touch `codex/robokassa-test-payments-20261119`.
- Texts: plain Russian, no gendered address to the person.

## Review Focus

1. An ordinary signed-in person calls `admin-api` with a valid token: 403, no data, no audit row. (Task 3, Task 4)
2. An admin whose password entry is older than 30 minutes (or whose token has no password method): 401 `password_stale`. (Task 3)
3. Search text with `%`, `_`, `\`, an apostrophe, spaces, capitals: matches literally, never errors. (Task 2)
4. A person with no label row shows as `человек`; setting an unknown label or an unknown person fails cleanly and writes no audit row. (Task 1)
5. A never-signed-in person (no last login), a person with no conversations, an offset beyond the end: rows render ("—", 0, empty page), no crash. (Task 2, Task 5)
6. Technical-labelled accounts' costs never appear in the user total even when their rows say `automatic`. (Task 2)

---

### Task 1: Core tables, labels, audit log, `admin_set_label`

**Files:**
- Create: `supabase/migrations/20261120130000_097_admin_panel_core.sql`
- Test: `tests/db/adminPanel.dbtest.ts`

**Interfaces:**
- Produces: tables `admin_users(user_id uuid pk → auth.users on delete cascade, granted_at)`, `account_labels(key text pk, title text, color text, cost_class text check in ('user','technical'), sort int)`, `account_label_assignments(user_id uuid pk → auth.users on delete cascade, label_key text → account_labels, assigned_at, assigned_by uuid)`, `admin_audit_log(id uuid pk, at timestamptz, admin_id uuid, action text, target_user_id uuid, details jsonb)` (update and delete refused by trigger); seed labels `person/Человек/user`, `owner/Настя/technical`, `family/Семья/user`, `checker/Проверка сайта/technical`, `technical/Тестовый/technical`.
- Produces: `public.admin_is_admin(p_user_id uuid) returns boolean`; `public.admin_list_labels() returns jsonb` (array of `{key,title,color,cost_class}` by `sort`); `public.admin_set_label(p_admin_id uuid, p_user_id uuid, p_label_key text) returns jsonb` → `{user_id,label_key,previous_label_key}`; raises `unknown_label` / `unknown_user`; writes one audit row `action='set_label'`, `details={from,to}` in the same transaction.

- [ ] **Step 1: Write the failing database test** (`describe("admin panel core on the real database")`, services via `adminClient()`, people via `admin.auth.admin.createUser` + profile upsert as in `tests/db/dynamicsFeedback.dbtest.ts`): `admin functions are closed to people` (signed-in client calling `rpc("admin_is_admin")` and `rpc("admin_list_labels")` gets an error; reading `admin_users`, `account_label_assignments`, `admin_audit_log` returns no rows or an error); `seed labels exist with the cost class of the spec`; `set_label writes the assignment and one audit row with from/to ids`; `setting the same label twice keeps one assignment`; `unknown label and unknown person fail with unknown_label / unknown_user and leave no audit row`; `the audit log cannot be updated or deleted, even by the service role`; `deleting a person removes the assignment and the admin flag`.
- [ ] **Step 2: Run it to see it fail.** Run: `node scratchpad/run_dbtest_on_rehearsal.mjs tests/db/adminPanel.dbtest.ts` (starts from `rehearsal.sh up`; helper script reads the rehearsal `.env` and runs the file with tsx). Expected: FAIL, relation/function does not exist.
- [ ] **Step 3: Write the migration** with the tables above (RLS enabled, no policies; `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `GRANT ALL … TO service_role`), the audit trigger raising on UPDATE/DELETE, and the three functions (`SECURITY DEFINER`, `SET search_path = ''`, `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`).
- [ ] **Step 4: Apply to the rehearsal database, run the test.** Run: `docker exec -i staysee-selfhost-db psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/migrations/20261120130000_097_admin_panel_core.sql` then the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): core tables, labels, audit log, admin_set_label`.

### Task 2: Read functions (overview, people, person card, costs, feedback, errors)

**Files:**
- Modify: `supabase/migrations/20261120130000_097_admin_panel_core.sql` (same migration, appended)
- Test: `tests/db/adminPanel.dbtest.ts`

**Interfaces:**
- Consumes: Task 1 tables; `auth.users`, `user_usage_tiers`, `user_consents`, `message_packs`, `conversations`, `messages`, `ai_usage_logs`, `message_feedback_review`, `dynamics_feedback_review`.
- Produces (all `jsonb`, same security as Task 1):
  - `admin_cost_class(p_cost_category text, p_label_cost_class text) returns text` (immutable): `'technical'` if `p_cost_category = 'technical'`, else `coalesce(p_label_cost_class,'user')`.
  - `admin_overview(p_since timestamptz default now() - interval '30 days')` → `{people:{total,registered_7d,registered_30d,by_label:[{key,title,count}],by_tier:[{tier,count}]},costs:{user_usd,technical_usd},errors_7d,feedback:{answers:{up,down},dynamics:{up,down}}}`.
  - `admin_people(p_search text default null, p_label text default null, p_limit int default 50, p_offset int default 0)` → `{total,rows:[{user_id,email,registered_at,last_sign_in_at,label_key,label_title,tier,conversations,user_messages,cost_user_usd,cost_technical_usd}]}` (costs over the last 30 days; limit clamped to 1..100; offset to ≥ 0).
  - `admin_person_card(p_user_id uuid)` → `{person:{…as a row…},consents:[{consent_type,document_version,consented_at}],tier:{tier,max_conversations_override},packs:[{messages_total,messages_left,purchased_at,expires_at}],costs:{by_kind:[{cost_class,kind,calls,usd}]},feedback:{answers:{up,down},dynamics:{up,down}},errors_7d}`; unknown person → `null`.
  - `admin_costs(p_since timestamptz, p_until timestamptz)` → `{totals:{user_usd,technical_usd},by_day:[{day,cost_class,usd}],by_kind:[{cost_class,kind,calls,usd}],by_person:[{user_id,email,cost_class,usd}]}` (top 20 persons).
  - `admin_feedback(p_kind text, p_rating int default null, p_limit int default 50, p_offset int default 0)` → `{rows:[…]}`; `p_kind` `'answers'` or `'dynamics'`, anything else raises `bad_kind`.
  - `admin_errors(p_since timestamptz default now() - interval '7 days', p_limit int default 100)` → `{by_code:[{error_code,count}],recent:[{created_at,model,call_kind,error_code,error_message,user_id}]}` (`error_message` cut to 200 characters).

- [ ] **Step 1: Write the failing tests** (same file): `people search is a case-insensitive prefix match and takes % _ \ and an apostrophe literally` (e.g. a person whose email starts `a_b` is found by `A_B` and not by `a%`); `a person without a label row is labelled person`; `a never-signed-in person has last_sign_in_at null`; `costs: a technical-labelled person's automatic rows count as technical, a person-labelled person's rows as user, and a row with cost_category technical is technical whoever owns it`; `admin_costs by_day sums to totals`; `admin_person_card of an unknown person is null`; `admin_feedback rejects an unknown kind`; `an offset beyond the end returns an empty page and the right total`; `admin_overview counts people by label and tier`; `admin_errors groups by code and cuts the message`. Seed `ai_usage_logs` rows through the admin client.
- [ ] **Step 2: Run to see it fail.** Command as in Task 1 Step 2. Expected: FAIL, functions missing.
- [ ] **Step 3: Implement the functions.** Prefix search: `lower(email) LIKE replace(replace(replace(lower(trim(p_search)),'\','\\'),'%','\%'),'_','\_') || '%' ESCAPE '\'`. Label default via `left join` + `coalesce(label_key,'person')`. Costs window: last 30 days for rows of people/cards, `p_since..p_until` for `admin_costs`.
- [ ] **Step 4: Apply the file to the rehearsal database, run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): read functions for people, costs, ratings, errors`.

### Task 3: Access guard and request parser (pure)

**Files:**
- Create: `supabase/functions/_shared/adminGuard.ts`
- Test: `supabase/functions/_shared/adminGuard.cases.test.ts`

**Interfaces:**
- Produces: `ADMIN_PASSWORD_MAX_AGE_SEC = 1800`; `type AdminClaims = { sub?: string; amr?: Array<{ method?: string; timestamp?: number }> }`; `decodeJwtClaims(token: string): AdminClaims | null` (payload only, no verification: the token is verified by Auth before); `passwordAgeSeconds(claims: AdminClaims, nowSec: number): number | null` (newest `amr` entry with `method === "password"`); `decideAdminAccess(input: { claims: AdminClaims | null; isAdmin: boolean; nowSec: number; maxAgeSec?: number }): { ok: true; adminId: string } | { ok: false; status: 401 | 403; reason: "invalid_token" | "not_admin" | "password_stale" }`; `type AdminAction = "overview" | "people" | "person" | "costs" | "feedback" | "errors" | "labels" | "set_label"`; `parseAdminRequest(body: unknown): { ok: true; action: AdminAction; params: Record<string, unknown> } | { ok: false; reason: "bad_request" }`.

- [ ] **Step 1: Write the failing tests** (`node:test`): `no claims or no sub is 401 invalid_token`; `a non-admin with a fresh password is 403 not_admin` (never 401 or ok); `a non-admin with a stale password is still 403 not_admin` (nothing is revealed); `an admin whose password entry is 31 minutes old is 401 password_stale`; `an admin with 29 minutes is ok`; `an admin whose amr has no password method is 401 password_stale`; `the newest of several password entries counts`; `decodeJwtClaims returns null for garbage and reads sub and amr from a well-formed token`; `parseAdminRequest accepts every action with valid params` and rejects: unknown action, non-object body, `limit` 0 or 101, negative `offset`, `search` over 100 characters, a `person` or `set_label` id that is not a UUID, `label_key` outside `^[a-z_]{1,32}$`, `kind` outside `answers|dynamics`, `rating` outside `-1|1|null`, `since` not an ISO date; defaults: `limit` 50, `offset` 0.
- [ ] **Step 2: Run.** Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/adminGuard.cases.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the signatures above; decode with `atob` on the base64url payload; allowlist of actions and per-action param shaping, unknown params dropped.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): access guard and request parser`.

### Task 4: `admin-api` edge function

**Files:**
- Create: `supabase/functions/admin-api/index.ts`
- Modify: `supabase/config.toml` (add `[functions.admin-api]` with `verify_jwt = true`)
- Test: `supabase/functions/_shared/adminApiWiring.cases.test.ts`

**Interfaces:**
- Consumes: `decodeJwtClaims`, `decideAdminAccess`, `parseAdminRequest` (Task 3); the `admin_*` functions (Tasks 1–2).
- Produces: `POST /functions/v1/admin-api` with body `{ action, params }`; success `{ ok: true, data }` (200); refusals `{ error: reason }` with status 401 / 403 / 400 / 405; `OPTIONS` for CORS (same headers as `weekly-reflection`). Order inside: method → parse body → verify token with Auth (`getUser`, anon key) → `admin_is_admin` through the service client → `decideAdminAccess` → dispatch to the matching RPC (`set_label` passes `p_admin_id` from the verified token, never from the body) → relay.

- [ ] **Step 1: Write the failing wiring test** (source reading, like `contextNoNarrativeBlock.cases.test.ts`): the file calls `getUser` before any `.rpc(` and `decideAdminAccess` before dispatch; no action reaches `.from(`; `set_label` takes the admin id from the verified user, not from `params`; only the service key is used for `.rpc(`; no `console.log` of emails or tokens; `config.toml` has `verify_jwt = true` for `admin-api`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the function in the style of `weekly-reflection/index.ts` (CORS constants, `Deno.serve`, service client via `SUPABASE_SERVICE_ROLE_KEY`).
- [ ] **Step 4: Run the wiring test, `deno check --node-modules-dir=none supabase/functions/admin-api/index.ts` (0 errors), and an end-to-end check on the rehearsal stack:** start `rehearsal.sh up`, apply 097, mark a made-up person as admin, sign in by password, call `admin-api` through the gateway (needs the function in `functions-build`: `node prepare-functions.mjs`). Expected: ordinary person 403; admin with a fresh token 200 `overview`; token without password method 401 `password_stale`; the token of the signed-in session contains `amr[0].method = "password"` (this is the one fact the guard depends on: if absent, stop and report).
- [ ] **Step 5: Commit** `feat(admin): admin-api edge function`.

### Task 5: Frontend plumbing (path, API client, formatting, closed entry)

**Files:**
- Create: `src/lib/admin/adminPath.ts`, `src/lib/admin/adminApi.ts`, `src/lib/admin/format.ts`
- Modify: `src/main.tsx` (open the admin root when the path is an admin path)
- Test: `src/lib/admin/adminPath.cases.test.ts`, `src/lib/admin/adminApi.cases.test.ts`, `src/lib/admin/format.cases.test.ts`

**Interfaces:**
- Produces: `isAdminPath(pathname: string): boolean` (true for `/admin`, `/admin/`, `/admin/x`; false for `/`, `/administrator`, `/admin-x`, `/x/admin`); `interface AdminApiDeps { fetch: typeof fetch; getAccessToken(): Promise<string | null>; getPublicConfig(): { url: string; anonKey: string } }`; `type AdminCallResult<T> = { ok: true; data: T } | { ok: false; status: number; reason: string }`; `callAdmin<T>(deps: AdminApiDeps, action: string, params?: Record<string, unknown>): Promise<AdminCallResult<T>>` (no token → `{ok:false,status:401,reason:"no_session"}`; network failure → `status 0, reason "network"`); `formatUsd(value: number | null | undefined): string` (`"1,94 $"`, `"—"` for null); `formatMoscow(iso: string | null | undefined): string` (`"20.11.2026 04:21"`, `"—"` for null); `costClassTitle(c: "user" | "technical"): string` (`"Пользовательские"` / `"Технические"`).

- [ ] **Step 1: Write the failing tests:** `isAdminPath` cases above; `callAdmin` sends `POST {url}/functions/v1/admin-api` with `Authorization: Bearer <token>`, `Apikey`, body `{action,params}`, maps 200 `{ok:true,data}` to data and a 401/403 body `{error}` to `{ok:false,status,reason}`, handles no token and a thrown fetch; formatting cases including a `Number.NaN`.
- [ ] **Step 2: Run.** Run: `node node_modules/tsx/dist/cli.mjs src/lib/admin/adminPath.cases.test.ts` (and the other two). Expected: FAIL.
- [ ] **Step 3: Implement** the three modules; in `src/main.tsx` render `import("./admin/AdminApp.tsx")` (a separate chunk) when `isAdminPath(window.location.pathname)`, otherwise the current tree unchanged.
- [ ] **Step 4: Run the tests, `npm run typecheck`, `npm run lint`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): closed entry, api client, formatting`.

### Task 6: Admin shell and sections

**Files:**
- Create: `src/admin/AdminApp.tsx` (gate + shell + section switch), `src/admin/AdminGate.tsx`, `src/admin/sections/OverviewSection.tsx`, `PeopleSection.tsx` (list, search, filter by label, card, label change with confirmation), `CostsSection.tsx`, `FeedbackSection.tsx`, `ErrorsSection.tsx`, `src/lib/admin/adminViewModels.ts`
- Test: `src/lib/admin/adminViewModels.cases.test.ts`

**Interfaces:**
- Consumes: `callAdmin`, `formatUsd`, `formatMoscow`, `costClassTitle` (Task 5); the response shapes of Task 2.
- Produces (pure, in `adminViewModels.ts`): `toPersonRow(row: AdminPersonRow): { id: string; email: string; label: string; tier: string; lastLogin: string; registered: string; userCost: string; technicalCost: string; conversations: number; messages: number }` (formats, `—` for missing); `splitCostTotals(totals: {user_usd: number; technical_usd: number}): Array<{ title: string; value: string }>`; `pageInfo(total: number, limit: number, offset: number): { from: number; to: number; hasPrev: boolean; hasNext: boolean }`; `labelChangeMessage(personEmail: string, fromTitle: string, toTitle: string): string` (the confirmation text: `«Поменять метку у {email}: {from} → {to}?»`).
- Gate behaviour: no session or `password_stale` → one form (email prefilled, password) that calls `supabase.auth.signInWithPassword` and retries; `403` → `window.location.replace("/")` with no message; `ok` → the shell. Sections are switched by state (no URLs inside the panel).

- [ ] **Step 1: Write the failing tests** for the four view-model functions (missing last login → `"—"`; zero costs `"0,00 $"`; `pageInfo` at the first page, the last page, an offset beyond the end, `total` 0; the confirmation text).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the view models, then the components** (reuse the look of the existing screens: `useTheme`, no new design system). Costs section shows two cards (user / technical) and the by-kind table under each; people section shows label as a coloured chip and the label change as a select that asks for the confirmation text before calling `set_label`; feedback section has two tabs (answers / dynamics) and a "bad only" switch; errors section shows by-code counts and the recent list.
- [ ] **Step 4: Run the tests, `npm run typecheck`, `npm run lint`, `npm run test:offline`, `npm run build`** and check the admin code is in its own chunk (`dist/assets/AdminApp-*.js` exists and is not referenced by the main `index-*.js` entry statically). Expected: all pass.
- [ ] **Step 5: Commit** `feat(admin): panel shell and sections`.

### Task 7: Release, first admin, live check (runbook, no new code)

**Files:** none (commands). Record the result in `docs/superpowers/specs/2026-11-20-admin-panel-design.md` under a "Status" line.

- [ ] **Step 1: Open the pull request, wait for CI** (`gh pr checks --watch`); expected: `db-integration` pass.
- [ ] **Step 2: Apply the migration to production:** `npx supabase db push --remote=jnxrildlwvtxhtiwucbt --dry-run` (expect exactly `…097_admin_panel_core.sql`), then `--yes`; verify with a read-only query that the tables, the 5 seed labels and the functions exist and that `anon`/`authenticated` have no execute right on `admin_*`.
- [ ] **Step 2b: Deploy the function:** `npx supabase functions deploy admin-api --project-ref jnxrildlwvtxhtiwucbt --use-api --yes`; list versions.
- [ ] **Step 3: Merge the pull request** (site deploys by itself); expect the deploy run `success`.
- [ ] **Step 4: Make the owner an admin:** one statement through `npx supabase db query --remote` inserting into `admin_users` the id of the owner's account found by her email (the email typed only in that command, not stored in the repo); confirm with a read-only count.
- [ ] **Step 5: Live check with the owner:** she opens `/admin`, enters her password, sees the overview; an ordinary account opening `/admin` lands on the normal app; she sets one label and I confirm the audit row with a read-only query (ids only).

---

## Self-review (done)

- **Spec coverage:** closed address (T5, T6), admin flag + fresh password (T1, T3, T4, T6), people/search/card/last login (T2, T6), tariffs (overview and card, T2), ratings answers + dynamics (T2, T6), costs technical vs user (T2, T6), errors (T2, T6), labels and their one condition (T1, T2, T6), audit log (T1), no conversation text (Constraints, T4 wiring), release order (T7). Not in this plan on purpose: blocking, tariff/limit changes, packs, password reset, payments, mailings, referrals (stages 2–3).
- **Types:** the action names and the `admin_*` names are the same in T2, T3, T4; `AdminPersonRow` in T6 is the `rows[]` item of `admin_people` in T2.
- **Proportion:** tasks give signatures, test names, values; bodies are left to the implementer.
