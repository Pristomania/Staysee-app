import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasImagesConsent, IMAGES_CONSENT_TYPE, IMAGES_CONSENT_VERSION } from "./imageConsent.ts";

// The part of the Supabase client the check uses: from().select().eq().eq().eq() answering { count, error }.
function fakeClient(answer: { count: number | null; error: unknown }, seen: unknown[][] = []) {
  return {
    from(table: string) {
      seen.push(["from", table]);
      const chain = {
        select: (...args: unknown[]) => { seen.push(["select", ...args]); return chain; },
        eq: (...args: unknown[]) => {
          seen.push(["eq", ...args]);
          return seen.filter((s) => s[0] === "eq").length === 3 ? Promise.resolve(answer) : chain;
        },
      };
      return chain;
    },
  };
}

describe("the picture consent check", () => {
  it("looks for the person's consent of this kind and this version of the notice", async () => {
    const seen: unknown[][] = [];
    assert.equal(await hasImagesConsent(fakeClient({ count: 1, error: null }, seen), "u1"), true);
    assert.deepEqual(seen.filter((s) => s[0] === "from"), [["from", "user_consents"]]);
    assert.deepEqual(seen.filter((s) => s[0] === "eq"), [
      ["eq", "user_id", "u1"],
      ["eq", "consent_type", IMAGES_CONSENT_TYPE],
      ["eq", "document_version", IMAGES_CONSENT_VERSION],
    ]);
    assert.equal(IMAGES_CONSENT_TYPE, "images");
  });

  it("says no when there is no such row", async () => {
    assert.equal(await hasImagesConsent(fakeClient({ count: 0, error: null }), "u1"), false);
  });

  it("throws when it cannot be read, so the caller refuses instead of guessing", async () => {
    await assert.rejects(hasImagesConsent(fakeClient({ count: null, error: { message: "x" } }), "u1"));
    await assert.rejects(hasImagesConsent(fakeClient({ count: null, error: null }), "u1"));
  });
});
