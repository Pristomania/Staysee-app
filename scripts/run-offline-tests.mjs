import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TSX_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

function collectFiles(directory, suffix) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(path);
    }
  }

  return files.sort();
}

const groups = [
  {
    name: 'shared functions',
    executable: process.execPath,
    prefixArgs: [TSX_CLI, '--test'],
    files: collectFiles(join(PROJECT_ROOT, 'supabase', 'functions', '_shared'), '.cases.test.ts'),
  },
  {
    name: 'frontend',
    executable: process.execPath,
    prefixArgs: [TSX_CLI, '--test'],
    files: collectFiles(join(PROJECT_ROOT, 'src'), '.cases.test.ts'),
  },
  {
    name: 'TypeScript scripts',
    executable: process.execPath,
    prefixArgs: [TSX_CLI, '--test'],
    files: collectFiles(join(PROJECT_ROOT, 'scripts'), '.test.ts'),
  },
  {
    name: 'JavaScript scripts',
    executable: process.execPath,
    prefixArgs: ['--test'],
    files: collectFiles(join(PROJECT_ROOT, 'scripts'), '.test.mjs'),
  },
];

for (const group of groups) {
  assert.ok(group.files.length > 0, `no tests found for ${group.name}`);
  console.log(`[test:offline] ${group.name}: ${group.files.length} files`);
  const result = spawnSync(
    group.executable,
    [...group.prefixArgs, ...group.files],
    { cwd: PROJECT_ROOT, stdio: 'inherit' },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
