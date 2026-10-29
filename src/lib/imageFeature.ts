// Who sees the picture button. The server decides for real (STAYSEE_IMAGE_ATTACHMENTS); this only hides the
// button from people it would not work for. Two ways to see it: the build lists the person
// (VITE_IMAGE_ATTACHMENTS_USER_IDS = "all" or ids), or this browser opened the beta link /?images=1.

const BETA_KEY = 'staysee_images_beta';

type SimpleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function imagesEnabledForUser(
  userId: string | undefined,
  envList: string | undefined,
  betaFlag: boolean,
): boolean {
  if (!userId) return false;
  if (betaFlag) return true;
  const list = (envList ?? '').trim();
  if (!list) return false;
  if (list.toLowerCase() === 'all') return true;
  return list.split(',').map((id) => id.trim()).includes(userId);
}

export function readImageBeta(storage: SimpleStorage | null): boolean {
  try {
    return storage?.getItem(BETA_KEY) === '1';
  } catch {
    return false;
  }
}

/** `?images=1` turns the beta on in this browser, `?images=0` turns it off; any other link changes nothing. */
export function captureImageBetaFromUrl(search: string, storage: SimpleStorage | null): void {
  try {
    const value = new URLSearchParams(search).get('images');
    if (value === '1') storage?.setItem(BETA_KEY, '1');
    else if (value === '0') storage?.removeItem(BETA_KEY);
  } catch {
    // storage blocked: the beta simply stays off
  }
}
