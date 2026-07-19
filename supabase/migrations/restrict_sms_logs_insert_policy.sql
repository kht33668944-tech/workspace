-- SMS logs are written by server-side service_role code.
-- Remove the broad public INSERT policy; service_role still bypasses RLS.

drop policy if exists "Service role can insert logs" on public.sms_logs;

drop policy if exists "Users can read own logs" on public.sms_logs;
create policy "Users can read own logs" on public.sms_logs
  for select to authenticated
  using (user_id = (select auth.uid()));
