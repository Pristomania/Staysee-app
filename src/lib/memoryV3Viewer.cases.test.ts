// memoryV3Viewer.ts imports the real Supabase client at module scope, which
// reads Vite's import.meta.env (only populated inside a Vite build/dev run)
// -- importing it directly here throws. Same raw-source-regex convention as
// conversationDynamicsView.cases.test.ts for the same reason.
//
// This file exists because MemoryV3ViewerItem and MemoryV3ExportItem are
// each duplicated as two independent TypeScript interfaces -- one here
// (frontend), one in supabase/functions/_shared/memoryV3/viewerProjection.ts
// (backend) -- with no shared import between them and no runtime validation
// of the API response shape (callMemoryV3Viewer casts with `as T`). This is
// exactly the class of defect behind today's critical bug (two independent
// copies of the same field list quietly drifting apart): nothing stops
// someone from renaming or dropping a field on one side without touching
// the other, and nothing would catch it until it breaks in production.
const nodeFs = (await import(/* @vite-ignore */ "node:fs/promises" as string)) as {
  readFile: (path: URL, encoding: string) => Promise<string>;
};

function assertMatch(value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) throw new Error(`${message}: expected to match ${pattern}`);
}

function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const start = source.indexOf(`interface ${interfaceName} {`);
  if (start === -1) throw new Error(`interface ${interfaceName} not found`);
  const end = source.indexOf("}", start);
  const body = source.slice(start, end);
  const fields = [...body.matchAll(/^\s*(\w+)[?:]/gm)].map((m) => m[1]);
  if (fields.length === 0) throw new Error(`no fields parsed for ${interfaceName}`);
  return fields.sort();
}

const frontendSource = await nodeFs.readFile(new URL("./memoryV3Viewer.ts", import.meta.url), "utf8");
const backendSource = await nodeFs.readFile(
  new URL("../../supabase/functions/_shared/memoryV3/viewerProjection.ts", import.meta.url),
  "utf8",
);

for (const interfaceName of ["MemoryV3ViewerItem", "MemoryV3ExportItem"]) {
  const frontendFields = extractInterfaceFields(frontendSource, interfaceName);
  const backendFields = extractInterfaceFields(backendSource, interfaceName);
  if (JSON.stringify(frontendFields) !== JSON.stringify(backendFields)) {
    throw new Error(
      `${interfaceName} drifted between frontend and backend.\n` +
      `frontend (memoryV3Viewer.ts): ${JSON.stringify(frontendFields)}\n` +
      `backend (viewerProjection.ts): ${JSON.stringify(backendFields)}`,
    );
  }
}

// Sanity check the extraction itself isn't vacuously passing (e.g. both
// sides empty due to a regex that stopped matching after a refactor).
assertMatch(frontendSource, /interface MemoryV3ExportItem \{[\s\S]*?replacesMemoryKey/, "sanity: MemoryV3ExportItem should still have replacesMemoryKey");

console.log("PASS: memoryV3Viewer.cases.test.ts");
