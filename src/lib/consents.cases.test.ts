import { CONSENT_TYPES, signUpConsentMetadata } from './consents';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

// The names are the ones the database and the server use (user_consents.consent_type).
same(CONSENT_TYPES, { terms: 'terms', pdProcessing: 'pd_processing', images: 'images' }, 'consent types');

const terms = { version: '1.1', sha256: 'a'.repeat(64) };
const pd = { version: '1.2', sha256: 'b'.repeat(64) };

// At sign-up the two agreements travel in the new account's metadata; the database writes the log with its own time.
same(
  signUpConsentMetadata({ terms, pd_processing: pd }, 'Mozilla/5.0 test'),
  { consents: { terms, pd_processing: pd, user_agent: 'Mozilla/5.0 test' } },
  'sign-up metadata',
);

// A very long browser string is cut, an empty one stays empty, nothing else is added.
const long = signUpConsentMetadata({ terms, pd_processing: pd }, 'x'.repeat(1000));
assert(long.consents.user_agent.length === 300, 'user agent is cut to 300');
assert(signUpConsentMetadata({ terms, pd_processing: pd }, '').consents.user_agent === '', 'empty user agent');
assert(Object.keys(long.consents).sort().join() === 'pd_processing,terms,user_agent', 'only the agreed fields');

console.log('consents.cases.test.ts passed');
