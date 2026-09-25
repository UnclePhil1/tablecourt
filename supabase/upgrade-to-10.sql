create or replace function public.game_mine(w text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
  begin k := public.player_key(w); exception when others then return '[]'::jsonb; end;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'code', code, 'status', status, 'target', target, 'title', title,
             'starts_at', starts_at, 'created_at', created_at, 'expires_at', expires_at,
             'host_name', host_name, 'guest_name', guest_name,
             'host_score', host_score, 'guest_score', guest_score,
             'winner', winner, 'ended_reason', ended_reason,
             'stake_token', stake_token, 'stake_amount', stake_amount, 'stake_status', stake_status,
             'result_state', result_state,
             'my_claim', case when host_key = k then host_claim else guest_claim end,
             'role', case when host_key = k then 'host' else 'guest' end)
           order by coalesce(starts_at, created_at)), '[]'::jsonb)
      from public.games
     where (host_key = k or guest_key = k)
       and (
         -- still to be played
         (status in ('open', 'live') and expires_at > now())
         -- or over, but with a stake that never came back out
         or stake_status in ('pending', 'locked')
       ));
end $$;
create or replace function public.table_setup_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', 10,
    'profiles',      to_regclass('public.profiles')       is not null,
    'matches',       to_regclass('public.matches')        is not null,
    'wallet_players',to_regclass('public.wallet_players') is not null,
    'wallet_matches',to_regclass('public.wallet_matches') is not null,
    'wallet_login',       to_regprocedure('public.wallet_login(text)')                              is not null,
    'wallet_register',    to_regprocedure('public.wallet_register(text, text)')                     is not null,
    'wallet_save_match',  to_regprocedure('public.wallet_save_match(text, text, int, int, bool, int)') is not null,
    'games',           to_regclass('public.games')                                 is not null,
    'game_host',       to_regprocedure('public.game_host(text, int, text, timestamptz, text, numeric)') is not null,
    'game_mine',       to_regprocedure('public.game_mine(text)')                   is not null,
    'game_score',      to_regprocedure('public.game_score(text, text, int, int)')  is not null,
    'game_explore',    to_regprocedure('public.game_explore(int)')                 is not null,
    'channel_key',     (select count(*) = 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'games'
                            and column_name = 'channel_key'),
    'game_join',       to_regprocedure('public.game_join(text, text)')             is not null,
    'game_open',       to_regprocedure('public.game_open(int)')                    is not null,
    'game_finish',     to_regprocedure('public.game_finish(text, text, int, int)') is not null,
    'game_claim',      to_regprocedure('public.game_claim(text, text, text)') is not null,
    'player_wallet',   to_regprocedure('public.player_wallet(text)') is not null,
    'game_stake',      to_regprocedure('public.game_stake(text, text, text, text)') is not null,
    'game_leave',      to_regprocedure('public.game_leave(text, text)')            is not null
  );
$$;
-- After running this, table_setup_check() should report version 10.
