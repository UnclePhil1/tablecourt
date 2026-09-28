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
    'version', 11,
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

grant execute on function public.fossa_me(text) to anon, authenticated;
revoke all on function public.fossa_link(uuid, text, text) from anon, authenticated;
-- After running this, table_setup_check() should report version 11.
