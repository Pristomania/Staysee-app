/**
 * The admin panel lives at /admin (and below). Exactly that: /administrator, /admin-x and /x/admin are the normal app.
 * The check is on the address only; whether the person may see anything is decided by admin-api, never here.
 */
export function isAdminPath(pathname: string): boolean {
  return /^\/admin(\/|$)/.test(pathname);
}
