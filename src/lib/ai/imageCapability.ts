// Whether this person may attach pictures is decided by the server (STAYSEE_IMAGE_ATTACHMENTS and its list of
// people, supabase/functions/_shared/imageAttachments.ts). The site asks once per visit, so the picture button is
// shown to exactly the people the server would accept: no special link, no build setting.
import { sendAuthorizedChatRequest, type ChatTransportDeps } from './clientTransport';

/** true / false = the server's answer; null = could not be asked (old server, network, proxy): not now. */
export async function askImagesAllowed(userId: string, deps: ChatTransportDeps): Promise<boolean | null> {
  try {
    const sent = await sendAuthorizedChatRequest({
      body: { message: '', userId, capabilities: 'images' },
      deps,
    });
    if (!sent.ok || !sent.response.ok) return null;
    const data = (await sent.response.json().catch(() => ({}))) as { images?: unknown };
    return data.images === true;
  } catch {
    return null;
  }
}

const answered = new Map<string, Promise<boolean>>();

/** The answer is remembered for the visit, per person. A failed question shows no button now and is asked again next time. */
export function imagesAllowedCached(userId: string, deps: ChatTransportDeps): Promise<boolean> {
  const known = answered.get(userId);
  if (known) return known;
  const asking = askImagesAllowed(userId, deps).then((answer) => {
    if (answer === null) answered.delete(userId);
    return answer === true;
  });
  answered.set(userId, asking);
  return asking;
}
