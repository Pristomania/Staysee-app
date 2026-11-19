// Builds deploy/supabase-selfhost/functions-build: the app functions (supabase/functions) + the router (functions-main).
// The edge runtime serves /home/deno/functions/<name>; the folder "main" is the router that picks the function by the first part of the path.
// Run: node prepare-functions.mjs   (safe to repeat: the folder is rebuilt from scratch)
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../supabase/functions");
const router = resolve(here, "functions-main");
const target = resolve(here, "functions-build");

if (!existsSync(source)) throw new Error(`no functions folder at ${source}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// Tests and notes are not needed at run time.
const skip = (path) => !/\.(test|cases\.test)\.(ts|mts)$/.test(basename(path)) && basename(path) !== "README.md";
cpSync(source, target, { recursive: true, filter: skip });

cpSync(resolve(router, "deno.jsonc"), resolve(target, "deno.jsonc"));
mkdirSync(resolve(target, "main"), { recursive: true });
cpSync(resolve(router, "index.ts"), resolve(target, "main/index.ts"));
cpSync(resolve(router, "memory-pressure.ts"), resolve(target, "main/memory-pressure.ts"));
console.log(`functions-build ready: ${target}`);
