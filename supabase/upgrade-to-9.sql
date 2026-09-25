create or replace function public.game_row(c text, k text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', g.code, 'status', g.status, 'target', g.target,
    'title', g.title, 'starts_at', g.starts_at,
    -- only the two people actually in the match are told where it is played
    'channel', case when k is not null and (g.host_key = k or g.guest_key = k) then g.channel_key end,
    'host_name', g.host_name, 'guest_name', g.guest_name,
    'host_score', g.host_score, 'guest_score', g.guest_score,
    'winner', g.winner, 'ended_reason', g.ended_reason,
    'stake_token', g.stake_token, 'stake_amount', g.stake_amount, 'stake_status', g.stake_status,
    'result_state', g.result_state,
    -- Only the two players see each other's wallet. A match code travels in public invites, so
    -- returning these to anyone who has one would put an address against a username for the asking.
    'host_wallet',  case when k is not null and (g.host_key = k or g.guest_key = k) then g.host_wallet  end,
    'guest_wallet', case when k is not null and (g.host_key = k or g.guest_key = k) then g.guest_wallet end,
    'escrow_sig', g.escrow_sig, 'settle_sig', g.settle_sig,
    -- your own answer, and only whether they have given one: knowing theirs first would let you match it
    'my_claim', case when k = g.host_key then g.host_claim when k = g.guest_key then g.guest_claim end,
    'they_claimed', case when k = g.host_key then g.guest_claim is not null
                         when k = g.guest_key then g.host_claim  is not null end,
    'created_at', g.created_at, 'expires_at', g.expires_at,
    'role', case when k is null then null when g.host_key = k then 'host' when g.guest_key = k then 'guest' end
  ) from public.games g where g.code = c;
$$;
create or replace function public.table_setup_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', 9,
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
-- After running this, table_setup_check() should report version 9.
