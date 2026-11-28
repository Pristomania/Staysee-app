import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it} from 'node:test';

it('renders the shared emergency contacts as callable links and protects the external directory link',async()=>{
  const feature=await import('../src/components/EmergencyHelpContacts').catch(()=>null);
  assert.ok(feature?.EmergencyHelpContacts,'shared contact renderer exists');
  const html=renderToStaticMarkup(createElement(feature.EmergencyHelpContacts));
  for(const href of ['tel:112','tel:103','tel:+74959895050','tel:88002000122'])assert.ok(html.includes(`href="${href}"`));
  assert.match(html, /href="https:\/\/findahelpline.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.equal((html.match(/<a /g)??[]).length,5);
});
