-- Table: database setup for accounts and match history.
-- Run this in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- It is safe to run again, and running it again also upgrades a project that has an older version.

-- 0. Remove anything left over from an older version of this file -------------------------------
-- An earlier version used a function called wallet_sign_in. The app no longer calls it, and leaving
-- it behind makes Supabase suggest the wrong name in its error messages. This drops it whatever
-- arguments it was created with. The same loop drops older shapes of the three functions below,
-- so re-creating them can never leave two versions with different argument names behind.
do $$
declare f record;
begin
  for f in
    select quote_ident(p.proname) as nm, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('wallet_sign_in', 'wallet_login', 'wallet_register', 'wallet_save_match', 'table_setup_check',
             'player_key', 'player_name', 'game_code', 'game_row', 'game_host', 'game_join',
             'game_peek', 'game_open', 'game_finish', 'game_leave', 'game_mine',
             'game_score', 'game_explore', 'game_claim')
  loop
    execute 'drop function if exists public.' || f.nm || '(' || f.args || ') cascade';
  end loop;
end $$;

-- 1. Player profiles (one per signed-in user) ---------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null,
  wallet     text,
  wins       int  not null default 0,
  losses     int  not null default 0,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,16}$')
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));
create unique index if not exists profiles_wallet_key   on public.profiles (wallet) where wallet is not null;

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable" on public.profiles;
create policy "profiles are readable" on public.profiles for select using (true);

drop policy if exists "users create their own profile" on public.profiles;
create policy "users create their own profile" on public.profiles for insert
  with check (auth.uid() = id and wins = 0 and losses = 0);

drop policy if exists "users edit their own profile" on public.profiles;
create policy "users edit their own profile" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- People can change only their username and wallet. Wins and losses are set by the database.
revoke update on public.profiles from anon, authenticated;
grant  update (username, wallet) on public.profiles to authenticated;

-- 2. Wallet players -------------------------------------------------------------------------------
-- These players do not use Supabase sign-in. The app connects an external Solana wallet and sends the
-- wallet address and username. The tables have no direct access; everything goes through the functions below.

-- An older version of this file gave wallet_players its own id column and keyed wallet_matches by
-- player_id. This version uses the wallet address as the key instead. "create table if not exists"
-- would skip the old tables and then fail on the wallet column, so move them aside first. Nothing is
-- deleted: the rows are copied into the new tables at the end of this section.
do $$
declare stamp text := to_char(now(), 'YYYYMMDDHH24MISS');
declare old boolean;
begin
  select
    (to_regclass('public.wallet_matches') is not null
      and not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'wallet_matches' and column_name = 'wallet'))
    or
    (to_regclass('public.wallet_players') is not null
      and exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'wallet_players' and column_name = 'id'))
  into old;

  if old then
    if to_regclass('public.wallet_matches') is not null then
      execute format('alter table public.wallet_matches rename to %I', 'wallet_matches_backup_' || stamp);
      execute format('revoke all on public.%I from anon, authenticated', 'wallet_matches_backup_' || stamp);
    end if;
    if to_regclass('public.wallet_players') is not null then
      execute format('alter table public.wallet_players rename to %I', 'wallet_players_backup_' || stamp);
      execute format('revoke all on public.%I from anon, authenticated', 'wallet_players_backup_' || stamp);
    end if;
    raise notice 'Moved the old wallet tables aside as wallet_*_backup_%', stamp;
  end if;
end $$;

create table if not exists public.wallet_players (
  wallet     text primary key,
  username   text not null,
  wins       int  not null default 0,
  losses     int  not null default 0,
  created_at timestamptz not null default now(),
  constraint wallet_address_format check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint wallet_username_format check (username ~ '^[a-z0-9_]{3,16}$')
);
create unique index if not exists wallet_players_username_key on public.wallet_players (lower(username));

create table if not exists public.wallet_matches (
  id             bigint generated always as identity primary key,
  wallet         text not null references public.wallet_players(wallet) on delete cascade,
  level          text not null check (level in ('easy', 'medium', 'hard')),
  player_score   int  not null check (player_score between 0 and 99),
  cpu_score      int  not null check (cpu_score between 0 and 99),
  won            boolean not null,
  longest_rally  int  not null default 0 check (longest_rally between 0 and 999),
  created_at     timestamptz not null default now()
);
create index if not exists wallet_matches_wallet_idx on public.wallet_matches (wallet, created_at desc);

