/**
 * Which addresses open the admin panel (src/lib/admin/adminPath.ts).
 * Run: npx tsx src/lib/admin/adminPath.cases.test.ts
 */

import { isAdminPath } from './adminPath.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

for (const path of ['/admin', '/admin/', '/admin/people', '/admin/people/42']) {
  assert(isAdminPath(path) === true, `${path} opens the panel`);
}
for (const path of ['', '/', '/chat', '/administrator', '/admin-x', '/admins', '/x/admin', '/Admin', '/ADMIN/', '//admin', '/%61dmin']) {
  assert(isAdminPath(path) === false, `${path} is the normal app`);
}
console.log('✓ only /admin and below open the panel; look-alike addresses and other cases do not');
console.log('All adminPath cases passed.');
