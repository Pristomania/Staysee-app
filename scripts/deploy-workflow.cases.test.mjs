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

  it('builds the real site on GitHub and uploads the finished files to the server in Russia, whose identity it checks first', () => {
    // Moved on 28.11.2026: the old server could not be reached from Russia. The new one has no git and no Node: nothing is built on it.
    const deploy = workflow.slice(position('\n  deploy:'));
    assert.match(deploy, /VITE_SUPABASE_ANON_KEY: \$\{\{ vars\.STAYSEE_SUPABASE_ANON_KEY \}\}/u);
    assert.match(deploy, /test -n "\$VITE_SUPABASE_ANON_KEY"/u, 'an empty public key stops the update instead of publishing a broken site');
    for (const name of ['RU_HOST', 'RU_USER', 'RU_SSH_KEY', 'RU_HOST_FINGERPRINT']) {
      assert.ok(deploy.includes(`secrets.${name}`), name);
    }
    assert.match(deploy, /StrictHostKeyChecking=yes/u);
    assert.ok(deploy.indexOf('ssh-keygen -lf') < deploy.indexOf('rsync -az'), 'the identity is checked before anything is sent');
    assert.match(deploy, /rsync -az --delete[^\n]*dist\/ [^\n]*:\/var\/www\/Staysee-app\/dist\//u);
    assert.match(deploy, /sudo -n \/usr\/local\/bin\/staysee-apply-nginx/u);
    assert.doesNotMatch(workflow, /secrets\.STAYSEE_/u, 'nothing is sent to the old server any more');
  });

  it('checks the new server itself after the upload: the page and the way to the database', () => {
    const verify = workflow.slice(position('name: Verify production site'));
    assert.match(verify, /--resolve "staysee\.ru:443:\$RU_HOST" https:\/\/staysee\.ru\/ /u);
    assert.match(verify, /https:\/\/staysee\.ru\/supabase\/auth\/v1\/health/u);
    assert.match(verify, /200\|401\)/u);
  });

  it('keeps the complete offline suite and bundle smoke behind package scripts', () => {
    assert.equal(
      packageJson.scripts['test:offline'],
      'node scripts/run-offline-tests.mjs',
    );
    assert.equal(packageJson.scripts['smoke:bundle'], 'node scripts/smoke-built-site.mjs');
  });
});