alter table public.wallet_players enable row level security;
alter table public.wallet_matches enable row level security;
revoke all on public.wallet_players, public.wallet_matches from anon, authenticated;
grant select (username, wins, losses) on public.wallet_players to anon, authenticated;   -- for leaderboards; wallet addresses stay private
drop policy if exists "wallet usernames and scores are readable" on public.wallet_players;
create policy "wallet usernames and scores are readable" on public.wallet_players for select using (true);

-- Copy anything the older tables held into the new ones. Rows that no longer pass the checks above
-- are skipped rather than failing the whole script; they stay in the _backup_ tables either way.
do $$
declare pb text; mb text; np int := 0; nm int := 0;
begin
  select relname into pb from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and relname like 'wallet_players_backup_%' order by relname desc limit 1;
  select relname into mb from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and relname like 'wallet_matches_backup_%' order by relname desc limit 1;

  if pb is not null then
    execute format($q$
      insert into public.wallet_players (wallet, username, wins, losses, created_at)
      select wallet, lower(username), greatest(coalesce(wins, 0), 0), greatest(coalesce(losses, 0), 0), created_at
        from public.%I
       where wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' and lower(username) ~ '^[a-z0-9_]{3,16}$'
      on conflict do nothing $q$, pb);
    get diagnostics np = row_count;
  end if;

  if pb is not null and mb is not null then
    execute format($q$
      insert into public.wallet_matches (wallet, level, player_score, cpu_score, won, longest_rally, created_at)
      select p.wallet, m.level, m.player_score, m.cpu_score, m.won, least(coalesce(m.longest_rally, 0), 999), m.created_at
        from public.%I m
        join public.%I p on p.id::text = m.player_id::text
        join public.wallet_players w on w.wallet = p.wallet
       where m.level in ('easy', 'medium', 'hard')
         and m.player_score between 0 and 99 and m.cpu_score between 0 and 99 $q$, mb, pb);
    get diagnostics nm = row_count;
  end if;

  if pb is not null or mb is not null then
    raise notice 'Copied % wallet players and % matches from the backup tables.', np, nm;
  end if;
exception when others then
  raise notice 'Could not copy the old wallet rows (%). They are still in the _backup_ tables.', sqlerrm;
end $$;

