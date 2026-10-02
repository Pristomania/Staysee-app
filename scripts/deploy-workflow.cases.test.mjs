import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

function position(fragment) {
  const index = workflow.indexOf(fragment);
  assert.notEqual(index, -1, `deploy workflow is missing: ${fragment}`);
  return index;
}

describe('production deployment gate', () => {
  it('runs verification once, on push to main -- not duplicated on pull requests too', () => {
    // A PR and the push that merges it carry the exact same tree, so
    // verifying both doubled the wait on every change without catching
    // anything a single run on push wouldn't already catch.
    assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/u);
    assert.doesNotMatch(workflow, /pull_request:/u);
    assert.match(workflow, /VITE_SUPABASE_URL: https:\/\/staysee\.ru\/supabase/u);
    assert.match(workflow, /VITE_SUPABASE_ANON_KEY: ci-public-build-placeholder/u);
  });

  it('runs every required offline gate in order', () => {
    assert.match(workflow, /node-version: 22/u);
    assert.match(workflow, /verify:\s*\n\s*runs-on: windows-latest/u);
    assert.match(workflow, /verify-linux-build:\s*\n\s*runs-on: ubuntu-latest/u);
    const commands = [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm run test:offline',
      'npm run build',
      'npm audit --omit=dev --audit-level=high',
      'npm run smoke:bundle',
    ];
    const positions = commands.map(position);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  it('deploys only after both verification jobs pass, and checks production afterwards', () => {
    // No separate `if: github.event_name == 'push'` guard is needed any
    // more -- push is the workflow's only trigger now, so every run that
    // reaches this job already is one.
    assert.match(workflow, /deploy:\s*\n\s*needs: \[verify, verify-linux-build\]/u);
    assert.match(workflow, /curl[^\n]*https:\/\/staysee\.ru\//u);
  });

  it('keeps the complete offline suite and bundle smoke behind package scripts', () => {
    assert.equal(
      packageJson.scripts['test:offline'],
      'node scripts/run-offline-tests.mjs',
    );
    assert.equal(packageJson.scripts['smoke:bundle'], 'node scripts/smoke-built-site.mjs');
  });
});
