import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAll } from './build-site-pages.mjs';

describe('documents for the public storefront', () => {
  const pages = buildAll();

  it('offers only available plans and a separately priced message pack', () => {
    const html = pages['pricing.html'];
    assert.match(html, /data-plan="free"/);
    assert.match(html, /data-plan="basic"/);
    assert.doesNotMatch(html, /data-plan="premium"/);
    assert.match(html, /data-product="pack100"/);
    assert.match(html, /590/);
    assert.match(html, /100 сообщений/);
    assert.match(html, /12 месяцев/);
  });

  it('contains the actual product prices in the offer itself, not just a link', () => {
    const offer = pages['offer.html'];
    assert.match(offer, /<table>/);
    assert.match(offer, /1(?:\s|&nbsp;)*990/);
    assert.match(offer, /400/);
    assert.match(offer, /590/);
    assert.doesNotMatch(offer, /4(?:\s|&nbsp;)*900/);
    assert.doesNotMatch(offer, /\{\{[^}]+\}\}/);
  });

  it('keeps application documents separate from the waitlist and names the app address', () => {
    for (const html of Object.values(pages)) {
      assert.match(html, /href="https:\/\/app\.stayseeai\.online\/?"/);
      assert.match(html, /href="https:\/\/t\.me\/StaySee_AI"/);
      assert.match(html, /href="\/privacy\.html"/);
      assert.match(html, /href="\/app-privacy\.html"/);
    }
  });
});
