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
  it('runs verification for pull requests and pushes to main', () => {
    assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\n\s*- main/u);
    assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/u);
  });

  it('runs every required offline gate in order', () => {
    assert.match(workflow, /node-version: 22/u);
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

  it('deploys only a verified push and checks production afterwards', () => {
    assert.match(workflow, /deploy:\s*\n\s*if: github\.event_name == 'push'/u);
    assert.match(workflow, /needs: verify/u);
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
