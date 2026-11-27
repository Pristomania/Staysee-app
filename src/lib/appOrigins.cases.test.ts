import { EXTRA_APP_HOSTS, ownOriginBase } from './appOrigins';

function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const at = (address: string) => {
  const u = new URL(address);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
};
const fallback = 'https://staysee.ru/supabase';

// The same app at its extra addresses (28.11.2026: staysee.ru does not open on some Russian networks).
for (const host of ['staysee.online', 'app.stayseeai.online']) {
  same(ownOriginBase(at(`https://${host}/anything?x=1`), '/supabase', fallback), `https://${host}/supabase`, 'its own address at an extra address');
}
same([...EXTRA_APP_HOSTS].sort(), ['app.stayseeai.online', 'staysee.online'], 'the extra addresses');

// Nothing changes at staysee.ru, www, a developer machine, a strange host, plain http or outside a browser.
for (const address of ['https://staysee.ru/', 'https://www.staysee.ru/', 'http://localhost:5173/', 'https://example.com/', 'https://stayseeai.online/', 'http://staysee.online/']) {
  same(ownOriginBase(at(address), '/supabase', fallback), fallback, address);
}
same(ownOriginBase(undefined, '/supabase', fallback), fallback, 'outside a browser');

console.log('appOrigins: ok');
