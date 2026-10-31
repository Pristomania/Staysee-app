import { REGISTER_DRAFT_TTL_MS, clearRegisterDraft, saveRegisterDraft, takeRegisterDraft } from './registerDraft';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const typed = {
  email: 'a@example.invalid',
  password: 'secret-1',
  confirmPassword: 'secret-1',
  confirmedAge18: true,
  acceptedTerms: true,
  acceptedPd: false,
};

async function main(): Promise<void> {
  // Nothing saved: an empty form.
  clearRegisterDraft();
  assert(takeRegisterDraft(0) === null, 'nothing saved gives nothing');

  // What the person typed before opening a document comes back once, so reading it does not mean typing it all again.
  saveRegisterDraft(typed, 1_000);
  const back = takeRegisterDraft(2_000);
  assert(back !== null && back.email === typed.email && back.password === typed.password, 'the text fields come back');
  assert(back !== null && back.confirmedAge18 === true && back.acceptedTerms === true && back.acceptedPd === false, 'the checkboxes come back as they were');
  assert(takeRegisterDraft(2_001) === null, 'it is given back only once, so a later visit to registration starts empty');

  // A draft nobody came back for does not wait in memory forever.
  saveRegisterDraft(typed, 5_000);
  assert(takeRegisterDraft(5_000 + REGISTER_DRAFT_TTL_MS + 1) === null, 'an old draft is dropped');
  assert(takeRegisterDraft(5_000 + REGISTER_DRAFT_TTL_MS + 2) === null, 'and stays dropped');

  // Clearing drops it at once; saving a copy means later changes to the saved object change nothing.
  const mine = { ...typed };
  saveRegisterDraft(mine, 10_000);
  mine.email = 'changed@example.invalid';
  const copy = takeRegisterDraft(10_001);
  assert(copy !== null && copy.email === typed.email, 'the saved draft is a copy');
  saveRegisterDraft(typed, 20_000);
  clearRegisterDraft();
  assert(takeRegisterDraft(20_001) === null, 'cleared means gone');

  console.log('registerDraft.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
