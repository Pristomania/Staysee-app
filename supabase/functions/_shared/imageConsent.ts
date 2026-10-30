/**
 * The consent to the processing of attached pictures (table user_consents, migration 084). A person gives it once,
 * in the app, before the first picture; the server accepts pictures only from people who have given it for the
 * current version of the notice. The version is the one the app sends (src/lib/consents.ts IMAGES_CONSENT_VERSION):
 * change both together when the notice text changes.
 */

export const IMAGES_CONSENT_TYPE = "images";
export const IMAGES_CONSENT_VERSION = "images_v1";

// The part of a Supabase client this uses, so tests can use a fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TableClient = { from(table: string): any };

/** Whether this person has given the picture consent for the current notice. Throws when it cannot be read. */
export async function hasImagesConsent(client: TableClient, userId: string): Promise<boolean> {
  const { count, error } = await client
    .from("user_consents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("consent_type", IMAGES_CONSENT_TYPE)
    .eq("document_version", IMAGES_CONSENT_VERSION);
  if (error || typeof count !== "number") throw new Error("images consent could not be read");
  return count > 0;
}
