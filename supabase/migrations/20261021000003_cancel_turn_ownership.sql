-- Phase 8: found by the identifier-tampering sweep. Asking to cancel a conversation that is not yours answered 200 {requested:false},
-- the same as an idle conversation of your own. Harmless (nothing changed, nothing revealed) but misleading: it is now a plain 404.
create or replace function public.copilot_cancel_turn(p_org uuid, p_conversation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_found boolean;
begin
  perform app.require_role(p_org, 'staff');
  if not exists (select 1 from public.copilot_conversations where id = p_conversation and org_id = p_org and user_id = auth.uid()) then raise exception 'conversation not found' using errcode = 'PT404'; end if;
  update public.copilot_conversations set cancel_requested = true where id = p_conversation and org_id = p_org and user_id = auth.uid() and running_since is not null;
  v_found := found;
  return jsonb_build_object('requested', v_found);
end $$;
revoke execute on function public.copilot_cancel_turn(uuid, uuid) from public, anon;
grant execute on function public.copilot_cancel_turn(uuid, uuid) to authenticated;