-- 3. Email sign-ups get a profile automatically, using the username from the sign-up form -------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
begin
  if uname !~ '^[a-z0-9_]{3,16}$' or exists (select 1 from public.profiles where lower(username) = uname)
     or exists (select 1 from public.wallet_players where lower(username) = uname) then
    if new.email is null then return new; end if;                 -- wallet users pick a username in the app
    uname := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  insert into public.profiles (id, username) values (new.id, uname) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Live "is this username free?" check for the sign-up form -----------------------------------
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select name ~ '^[a-z0-9_]{3,16}$'
     and not exists (select 1 from public.profiles       where lower(username) = lower(name))
     and not exists (select 1 from public.wallet_players where lower(username) = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- 5. Match history (email players) (player vs CPU) -----------------------------------------------------------------
create table if not exists public.matches (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  level          text not null check (level in ('easy', 'medium', 'hard')),
  player_score   int  not null check (player_score between 0 and 99),
  cpu_score      int  not null check (cpu_score between 0 and 99),
  won            boolean not null,
  longest_rally  int  not null default 0 check (longest_rally between 0 and 999),
  created_at     timestamptz not null default now()
);
create index if not exists matches_user_idx on public.matches (user_id, created_at desc);

alter table public.matches enable row level security;

drop policy if exists "read own matches" on public.matches;
create policy "read own matches" on public.matches for select using (auth.uid() = user_id);

drop policy if exists "save own matches" on public.matches;
create policy "save own matches" on public.matches for insert with check (auth.uid() = user_id);

-- Each saved match updates the win/loss count on the profile.
create or replace function public.count_match() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set wins = wins + (case when new.won then 1 else 0 end),
         losses = losses + (case when new.won then 0 else 1 end)
   where id = new.user_id;
  return new;
end $$;

drop trigger if exists on_match_saved on public.matches;
create trigger on_match_saved after insert on public.matches
  for each row execute function public.count_match();

-- 6. Wallet functions. The app calls these; nothing else can write to the wallet tables.
-- Look up a wallet. Returns the player, or null if this wallet is new.
create or replace function public.wallet_login(w text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('wallet', wallet, 'username', username, 'wins', wins, 'losses', losses)
    from public.wallet_players where wallet = w;
$$;

-- Register a new wallet with a username.
create or replace function public.wallet_register(w text, uname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := lower(coalesce(uname, ''));
begin
  if w !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'That does not look like a Solana address.'; end if;
  if exists (select 1 from public.wallet_players where wallet = w) then raise exception 'This wallet already has a username.'; end if;
  if not public.username_available(u) then raise exception 'That username is taken.'; end if;
  insert into public.wallet_players (wallet, username) values (w, u);
  return public.wallet_login(w);
end $$;

-- Save a finished match and update the win/loss count. Basic sanity checks only.
create or replace function public.wallet_save_match(w text, lvl text, ps int, cs int, did_win boolean, longest int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.wallet_players where wallet = w) then raise exception 'Unknown wallet.'; end if;
  if greatest(ps, cs) < 11 or abs(ps - cs) < 2 or did_win <> (ps > cs) then raise exception 'That is not a finished match.'; end if;
  insert into public.wallet_matches (wallet, level, player_score, cpu_score, won, longest_rally)
    values (w, lvl, ps, cs, did_win, coalesce(longest, 0));
  update public.wallet_players
     set wins = wins + (case when did_win then 1 else 0 end), losses = losses + (case when did_win then 0 else 1 end)
   where wallet = w;
  return public.wallet_login(w);
end $$;

grant execute on function public.wallet_login(text), public.wallet_register(text, text),
  public.wallet_save_match(text, text, int, int, boolean, int) to anon, authenticated;

-- 7. Setup check. The app calls this on the sign-in screen to tell you exactly what is missing,
-- instead of showing a general "database is not set up" message.
create or replace function public.table_setup_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', 7,
    'profiles',      to_regclass('public.profiles')       is not null,
    'matches',       to_regclass('public.matches')        is not null,
    'wallet_players',to_regclass('public.wallet_players') is not null,
    'wallet_matches',to_regclass('public.wallet_matches') is not null,
    'wallet_login',       to_regprocedure('public.wallet_login(text)')                              is not null,
    'wallet_register',    to_regprocedure('public.wallet_register(text, text)')                     is not null,
    'wallet_save_match',  to_regprocedure('public.wallet_save_match(text, text, int, int, bool, int)') is not null,
    'games',           to_regclass('public.games')                                 is not null,
    'game_host',       to_regprocedure('public.game_host(text, int, text, timestamptz)') is not null,
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
    'game_leave',      to_regprocedure('public.game_leave(text, text)')            is not null
  );
$$;
grant execute on function public.table_setup_check() to anon, authenticated;

-- 8. Online 1v1 -----------------------------------------------------------------------------------
-- A match is a row in public.games with a short share code. The live play itself does not touch the
-- database at all: the two browsers talk over a Supabase Realtime broadcast channel named
-- "game-<code>". This table only holds who is playing, the result, and the columns a staking
-- feature would need later. Nothing reads the stake columns yet.
create table if not exists public.games (
  code         text primary key,
  host_key     text not null,
  host_name    text not null,
  guest_key    text,
  guest_name   text,
  status       text not null default 'open' check (status in ('open', 'live', 'done', 'cancelled')),
  target       int  not null default 11 check (target between 3 and 21),
  host_score   int  not null default 0 check (host_score   between 0 and 99),
  guest_score  int  not null default 0 check (guest_score  between 0 and 99),
  winner       text check (winner in ('host', 'guest')),
  ended_reason text check (ended_reason in ('score', 'left', 'timeout')),
  -- Reserved for a future staking feature. The app never writes these today.
  stake_token  text,
  stake_amount numeric(20, 9) check (stake_amount is null or stake_amount >= 0),
  stake_status text not null default 'none' check (stake_status in ('none', 'pending', 'locked', 'paid', 'refunded')),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  ended_at     timestamptz,
  expires_at   timestamptz not null default now() + interval '2 hours'
);
-- A match can carry a name and a kick-off time. starts_at null means "as soon as someone joins".
alter table public.games add column if not exists title     text;
alter table public.games add column if not exists starts_at timestamptz;
-- The two players talk over a Realtime channel. Naming it after the match code would be a mistake:
-- codes are published to the whole lobby, so anyone could join the channel and shove the other
-- player's paddle around. This secret is handed only to the host and the guest.
alter table public.games add column if not exists channel_key text
  not null default replace(gen_random_uuid()::text, '-', '');
-- Each player says who won, separately. A stake settles only when the two answers match. Nothing here
-- is a score: it is one word from each of the two people who were there.
alter table public.games add column if not exists host_claim   text;
alter table public.games add column if not exists guest_claim  text;
alter table public.games add column if not exists result_state text not null default 'open';
alter table public.games drop constraint if exists games_host_claim;
alter table public.games add  constraint games_host_claim   check (host_claim  is null or host_claim  in ('host', 'guest'));
alter table public.games drop constraint if exists games_guest_claim;
alter table public.games add  constraint games_guest_claim  check (guest_claim is null or guest_claim in ('host', 'guest'));
alter table public.games drop constraint if exists games_result_state;
alter table public.games add  constraint games_result_state check (result_state in ('open', 'agreed', 'disputed'));

alter table public.games drop constraint if exists games_title_len;
alter table public.games add  constraint games_title_len check (title is null or length(btrim(title)) between 1 and 60);

create index if not exists games_open_idx on public.games (created_at desc) where status = 'open';
create index if not exists games_soon_idx on public.games (starts_at) where status = 'open';
create index if not exists games_host_idx on public.games (host_key, created_at desc);

alter table public.games enable row level security;
revoke all on public.games from anon, authenticated;   -- everything goes through the functions below

-- Who is calling? Email players are a Supabase user; wallet players pass their address.
-- The key is kept server-side so a wallet address is never handed back out to other players.
create or replace function public.player_key(w text default null) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null then return 'u:' || auth.uid(); end if;
  if w is null or w = '' then raise exception 'Sign in to play online.'; end if;
  if not exists (select 1 from public.wallet_players where wallet = w) then raise exception 'Unknown wallet.'; end if;
  return 'w:' || w;
end $$;

create or replace function public.player_name(k text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when k like 'u:%' then (select username from public.profiles       where id = substring(k from 3)::uuid)
    when k like 'w:%' then (select username from public.wallet_players where wallet = substring(k from 3))
  end;
$$;

-- Six characters, no letters that look like each other (no I, O, 0 or 1).
-- The loop is plpgsql on purpose: as a SQL function the planner can evaluate the body once and hand
-- back the same code every time, which would make every match collide.
create or replace function public.game_code() returns text
language plpgsql volatile set search_path = public as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text := ''; i int;
begin
  for i in 1 .. 6 loop
    c := c || substr(a, 1 + floor(random() * 32)::int, 1);
  end loop;
  return c;
end $$;

-- What a player is allowed to see about a match. Never includes host_key or guest_key.
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
    -- your own answer, and only whether they have given one: knowing theirs first would let you match it
    'my_claim', case when k = g.host_key then g.host_claim when k = g.guest_key then g.guest_claim end,
    'they_claimed', case when k = g.host_key then g.guest_claim is not null
                         when k = g.guest_key then g.host_claim  is not null end,
    'created_at', g.created_at, 'expires_at', g.expires_at,
    'role', case when k is null then null when g.host_key = k then 'host' when g.guest_key = k then 'guest' end
  ) from public.games g where g.code = c;
$$;

-- Open a match and get a code to share. The invite stays up until it is cancelled or expires, so the
-- host can close the page and come back to it. A scheduled match lives until a while after kick-off.
create or replace function public.game_host(w text default null, p_target int default 11,
                                            p_title text default null, p_starts_at timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); n text := public.player_name(k); c text; i int;
        t text := nullif(btrim(coalesce(p_title, '')), '');
        st timestamptz := p_starts_at;
begin
  if n is null then raise exception 'Choose a username before playing online.'; end if;
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
  insert into public.games (code, host_key, host_name, target, title, starts_at, expires_at)
       values (c, k, n, greatest(3, least(21, coalesce(p_target, 11))), t, st,
               case when st is null then now() + interval '24 hours' else st + interval '3 hours' end);
  return public.game_row(c, k);
end $$;

-- Take the other seat. Re-opening your own invite link is allowed and changes nothing.
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
  update public.games
     set guest_key = k, guest_name = n, status = 'live', started_at = coalesce(g.started_at, now())
   where code = g.code;
  return public.game_row(g.code, k);
end $$;

-- The open invites anyone can accept.
create or replace function public.game_open(lim int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'host_name', host_name, 'target', target,
           'title', title, 'starts_at', starts_at, 'created_at', created_at)
         order by coalesce(starts_at, created_at)), '[]'::jsonb)
    from (select * from public.games
           where status = 'open' and expires_at > now()
           order by coalesce(starts_at, created_at)
           limit greatest(1, least(50, coalesce(lim, 20)))) q;
