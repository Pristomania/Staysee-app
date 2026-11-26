// Checks that the self-hosted stack works the way the app needs it. Prints PASS/FAIL per check, never prints a key or a password.
// Run: node smoke.mjs     (the stack must be up; migrations applied)
// Exit code 1 if any check failed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const base = `http://127.0.0.1:${env.API_PORT_ON_HOST || 8100}`;
const anon = env.ANON_KEY;
const service = env.SERVICE_ROLE_KEY;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const call = async (path, { method = "GET", token, apikey = anon, body, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(apikey ? { apikey } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
};

const stamp = Date.now();
const password = `Pw-${stamp}-aB9!`;
const makeUser = async (label) => {
  const email = `rehearsal-${label}-${stamp}@example.invalid`;
  const signup = await call("/auth/v1/signup", { method: "POST", body: { email, password } });
  const login = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  return { email, signup, login, token: login.json?.access_token, id: login.json?.user?.id };
};

// 1. Gateway + Auth
const health = await call("/auth/v1/health");
check("Auth answers through the gateway", health.status === 200, `HTTP ${health.status}`);

const noKey = await call("/rest/v1/conversations?select=id", { apikey: null });
check("The gateway refuses a request without an API key", noKey.status === 401, `HTTP ${noKey.status}`);

const alice = await makeUser("a");
check("Sign-up and sign-in by e-mail work", Boolean(alice.token && alice.id), `signup HTTP ${alice.signup.status}, login HTTP ${alice.login.status}`);
const bob = await makeUser("b");

if (alice.token) {
  // 2. Database through the API, as the app does it. The app creates the profile itself after sign-in (src/lib/ensureProfile.ts),
  // and a conversation can be created only by a person who has one.
  for (const person of [alice, bob]) {
    if (person.token) await call("/rest/v1/profiles", { method: "POST", token: person.token, body: { id: person.id, email: person.email } });
  }
  const conv = await call("/rest/v1/conversations", {
    method: "POST",
    token: alice.token,
    body: { user_id: alice.id, title: "" },
    headers: { Prefer: "return=representation" },
  });
  const convId = Array.isArray(conv.json) ? conv.json[0]?.id : conv.json?.id;
  check("A person can create a conversation", conv.status === 201 && Boolean(convId), `HTTP ${conv.status}`);

  const msg = await call("/rest/v1/messages", {
    method: "POST",
    token: alice.token,
    body: { conversation_id: convId, sender: "user", role: "user", content: "проверка связи", user_id: alice.id },
    headers: { Prefer: "return=representation" },
  });
  check("A person can write a message", msg.status === 201, `HTTP ${msg.status}${msg.status === 201 ? "" : `, ${msg.text.slice(0, 160)}`}`);

  const own = await call(`/rest/v1/messages?conversation_id=eq.${convId}&select=id,content`, { token: alice.token });
  check("A person reads their own message back", own.status === 200 && Array.isArray(own.json) && own.json.length === 1, `HTTP ${own.status}, rows ${Array.isArray(own.json) ? own.json.length : "?"}`);

  // 3. Row level security: nobody else sees it
  const anonRead = await call(`/rest/v1/messages?conversation_id=eq.${convId}&select=id`);
  const anonRows = Array.isArray(anonRead.json) ? anonRead.json.length : 0;
  check("Without signing in, the message is invisible", anonRows === 0, `HTTP ${anonRead.status}, rows ${anonRows}`);

  if (bob.token) {
    const bobRead = await call(`/rest/v1/messages?conversation_id=eq.${convId}&select=id`, { token: bob.token });
    const bobRows = Array.isArray(bobRead.json) ? bobRead.json.length : 0;
    check("Another signed-in person cannot see it either", bobRead.status === 200 && bobRows === 0, `HTTP ${bobRead.status}, rows ${bobRows}`);
  }
}

// 4. Edge functions
const noToken = await call("/functions/v1/staysee-chat", { method: "POST", apikey: null, body: {} });
check("A chat request without a login token is refused by the router", noToken.status === 401 && /^UNAUTHORIZED/.test(noToken.json?.code ?? ""), `HTTP ${noToken.status}, ${noToken.json?.code ?? ""}`);

const open = await call("/functions/v1/memory-health-check", { method: "POST", apikey: null, body: {}, headers: { "X-Health-Secret": "wrong" } });
check("memory-health-check is reachable without a login token (it checks its own secret)", open.status !== 401 || !/^UNAUTHORIZED/.test(open.json?.code ?? ""), `HTTP ${open.status}, ${open.text.slice(0, 80)}`);

if (alice.token) {
  const chat = await call("/functions/v1/staysee-chat", { method: "POST", token: alice.token, body: {} });
  const booted = chat.status !== 503 && !/BOOT_ERROR|WORKER_ERROR/.test(chat.text);
  check("staysee-chat starts and answers a logged-in request (no model keys here, so a refusal is expected)", booted, `HTTP ${chat.status}, ${chat.text.slice(0, 100).replace(/\s+/g, " ")}`);
}

// 5. Database extras the app depends on (asked inside the container)
const psql = (sql) =>
  execFileSync("docker", ["exec", "staysee-selfhost-db", "psql", "-U", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();
try {
  const ext = psql("select string_agg(extname, ',' order by extname) from pg_extension where extname in ('vector','pg_cron')");
  check("Extensions vector and pg_cron are installed", ext === "pg_cron,vector", ext);
  const jobs = Number(psql("select count(*) from cron.job"));
  check("The four daily jobs of pg_cron exist", jobs === 4, `jobs ${jobs}`);
  const tables = Number(psql("select count(*) from information_schema.tables where table_schema = 'public'"));
  check("The tables of the app exist", tables >= 30, `tables ${tables}`);
} catch (error) {
  check("Database checks could run", false, String(error.message).slice(0, 120));
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
