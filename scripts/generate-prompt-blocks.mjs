/**
 * Generate edge-safe prompt block modules from docs/*.md (byte-exact copy).
 * Run: node scripts/generate-prompt-blocks.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "supabase/functions/_shared/promptBlocks");

function escapeTemplateLiteral(raw) {
  return raw.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function emitModule(exportName, sourcePath, destName, header) {
  const raw = readFileSync(resolve(root, sourcePath), "utf8");
  const body = `${header}
/** Source: ${sourcePath} — regenerate via scripts/generate-prompt-blocks.mjs */
export const ${exportName} = \`
${escapeTemplateLiteral(raw)}
\`.trim();
`;
  writeFileSync(resolve(outDir, destName), body, "utf8");
  console.log(`${destName}: ${raw.length} chars`);
}

mkdirSync(outDir, { recursive: true });

const rollbackV21 = process.argv.includes("--rollback-v21");

emitModule(
  "VOICE_BLOCK",
  "docs/VOICE_OF_STAYSEE.md",
  "voiceBlock.ts",
  "/** StaySee Voice layer — bundled for Supabase Edge (no filesystem reads). */",
);

if (rollbackV21) {
  emitModule(
    "CONSTITUTION_V21",
    "docs/CONSTITUTION_FULL_V2_1.md",
    "constitutionV21.ts",
    "/** ROLLBACK ONLY — Constitution v2.1. Not used by surgery1-v3-cognitive-v1. */",
  );
} else {
  console.log("skip constitutionV21.ts (rollback: node scripts/generate-prompt-blocks.mjs --rollback-v21)");
}

emitModule(
  "CONSTITUTION_V3_BETA",
  "docs/CONSTITUTION_V3_BETA.md",
  "constitutionV3Beta.ts",
  "/** StaySee Constitution V3 Beta — bundled for Supabase Edge (no filesystem reads). */",
);

emitModule(
  "COGNITIVE_SIGNATURE_V1",
  "docs/COGNITIVE_SIGNATURE_V1.md",
  "cognitiveSignature.ts",
  "/** StaySee Cognitive Signature v1 — bundled for Supabase Edge (no filesystem reads). */",
);

console.log("OK → supabase/functions/_shared/promptBlocks/");
