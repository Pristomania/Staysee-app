import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").split("\r\n").join("\n");

const types = read("src/types/index.ts");
const app = read("src/App.tsx");
const appContext = read("src/context/AppContext.tsx");
const profile = read("src/components/screens/ProfileScreen.tsx");
const privacy = read("src/components/screens/PrivacyScreen.tsx");
const register = read("src/components/screens/RegisterScreen.tsx");

describe("the policy and the consent are screens of the app, shown from the published documents", () => {
  it("know the two new screens, public like the offer", () => {
    assert.match(types, /\| 'policy'/);
    assert.match(types, /\| 'consent'/);
    assert.match(app, /PUBLIC_SCREENS = \[[^\]]*'policy'[^\]]*'consent'/);
    assert.match(app, /case 'policy':\s+return <PrivacyPolicyScreen \/>;/);
    assert.match(app, /case 'consent':\s+return <ConsentScreen \/>;/);
    assert.match(appContext, /case 'policy':\s+case 'consent':/);
  });

  it("show the generated texts of the documents", () => {
    const policyScreen = read("src/components/screens/PrivacyPolicyScreen.tsx");
    const consentScreen = read("src/components/screens/ConsentScreen.tsx");
    assert.match(policyScreen, /PRIVACY_POLICY_META, PRIVACY_POLICY_SECTIONS/);
    assert.match(policyScreen, /<LegalDocumentView meta=\{PRIVACY_POLICY_META\} sections=\{PRIVACY_POLICY_SECTIONS\}/);
    assert.match(consentScreen, /CONSENT_META, CONSENT_SECTIONS/);
    assert.match(consentScreen, /<LegalDocumentView meta=\{CONSENT_META\} sections=\{CONSENT_SECTIONS\}/);
  });

  it("are listed among the documents in the profile and linked from the privacy screen", () => {
    assert.match(profile, /screen: 'policy' as const/);
    assert.match(profile, /screen: 'consent' as const/);
    assert.match(privacy, /screen: 'policy' as const/);
    assert.match(privacy, /screen: 'consent' as const/);
    assert.match(privacy, /onClick=\{\(\) => navigateTo\(screen\)\}/);
  });

  it("no longer say the data is not passed to anybody, and name model providers instead", () => {
    assert.doesNotMatch(privacy, /не передаём данные третьим лицам/);
    assert.match(privacy, /поставщик[а-я]* языковых моделей/);
    assert.match(privacy, /картинк[а-я]* мы не храним|Картинк[а-я]* мы не храним/);
  });
});

describe("registration asks for the consent separately from the offer", () => {
  it("has a second checkbox for the processing of personal data, linked to the consent and the policy", () => {
    assert.match(register, /const \[acceptedPd, setAcceptedPd\] = useState\(draft\?\.acceptedPd \?\? false\);/);
    assert.match(register, /const canSubmit = confirmedAge18 && acceptedTerms && acceptedPd && !loading;/);
    assert.match(register, /navigateTo\('consent', \{ legalReturnScreen: 'register' \}\)/);
    assert.match(register, /navigateTo\('policy', \{ legalReturnScreen: 'register' \}\)/);
    assert.match(register, /Нужно дать согласие на обработку персональных данных/);
  });

  it("hands both agreements, with the version and the hash of the text shown, to the sign-up", () => {
    assert.match(register, /signUp\(email, password, \{[\s\S]{0,400}OFFER_META[\s\S]{0,400}CONSENT_META/);
  });

  // Found by the browser check of 31.10: reading a document from the registration and coming back emptied the whole
  // form (the address, both passwords and the three checkboxes), because the screen is closed while a document is open.
  it("keeps what was typed while a document is read, and takes it back when the person returns", () => {
    assert.match(register, /import \{ saveRegisterDraft, takeRegisterDraft \} from '\.\.\/\.\.\/lib\/registerDraft';/);
    assert.match(register, /const \[draft\] = useState\(\(\) => takeRegisterDraft\(\)\);/);
    assert.match(register, /useState\(draft\?\.email \?\? ''\)/);
    assert.match(register, /useState\(draft\?\.acceptedPd \?\? false\)/);
    for (const screen of ["terms", "policy", "consent"]) {
      assert.match(
        register,
        new RegExp(`rememberTyped\\(\\);\\s+navigateTo\\('${screen}', \\{ legalReturnScreen: 'register' \\}\\)`),
        screen,
      );
    }
  });
});
