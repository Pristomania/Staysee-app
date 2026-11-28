/**
 * Alerts to the owner by e-mail, next to the Telegram ones: the same fixed texts, so no user data gets into a letter either.
 * Switched on by STAYSEE_ALERT_EMAIL; the letters leave through the same Postbox account as the sign-in letters.
 */

export interface PostboxMail {
  user: string;
  password: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Sends one alert. Answers false instead of throwing: an alert that cannot be sent never breaks a reply. */
export type OwnerMailer = (text: string) => Promise<boolean>;

const FROM = '"StaySee AI" <no-reply@staysee.ru>';
const ADDRESS = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,190}\.[A-Za-z]{2,24}$/;
const SEND_TIMEOUT_MS = 5000;
const SUBJECT_LIMIT = 100;

function readEnv(name: string): string | undefined {
  return typeof Deno !== "undefined" ? Deno.env.get(name) : undefined;
}

/** The transport is loaded only when a letter is really sent (the tests, which run outside Deno, hand in their own). */
async function sendThroughPostbox(mail: PostboxMail): Promise<void> {
  const { sendPostboxMail } = await import("./postboxMail.ts");
  await sendPostboxMail(mail);
}

function subjectOf(text: string): string {
  // The first line without its leading mark (an emoji) and without a second «StaySee:».
  const line = text.split("\n")[0].replace(/^[^\p{L}\p{N}]+/u, "").replace(/^StaySee:?\s*/iu, "").trim();
  const subject = line ? `StaySee: ${line}` : "StaySee: оповещение";
  return subject.length <= SUBJECT_LIMIT ? subject : `${subject.slice(0, SUBJECT_LIMIT - 1)}…`;
}

export function ownerAlertMailer(options: {
  read?: (name: string) => string | undefined;
  send?: (mail: PostboxMail) => Promise<void>;
  timeoutMs?: number;
} = {}): OwnerMailer | null {
  const read = options.read ?? readEnv;
  const to = read("STAYSEE_ALERT_EMAIL")?.trim() ?? "";
  const user = read("POSTBOX_SMTP_USER") ?? "";
  const password = read("POSTBOX_SMTP_PASSWORD") ?? "";
  if (!ADDRESS.test(to) || !user || !password) return null;
  const send = options.send ?? sendThroughPostbox;
  return async (text) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        send({ user, password, from: FROM, to, subject: subjectOf(text), text }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("mail_timeout")), options.timeoutMs ?? SEND_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      // Only our own fixed word reaches the log: a mail error can carry the account name.
      console.error("[owner-alert] mail_not_sent");
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Sends one alert over several channels at once. A channel failed if it threw or answered false.
 * Throws when nothing got through; with `requireAll` (the connectivity test) also when any one channel failed.
 */
export async function deliverToOwner(
  channels: ReadonlyArray<() => Promise<unknown>>,
  options: { requireAll?: boolean } = {},
): Promise<void> {
  const results = await Promise.allSettled(channels.map(async (channel) => await channel()));
  const delivered = results.filter((result) => result.status === "fulfilled" && result.value !== false).length;
  if (delivered === 0 || (options.requireAll === true && delivered < results.length)) {
    const reason = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    const detail = reason instanceof Error ? `: ${reason.message}` : "";
    throw new Error(`alert delivered to ${delivered} of ${results.length} channels${detail}`);
  }
}
