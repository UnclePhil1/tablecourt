alter table public.profiles add column if not exists fossa_customer_id text;
alter table public.profiles add column if not exists fossa_address     text;
create unique index if not exists profiles_fossa_customer on public.profiles (fossa_customer_id)
  where fossa_customer_id is not null;

alter table public.games add column if not exists stake_in_host  text;
alter table public.games add column if not exists stake_in_guest text;
alter table public.games add column if not exists payout_tx      text;
/* What the pot actually received, which is not what the player sent.

   FossaPay deducts its transfer fee from the amount submitted, so a 10 USDT stake arrives as rather
   less. Paying out a figure worked out from the asked-for stake means the business quietly covers the
   difference on every match, and at a high enough provider rate the pot cannot cover its own payout
   at all. Every payout is computed from these two numbers. */
alter table public.games add column if not exists stake_net_host  numeric(20, 9);
alter table public.games add column if not exists stake_net_guest numeric(20, 9);

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
    if length(mint) not between 32 and 44 then raise exception 'That does not look like a token address.'; end if;
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

create or replace function public.game_join(p_code text, w text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); n text := public.player_name(k); g public.games;
begin
  if n is null then raise exception 'Choose a username before playing online.'; end if;
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'No match with that code.'; end if;
  if g.host_key = k or g.guest_key = k then return public.game_row(g.code, k); end if;
  if g.status in ('done', 'cancelled') then raise exception 'That match is over.'; end if;
  if g.guest_key is not null then raise exception 'That match is already full.'; end if;
  if g.expires_at < now() then raise exception 'That invite has expired.'; end if;
  -- A staked match cannot be joined by somebody the winnings could never reach.
  if g.stake_status <> 'none' and k not like 'u:%' then
    raise exception 'That match is staked. Sign in with an email account to join it.';
  end if;
  update public.games
     set guest_key = k, guest_name = n, status = 'live', started_at = coalesce(g.started_at, now()),
         guest_wallet = public.player_wallet(k)
   where code = g.code;
  return public.game_row(g.code, k);
end $$;

create or replace function public.fossa_me(w text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k text := public.player_key(w); r record;
begin
  if k not like 'u:%' then return jsonb_build_object('linked', false, 'reason', 'email'); end if;
  select fossa_customer_id, fossa_address into r
    from public.profiles where id = substring(k from 3)::uuid;
  return jsonb_build_object(
    'linked', r.fossa_customer_id is not null,
    'address', r.fossa_address,
    -- The customer id is an identifier the server uses to move money. The browser never needs it.
    'customer_id', null);
end $$;

create or replace function public.fossa_link(p_user uuid, p_customer text, p_address text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if p_customer is null or p_address is null then raise exception 'Both a customer and an address are needed.'; end if;
  update public.profiles
     set fossa_customer_id = coalesce(fossa_customer_id, p_customer),
         fossa_address     = coalesce(fossa_address, p_address)
   where id = p_user;
  if not found then raise exception 'No such player.'; end if;
end $$;

create or replace function public.table_setup_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', 12,
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

grant execute on function public.game_host(text, int, text, timestamptz, text, numeric),
  public.game_join(text, text), public.fossa_me(text) to anon, authenticated;
revoke all on function public.fossa_link(uuid, text, text) from anon, authenticated;
-- After running this, table_setup_check() should report version 12.