$$;

-- The matches you are part of that have not finished, so you can walk back into your own invite
-- after closing the page.
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
             'role', case when host_key = k then 'host' else 'guest' end)
           order by coalesce(starts_at, created_at)), '[]'::jsonb)
      from public.games
     where status in ('open', 'live') and expires_at > now()
       and (host_key = k or guest_key = k));
end $$;

-- Only the host reports the result: it is the browser that ran the physics.
create or replace function public.game_finish(p_code text, w text default null, hs int default 0, gs int default 0) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); g public.games;
begin
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'No match with that code.'; end if;
  if g.host_key <> k then raise exception 'Only the host reports the score.'; end if;
  if g.status = 'done' then return public.game_row(g.code, k); end if;
  if greatest(hs, gs) < g.target or abs(hs - gs) < 2 then raise exception 'That is not a finished match.'; end if;
  update public.games
     set status = 'done', host_score = hs, guest_score = gs,
         winner = case when hs > gs then 'host' else 'guest' end,
         ended_reason = 'score', ended_at = now()
   where code = g.code;
  return public.game_row(g.code, k);
end $$;

/* Who won, according to each player separately.

   The host runs the physics, so on its own word it could simply declare itself the winner, and a stake
   paid on that word could be stolen outright. Nothing on this side can prove a rally ever happened.
   What it can do is refuse to settle unless the player who lost says so too. A cheat then cannot take
   anybody's stake: the furthest it reaches is a disagreement, which pays nobody and gives both players
   their money back. Losing costs the cheat nothing, so this stops theft rather than discouraging it.

   An answer cannot be changed once given, and you are never shown theirs before yours is in. Otherwise
   whoever answered second could simply agree with whatever won them the match. */
