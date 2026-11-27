import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const hosts = [...read('src/lib/appOrigins.ts').match(/new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('the extra addresses of the app are wired everywhere they are needed', () => {
  it('are used for the database and for the voice dictation files', () => {
    assert.match(read('src/lib/supabaseEnv.ts'), /url: ownOriginBase\(globalThis\.location, '\/supabase', url\)/);
    assert.match(read('src/lib/voiceModelCache.ts'), /VOICE_MODEL_BASE_URL = ownOriginBase\(/);
  });

  it('are served by nginx under every one of these names, next to staysee.ru', () => {
    assert.ok(hosts.length >= 1);
    for (const file of ['deploy/nginx/staysee.ru.conf', 'deploy/nginx/staysee.ru.no-http2.conf']) {
      const names = [...read(file).matchAll(/^\s*server_name ([^;]+);/gm)].map((m) => m[1].trim().split(/\s+/));
      assert.equal(names.length, 2, file);
      for (const list of names) {
        for (const host of ['staysee.ru', 'www.staysee.ru', ...hosts]) assert.ok(list.includes(host), `${file}: ${host}`);
      }
    }
  });
});
