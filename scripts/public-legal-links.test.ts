import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';

it('opens the exact public document in a separate tab without an opener', async () => {
  const feature = await import('../src/components/legal/PublicLegalLinks').catch(() => null);
  assert.ok(feature?.PublicDocumentLink, 'public document link component is implemented');
  for (const [document, path] of [['terms', 'offer.html'], ['policy', 'app-privacy.html'], ['consent', 'consent.html']] as const) {
    const html = renderToStaticMarkup(createElement(feature.PublicDocumentLink, {document, children: 'Документ'}));
    assert.ok(html.includes(`href="https://stayseeai.online/${path}"`));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(!html.includes('onClick'));
  }
});

it('offers unauthenticated visitors all five application documents', async () => {
  const feature = await import('../src/components/legal/PublicLegalLinks').catch(() => null);
  assert.ok(feature?.PublicLegalLinks, 'public navigation is implemented');
  const html = renderToStaticMarkup(createElement(feature.PublicLegalLinks));
  for (const path of ['offer.html', 'app-privacy.html', 'consent.html', 'pricing.html', 'contacts.html']) {
    assert.ok(html.includes(`https://stayseeai.online/${path}`));
  }
  assert.ok(!html.includes('/privacy.html'), 'the waitlist consent is not the app consent');
});

it('pins registration to a generated immutable document, not the moving canonical page', async () => {
  const feature = await import('../src/components/legal/PublicLegalLinks');
  const { OFFER_META } = await import('../src/content/legal/offer');
  const { buildVersionedPages } = await import('./build-site-pages.mjs');
  assert.equal(typeof buildVersionedPages, 'function', 'versioned public documents are generated');
  const html = renderToStaticMarkup(createElement(feature.PublicDocumentLink, {document: 'terms', pinned: true, children: 'Оферта'}));
  const expected = `offer-v${OFFER_META.version}-${OFFER_META.sha256.slice(0, 12)}.html`;
  assert.ok(html.includes(`https://stayseeai.online/${expected}`));
  assert.ok(buildVersionedPages()[expected]?.includes('Пользовательское соглашение'));
});