create or replace function public.game_claim(p_code text, p_winner text, w text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); g public.games; mine text; theirs text;
begin
  if p_winner is null or p_winner not in ('host', 'guest') then
    raise exception 'A result has to say who won.';
  end if;
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'No match with that code.'; end if;
  -- "null <> k" is null rather than true, so the same "is distinct from" guard as game_leave.
  if k <> g.host_key and k is distinct from g.guest_key then raise exception 'You are not in that match.'; end if;
  if g.guest_key is null then raise exception 'Nobody joined that match.'; end if;

  if k = g.host_key then mine := g.host_claim; theirs := g.guest_claim;
  else                   mine := g.guest_claim; theirs := g.host_claim; end if;

  if mine is not null then
    -- Saying the same thing twice is how a retry after a dropped connection looks, so allow it.
    if mine <> p_winner then raise exception 'You have already said who won.'; end if;
    return public.game_row(g.code, k);
  end if;

  if k = g.host_key then update public.games set host_claim  = p_winner where code = g.code;
  else                   update public.games set guest_claim = p_winner where code = g.code; end if;

  if theirs is not null then
    update public.games
       set result_state = case when theirs = p_winner then 'agreed' else 'disputed' end
     where code = g.code;
  end if;
  return public.game_row(g.code, k);
end $$;

