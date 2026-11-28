// The move of 28.11.2026: the database, the sign-in and the server functions run on the app's own server in Russia (Beget),
// behind the same /supabase/ address. Nothing may keep pointing at the old cloud project.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isProdSupabaseUrl, isProductionProjectUrl } from './lib/prod-test-env.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r/g, '');

describe('the app works with its own database', () => {
  it('nginx hands /supabase/ to the stack on this server, under both of its configurations', () => {
    for (const file of ['deploy/nginx/staysee.ru.conf', 'deploy/nginx/staysee.ru.no-http2.conf']) {
      const config = read(file);
      const block = config.slice(config.indexOf('location /supabase/ {'));
      const location = block.slice(0, block.indexOf('\n    }') + 1);
      assert.match(location, /rewrite \^\/supabase\/\(\.\*\)\$ \/\$1 break;/, file);
      assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:8100;/, file);
      assert.match(location, /proxy_set_header X-Forwarded-Proto https;/, file);
      assert.match(location, /proxy_read_timeout 150s;/, file);
      assert.doesNotMatch(config, /supabase\.co/, file);
    }
  });

  it('the hourly check of the memory asks the function on this server', () => {
    const workflow = read('.github/workflows/memory-health.yml');
    assert.match(workflow, /https:\/\/app\.stayseeai\.online\/supabase\/functions\/v1\/memory-health-check/);
    assert.doesNotMatch(workflow, /supabase\.co/);
  });

  it('letters lead to the public address of the server and to the app', () => {
    const letters = read('supabase/functions/auth-email/index.ts');
    assert.match(letters, /const serviceUrl = required\('SUPABASE_URL'\);/);
    assert.match(letters, /const authUrl = Deno\.env\.get\('STAYSEE_PUBLIC_API_URL'\) \?\? serviceUrl;/);
    assert.match(letters, /const siteUrl = Deno\.env\.get\('STAYSEE_SITE_URL'\) \?\? 'https:\/\/app\.stayseeai\.online';/);
    assert.match(letters, /createClient\(serviceUrl,/);
  });

  it('scripts treat the new addresses as production, with the same protections', () => {
    for (const url of ['https://app.stayseeai.online/supabase', 'https://staysee.ru/supabase', 'https://www.staysee.ru/supabase/']) {
      assert.equal(isProdSupabaseUrl(url), true, url);
      assert.equal(isProductionProjectUrl(url), true, url);
    }
    assert.equal(isProdSupabaseUrl('http://127.0.0.1:54321'), false);
    assert.equal(isProductionProjectUrl('https://example.supabase.co'), false);
  });
});
