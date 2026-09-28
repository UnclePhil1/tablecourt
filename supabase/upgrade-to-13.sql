create or replace function public.game_host(w text default null, p_target int default 11,
                                            p_title text default null, p_starts_at timestamptz default null,
                                            p_stake_token text default null, p_stake_amount numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); n text := public.player_name(k); c text; i int;
        t text := nullif(btrim(coalesce(p_title, '')), '');
        st timestamptz := p_starts_at;
        mint text := nullif(btrim(coalesce(p_stake_token, '')), '');
        amt numeric := p_stake_amount;
        myw text := public.player_wallet(k);
begin
  if n is null then raise exception 'Choose a username before playing online.'; end if;
  -- Either both halves of a stake are given or neither is, so a match cannot end up half-priced.
  if (mint is null) <> (amt is null or amt = 0) then
    raise exception 'A stake needs both a token and an amount.';
  end if;
  if mint is not null then
    -- A staked match is settled through FossaPay, which identifies a player by the email on their
    -- account. Somebody who signed in with a Solana wallet has no email here and cannot be paid, so
    -- they are told that rather than being let into a match whose winnings could not reach them.
    if k not like 'u:%' then
      raise exception 'Staked matches need an email account. Sign in with email to play for a stake.';
    end if;
    if amt <= 0 then raise exception 'A stake has to be more than nothing.'; end if;
    /* A currency code, not a mint address. This checked for 32 to 44 characters, which was right when
       a Solana program held the pot and the column carried the mint — and wrong the moment FossaPay
       started doing it, because 'usdt' is four characters. Hosting any staked match failed on it. */
    mint := lower(mint);
    if mint not in ('usdt', 'usdc', 'sol') then
      raise exception 'Matches can be staked in USDT, USDC or SOL.';
    end if;
  end if;
  if length(coalesce(t, '')) > 60 then raise exception 'That match name is too long.'; end if;
  if st is not null and st < now() - interval '5 minutes' then raise exception 'That start time has already passed.'; end if;
  if st is not null and st > now() + interval '30 days' then raise exception 'Pick a start time within the next 30 days.'; end if;
  -- Tidy up anything of the host's that has run out, then cap how many they can have waiting at once.
  update public.games set status = 'cancelled', ended_at = now()
   where host_key = k and status = 'open' and expires_at < now();
  if (select count(*) from public.games where host_key = k and status = 'open') >= 5 then
    raise exception 'You already have 5 matches waiting. Cancel one first.';
  end if;
  for i in 1 .. 50 loop
    c := public.game_code();
    exit when not exists (select 1 from public.games where code = c);
    c := null;
  end loop;
  if c is null then raise exception 'Could not make a match code. Try again.'; end if;
  insert into public.games (code, host_key, host_name, target, title, starts_at, expires_at,
                            stake_token, stake_amount, stake_status, host_wallet)
       values (c, k, n, greatest(3, least(21, coalesce(p_target, 11))), t, st,
               case when st is null then now() + interval '24 hours' else st + interval '3 hours' end,
               mint, amt, case when mint is null then 'none' else 'pending' end, myw);
  return public.game_row(c, k);
end $$;

create or replace function public.table_setup_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', 13,
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
    'fossa_me',        to_regprocedure('public.fossa_me(text)') is not null,
    'fossa_link',      to_regprocedure('public.fossa_link(uuid, text, text)') is not null,
    'game_leave',      to_regprocedure('public.game_leave(text, text)')            is not null
  );
$$;

grant execute on function public.game_host(text, int, text, timestamptz, text, numeric) to anon, authenticated;
-- After running this, table_setup_check() should report version 13.