-- Leaving. An open invite is just cancelled; walking out of a live match hands the other player the win.
create or replace function public.game_leave(p_code text, w text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); g public.games;
begin
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'No match with that code.'; end if;
  -- guest_key is null until someone joins, and "null <> k" is null, not true. Without "is distinct
  -- from" the whole guard evaluates to null and anyone at all could cancel a stranger's invite.
  if k <> g.host_key and k is distinct from g.guest_key then raise exception 'You are not in that match.'; end if;
  if g.status in ('done', 'cancelled') then return public.game_row(g.code, k); end if;
  if g.status = 'open' then
    update public.games set status = 'cancelled', ended_at = now() where code = g.code;
  elsif g.guest_key = k and g.starts_at is not null and g.starts_at > now() then
    -- Backing out of a match that has not kicked off yet just frees the seat; nobody forfeits.
    update public.games set guest_key = null, guest_name = null, status = 'open' where code = g.code;
  else
    update public.games
       set status = 'done', ended_reason = 'left', ended_at = now(),
           winner = case when g.host_key = k then 'guest' else 'host' end
     where code = g.code;
  end if;
  return public.game_row(g.code, k);
end $$;

grant execute on function public.player_key(text), public.player_name(text), public.game_code(),
  public.game_row(text, text), public.game_host(text, int, text, timestamptz), public.game_join(text, text),
  public.game_open(int), public.game_mine(text), public.game_finish(text, text, int, int),
  public.game_claim(text, text, text), public.game_leave(text, text) to anon, authenticated;

-- 9. The explorer ---------------------------------------------------------------------------------
-- A public read of what is happening: matches under way, matches due to start, and matches finished.
-- Deliberately public, and deliberately narrow — names, scores and times only. Player keys and the
-- channel key never leave these functions, so nobody learns a wallet address or how to reach a match.
create index if not exists games_live_idx on public.games (started_at desc) where status = 'live';
create index if not exists games_done_idx on public.games (ended_at   desc) where status = 'done';

-- The score while a match is on. The host posts it after each point, because until now the running
-- score lived only in the two players' browsers and the table learned it at the final whistle.
create or replace function public.game_score(p_code text, w text default null, hs int default 0, gs int default 0)
returns void language plpgsql volatile security definer set search_path = public as $$
declare k text := public.player_key(w); g public.games;
begin
  select * into g from public.games where code = upper(trim(p_code));
  if not found then raise exception 'No match with that code.'; end if;
  if g.host_key <> k then raise exception 'Only the host reports the score.'; end if;
  if g.status <> 'live' then return; end if;           -- finished or cancelled: nothing to update
  update public.games
     set host_score = greatest(0, least(99, coalesce(hs, 0))),
         guest_score = greatest(0, least(99, coalesce(gs, 0)))
   where code = g.code;
end $$;

create or replace function public.game_explore(lim int default 12) returns jsonb
language sql stable security definer set search_path = public as $$
  with n as (select greatest(1, least(50, coalesce(lim, 12))) as k)
  select jsonb_build_object(
    'ongoing', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', code, 'title', title,
               'host_name', host_name, 'guest_name', guest_name,
               'host_score', host_score, 'guest_score', guest_score,
               'target', target, 'started_at', started_at) order by started_at desc)
        from (select * from public.games
               where status = 'live' and expires_at > now()
               order by started_at desc limit (select k from n)) q), '[]'::jsonb),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', code, 'title', title, 'host_name', host_name,
               'target', target, 'starts_at', starts_at, 'created_at', created_at)
             order by starts_at)
        from (select * from public.games
               where status = 'open' and starts_at is not null
                 and starts_at > now() and expires_at > now()
               order by starts_at limit (select k from n)) q), '[]'::jsonb),
    'past', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', code, 'title', title,
               'host_name', host_name, 'guest_name', guest_name,
               'host_score', host_score, 'guest_score', guest_score,
               'winner', winner, 'ended_reason', ended_reason, 'ended_at', ended_at)
             order by ended_at desc)
        from (select * from public.games
               where status = 'done' and guest_name is not null
               order by ended_at desc limit (select k from n)) q), '[]'::jsonb)
  );
$$;

grant execute on function public.game_score(text, text, int, int), public.game_explore(int) to anon, authenticated;

-- Make the API pick up the new functions right away.
notify pgrst, 'reload schema';
