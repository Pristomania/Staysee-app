import { captureImageBetaFromUrl, imagesEnabledForUser, readImageBeta } from './imageFeature';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

assert(!imagesEnabledForUser('u1', undefined, false), 'off by default');
assert(!imagesEnabledForUser(undefined, 'all', true), 'nobody signed in');
assert(imagesEnabledForUser('u1', 'all', false), 'all');
assert(imagesEnabledForUser('u1', ' u0 , u1 ', false), 'in the list');
assert(!imagesEnabledForUser('u2', 'u0,u1', false), 'not in the list');
assert(imagesEnabledForUser('u2', undefined, true), 'the beta link switches it on for that browser');

const storage = memoryStorage();
assert(!readImageBeta(storage), 'no beta flag yet');
captureImageBetaFromUrl('?images=1', storage);
assert(readImageBeta(storage), 'images=1 remembers the beta');
captureImageBetaFromUrl('?other=1', storage);
assert(readImageBeta(storage), 'an unrelated link changes nothing');
captureImageBetaFromUrl('?images=0', storage);
assert(!readImageBeta(storage), 'images=0 switches it off again');

const broken = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};
assert(!readImageBeta(broken), 'unavailable storage means off');
captureImageBetaFromUrl('?images=1', broken); // must not throw

console.log('imageFeature.cases.test.ts passed');
