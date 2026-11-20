-- 098: the trigger function that keeps admin_audit_log append-only was left with the default right (anyone may execute it).
-- It cannot be called like an ordinary function (it returns trigger), so nothing was exposed, but every admin_ function is meant to be
-- closed to people and to the public key; this closes the last one. Creating a trigger needs the right, firing it does not, so the
-- trigger keeps working.

REVOKE ALL ON FUNCTION public.admin_audit_log_append_only() FROM PUBLIC, anon, authenticated;
