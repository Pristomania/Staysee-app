// The consent to the processing of attached pictures: shown once, before the person's first picture, and recorded
// in user_consents (migration 084). The server accepts pictures only from people who have given it for this version
// (supabase/functions/_shared/imageConsent.ts). The text and the version go together: when the text changes, change
// IMAGES_CONSENT_VERSION here and on the server, and IMAGES_NOTICE_SHA256 (a test checks the hash).

export const IMAGES_CONSENT_TYPE = 'images';
export const IMAGES_CONSENT_VERSION = 'images_v1';

export const IMAGES_NOTICE_TEXT =
  'Картинка передаётся языковой модели на время ответа и у нас не сохраняется: в беседе остаётся только её текстовое описание. ' +
  'На картинке могут быть сведения о вашем здоровье и о других людях, например их сообщения. ' +
  'Прикрепляйте только то, что вы вправе показывать, и не прикрепляйте документы, банковские карты и экраны с паролями.';

/** SHA-256 of IMAGES_NOTICE_TEXT: what the consent log stores as the proof of the text the person saw. */
export const IMAGES_NOTICE_SHA256 = '0f4ce63643af74ebcb70f061e365777a1bf1db9cd843f2796ad7641e5bf8c9d3';

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;

/** Records the picture consent for the signed-in person; false when it could not be saved. */
export async function recordImagesConsent(rpc: Rpc, userAgent: string): Promise<boolean> {
  try {
    const { error } = await rpc('record_user_consent', {
      p_consent_type: IMAGES_CONSENT_TYPE,
      p_version: IMAGES_CONSENT_VERSION,
      p_sha256: IMAGES_NOTICE_SHA256,
      p_user_agent: userAgent.slice(0, 300),
    });
    return error === null || error === undefined;
  } catch {
    return false;
  }
}
