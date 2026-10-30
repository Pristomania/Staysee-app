// Whether this person may attach pictures, and whether they already gave the picture consent, are decided by the
// server (STAYSEE_IMAGE_ATTACHMENTS and its list of people; the consent records, migration 084). The site asks
// once per visit, so the picture button is shown to exactly the people the server would accept: no special link,
// no build setting.
import { sendAuthorizedChatRequest, type ChatTransportDeps } from './clientTransport';

export interface ImagesCapability {
  /** The server lets this person attach pictures. */
  allowed: boolean;
  /** The person has already given the picture consent (the notice is not shown again). */
  consent: boolean;
}

/** The server's answer; null = could not be asked (old server, network, proxy): not now. */
export async function askImagesCapability(userId: string, deps: ChatTransportDeps): Promise<ImagesCapability | null> {
  try {
    const sent = await sendAuthorizedChatRequest({
      body: { message: '', userId, capabilities: 'images' },
      deps,
    });
    if (!sent.ok || !sent.response.ok) return null;
    const data = (await sent.response.json().catch(() => ({}))) as { images?: unknown; imagesConsent?: unknown };
    // A server from before the consent existed answers only `images`; it asks for no consent either.
    return { allowed: data.images === true, consent: data.imagesConsent !== false };
  } catch {
    return null;
  }
}

const NOT_NOW: ImagesCapability = { allowed: false, consent: false };
const answered = new Map<string, Promise<ImagesCapability>>();

/** The answer is remembered for the visit, per person. A failed question shows no button now and is asked again next time. */
export function imagesCapabilityCached(userId: string, deps: ChatTransportDeps): Promise<ImagesCapability> {
  const known = answered.get(userId);
  if (known) return known;
  const asking = askImagesCapability(userId, deps).then((answer) => {
    if (answer === null) {
      answered.delete(userId);
      return NOT_NOW;
    }
    return answer;
  });
  answered.set(userId, asking);
  return asking;
}

/** After the person gives the picture consent, the remembered answer says so. */
export function markImagesConsentGiven(userId: string): void {
  const known = answered.get(userId);
  if (!known) return;
  answered.set(userId, known.then((answer) => ({ ...answer, consent: true })));
}
