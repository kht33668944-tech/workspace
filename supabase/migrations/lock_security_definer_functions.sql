-- Restrict SECURITY DEFINER functions from direct API execution.
-- These functions should only run through trusted server-side paths or triggers.

ALTER FUNCTION public.decrypt_credential(text) SET search_path = extensions, public;
ALTER FUNCTION public.encrypt_credential(text) SET search_path = extensions, public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;

REVOKE ALL ON FUNCTION public.decrypt_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrypt_credential(text) FROM anon;
REVOKE ALL ON FUNCTION public.decrypt_credential(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decrypt_credential(text) TO service_role;

REVOKE ALL ON FUNCTION public.encrypt_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.encrypt_credential(text) FROM anon;
REVOKE ALL ON FUNCTION public.encrypt_credential(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.encrypt_credential(text) TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
