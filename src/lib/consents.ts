// Agreements people give, and how they are recorded (table user_consents, migration 084).
// The names are the ones the database and the server use; the version and the hash come from the generated text of
// the document the person saw (src/content/legal/*.ts, built from docs/legal by scripts/build-legal-content.mjs).

export const CONSENT_TYPES = {
  terms: 'terms',
  pdProcessing: 'pd_processing',
  images: 'images',
  age18: 'age_18',
} as const;

export interface ConsentProof {
  version: string;
  sha256: string;
}

/**
 * The tick "Подтверждаю, что мне исполнилось 18 лет" (ROOM_COPY.age18Confirm) at registration. The hash is that of the
 * sentence on the form; if the sentence changes, change the hash AND the version (a test compares them).
 */
export const AGE_18_META: ConsentProof = {
  version: '1',
  sha256: 'cfb652c9624d0c7700943dcff4618267568054c14fdc1816ac9aed830e45c532',
};

export interface SignUpConsents {
  terms: ConsentProof;
  pd_processing: ConsentProof;
  age_18: ConsentProof;
}

const USER_AGENT_MAX = 300;

/**
 * The agreements given at registration travel in the metadata of the new account; the database copies them into
 * user_consents with its own time (a trigger on the new account), so it works with and without email confirmation.
 */
export function signUpConsentMetadata(consents: SignUpConsents, userAgent: string) {
  return {
    consents: {
      terms: consents.terms,
      pd_processing: consents.pd_processing,
      age_18: consents.age_18,
      user_agent: userAgent.slice(0, USER_AGENT_MAX),
    },
  };
}
