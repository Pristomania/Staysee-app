import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const auth = readFileSync(new URL("../src/context/AuthContext.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../src/components/screens/LoginScreen.tsx", import.meta.url), "utf8");

describe("the links in the e-mails lead back to the site the person is on", () => {
  it("the confirmation link of a new account is told where to lead", () => {
    assert.match(auth, /emailRedirectTo\s*=\s*typeof window === 'undefined' \? undefined : window\.location\.origin/);
    assert.match(auth, /supabase\.auth\.signUp\(\{[\s\S]*?emailRedirectTo[\s\S]*?\}\),/, "it is passed to signUp");
    assert.match(auth, /\.\.\.\(metadata \? \{ data: metadata \} : \{\}\)/, "the consents still go along");
  });

  it("the password reset link is told the same", () => {
    assert.match(login, /redirectTo:\s*window\.location\.origin/);
  });
});
