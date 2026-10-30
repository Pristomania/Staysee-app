import {
  IMAGES_CONSENT_VERSION,
  IMAGES_NOTICE_SHA256,
  IMAGES_NOTICE_TEXT,
  recordImagesConsent,
  sha256Hex,
} from './imagesConsent';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  // The hash is the standard SHA-256 of the text, in lower-case hex.
  assert((await sha256Hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'known vector');

  // The notice text and its version go together: change the text, change the version (here and on the server,
  // supabase/functions/_shared/imageConsent.ts) and the hash below. This is what the consent log stores.
  assert(IMAGES_CONSENT_VERSION === 'images_v1', 'version matches the server');
  assert((await sha256Hex(IMAGES_NOTICE_TEXT)) === IMAGES_NOTICE_SHA256, 'the hash belongs to this text, bump the version when changing it');
  assert(/не сохраня|не храним/.test(IMAGES_NOTICE_TEXT), 'says the picture is not kept');
  assert(/других людях|чужие/.test(IMAGES_NOTICE_TEXT), 'warns about other people');

  // Recording: the right call with the version and the hash of the text shown; false when it fails.
  {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const ok = await recordImagesConsent(async (fn, args) => { calls.push({ fn, args }); return { error: null }; }, 'UA/1.0');
    assert(ok === true, 'recorded');
    assert(calls.length === 1 && calls[0].fn === 'record_user_consent', 'one call to the recording function');
    assert(calls[0].args.p_consent_type === 'images', 'kind');
    assert(calls[0].args.p_version === IMAGES_CONSENT_VERSION, 'version');
    assert(calls[0].args.p_sha256 === IMAGES_NOTICE_SHA256, 'hash of the text shown');
    assert(calls[0].args.p_user_agent === 'UA/1.0', 'user agent');
  }
  assert((await recordImagesConsent(async () => ({ error: { message: 'x' } }), '')) === false, 'an error is false');
  assert((await recordImagesConsent(async () => { throw new Error('network'); }, '')) === false, 'a thrown error is false');

  console.log('imagesConsent.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
