# Table

3D table tennis in the browser. Landing page, sign-up (email or Solana wallet), a vs-CPU arena,
and online 1v1 with shareable invite links. No build step. It is plain HTML, CSS and JavaScript.

## Set it up (10 minutes)

1. **Database.** In Supabase open *SQL Editor > New query*, paste **all** of `supabase/schema.sql`, and run it.
   Run it again whenever you get a new version of this file. It is safe to re-run, and re-running also
   upgrades a project that still has an older version (it removes the old `wallet_sign_in` function).
   The sign-in screen tells you if your database is out of date.
2. **Key.** In Supabase open *Project Settings > API*. Copy the **anon / publishable** key
   into `js/config.js`. (Never use the service_role or secret key.)
3. **Auth settings.** In *Authentication > URL Configuration*:
   - Set **Site URL** to your live address, e.g. `https://tablecourt.vercel.app`. This is the address
     Supabase falls back to, and leaving it on `http://localhost:...` is why confirmation emails sent
     from the live site land on localhost.
   - Add every address the game is served from to **Redirect URLs**, one per line:
     `https://tablecourt.vercel.app/**`, plus `http://localhost:8000/**` and `http://127.0.0.1:5500/**`
     while you are developing. The app asks for a confirmation link back to wherever the player signed
     up, but Supabase only honours that if the address is on this list; otherwise it silently uses the
     Site URL instead.
   - *Confirm email* is on by default, so a new account must click the emailed link before signing in.
     Turn it off under *Providers > Email* while testing.
   You do **not** need the Web3 Wallet provider. Wallet sign-in does not use it any more.
4. **Run it.** `python3 tools/serve.py`, then open http://localhost:8000
   Use this rather than `python3 -m http.server`: that one sends no cache headers, so after an edit a
   browser can hold on to the old `js/…` file while taking the new `index.html`, and the game then
   breaks somewhere that has nothing to do with what you changed.
5. **Deploy.** `npx vercel --prod`, or push to a repo Vercel is watching. Before you do, run:

   ```
   python3 tools/stamp.py        # version the scripts so no browser mixes old and new
   python3 tools/preflight.py    # refuses to pass if anything is out of step
   ```

   Stamping is not optional. Every script and stylesheet is given a `?v=<hash of its contents>`, so a
   browser holding an old `js/audio.js` cannot pair it with a fresh `index.html`. Skip it after editing
   a file and some visitors get a half-old set, which fails with a confusing error like
   `Sfx.onChange is not a function` rather than anything that points at the real cause.
   `preflight.py` checks the stamps are current and will not pass until they are.

Until you add the key, the sign-in screen says it is not set up and **Play as guest** still works.

## How accounts work

- **Email:** normal Supabase sign-up. The username is saved in `profiles`.
- **Wallet:** the page asks an external Solana wallet (Phantom, Solflare, Backpack, or any Wallet Standard wallet)
  for its address. New wallets choose a username. The address and username go into `wallet_players`.
  The browser remembers the wallet, so players stay signed in on that device.
  On a phone with no wallet extension, use the "Open in Phantom app" link so the game opens inside the wallet's browser.
- Wallet tables cannot be read or changed directly. The app uses three database functions
  (`wallet_login`, `wallet_register`, `wallet_save_match`).

## How a shot is made

The bat follows your pointer for aiming, but the shot comes from how you **swing**, read from the last
tenth of a second of movement. Aiming can therefore stay smooth and unhurried without costing you the
ability to hit hard.

| Swing | Shot |
|---|---|
| Up through the ball | Topspin, or a lob if the lift is gentle |
| Down across it | Chop or slice |
| Sideways | Side spin, curving the flight |
| Fast, any direction | More power and depth; hardest becomes a smash |
| Pull back, then forward | A loaded shot, worth about 45% more power than the same speed cold |

Mouse, touch and the on-screen pad all feed the same tracker, so a shot feels the same everywhere.
When nothing has recorded a swing — the CPU, or the headless tests — the bat's own travel is used
instead, so the old behaviour still holds.

## The explorer

**Matches** on the landing page, or `#/matches`, shows what is going on. It needs no sign-in.

| Tab | Shows |
|---|---|
| Live | Match name, both players, the running score, how long it has been going |
| Upcoming | Match name, who is hosting, the date and time, and a countdown |
| Results | Match name, both players, the final score, who won |

It refreshes every six seconds. The running score is there because the host posts it to `games` after
each point; before that the score lived only in the two players' browsers and the table only learned
it at the final whistle.

**This is public on purpose.** Anyone who opens the page sees match names, usernames and scores. What
they never see is a wallet address, a player key or a match's channel key: `game_explore` selects the
columns by hand and those are not among them.

## Sound

- Impacts are real clips in `assets/audio/sfx/`, pitched and levelled slightly differently every time
  so a long rally does not become one click repeating. Panning follows the ball across the table.
- `tools/make_sfx.py` builds those clips from scratch. They are synthesised, not recorded — drop real
  recordings over them with the same filenames whenever you have some, and nothing else changes.
- Music lives in `assets/audio/music/`. A static site cannot read a directory, so the playlist is
  written down in `assets/audio/manifest.json`: add tracks, run `python3 tools/make_audio_manifest.py`,
  and they join in. The order is shuffled, never repeats a track back to back, and reshuffles rather
  than stopping when it reaches the end.
- **The music folder starts empty.** Until you add tracks there is no music; everything else works.
- Music plays at full volume on the landing and sign-up screens and drops to 5% inside a match so the
  ball is the loudest thing in the room.
- Browsers refuse to play anything before a real tap, so both music and effects start on the first one.
- The gear icon on the landing page and in the arena opens sound settings: one mute switch, a music
  slider and an effects slider, remembered on that device. The quick mute button and **M** still work.
- If a clip is missing the game falls back to the old generated tone for that sound, so a half-filled
  `assets/audio/` folder is still playable rather than silent.

## Playing someone else

Sign in (guests cannot play online, because an opponent needs a name to see), then **Play with a
friend**. That screen offers two things: host a game, or join one with a code.

- **Host a match.** Give it a name if you like, and a kick-off time if you want it later. You get a
  six-character code and a link to share with the Copy, Share, X, WhatsApp, Telegram, Reddit or
  Facebook buttons.
- **Your invite stays up.** Closing the page does not cancel it. Come back to *1v1 online* and it is
  waiting under **Your matches**: *Open* walks back in, *Cancel* ends it. An invite with no kick-off
  time lasts a day; a scheduled one lasts until three hours after it starts.
- **Open now and Upcoming.** Matches anyone can take are listed under *Open now*; scheduled ones sit
  under *Upcoming* with a live countdown.
- **Take an open challenge.** Tap Accept, or type the six-character code.
- **Both players wait together.** Whoever arrives first sits on the match card until the other shows
  up and the clock comes round, then the match starts on both screens at once. Backing out of a
  scheduled match before kick-off just frees the seat: nobody forfeits.
- An invite link looks like `https://your-site/#/join/ABC234`. Opening one while signed out sends you
  to sign-in first and then straight into the match.

### Starting a match

Whoever arrives first waits on the match card. Once both are there and the clock has come round, the
**host** presses *Start match*: both screens count down 3 · 2 · 1 · GO together, and serving is blocked
until it finishes so nobody is dropped into a rally they were not looking at.

### Seeing and hearing each other

Two buttons appear in the arena during a 1v1: camera and microphone. **Both are off, and nothing is
captured and no permission is asked for until you press one.** Either can be on without the other, so
you can talk without being seen.

The video and audio go straight between the two browsers over WebRTC. Nothing passes through Supabase:
the match channel that already carries paddle positions is reused to introduce the two browsers to each
other, and the media itself is a direct connection. Small tiles sit in the corner — the other player,
and a mirrored preview of you — at 320×240 and 15 frames a second so the 3D scene keeps its budget.

You do not have to switch anything on to see and hear the other player: with your own camera and
microphone off you still receive theirs. Turn your camera off mid-match and the other side is told at
once, rather than being left looking at a frozen frame. A voice with no picture reads as "@them is on
mic". Leaving the match stops the camera.

The master mute silences the other player's voice along with everything else, so the tile says so when
that is why you cannot hear them.

**Camera needs HTTPS.** It works on your deployed site but not over plain `http://` on a local network
address, because only `localhost` counts as a secure context. Test video on the deployed site.

Public STUN introduces most home connections. Roughly one pair in six is behind a network that will not
let two people talk directly and needs a paid TURN relay; for them the video never connects and the
match carries on regardless. Add a relay as `ICE_EXTRA` in `js/config.js` and it is used automatically.

### How it works

One browser is the **host** and runs the physics, exactly as it does against the CPU. The other is the
**guest**: it draws what the host sends and sends back where its paddle wants to be. The host always
plays the near end and the guest the far end, so both screens hold the same world and only the camera
differs. Twenty updates a second each way, with the guest carrying the ball forward between them so it
does not step.

Live play never touches the database. The two pages talk over a Supabase Realtime **broadcast** channel
called `game-<code>`, which needs no setup beyond the anon key you already added. The `games` table only
records who is playing and how it ended.

### Staking, later

`games` already carries `stake_token`, `stake_amount` and `stake_status` (`none`, `pending`, `locked`,
`paid`, `refunded`). Nothing reads or writes them yet, and the app never sets them. They are there so an
entry fee can be added without another migration. Do not build payouts on the current results: see below.

## Controls

| | |
|---|---|
| Move paddle | Move mouse or drag finger. Or switch on **Pad** and use the pad at the bottom |
| Serve | Click, tap, or Space |
| Spin | The swing decides the shot — see below |
| Pause | P or Esc, or the pause button |
| Rotate view | Right-drag, two fingers, or arrow keys (drag outside the pad when Pad is on) |
| Sound | M, or the speaker button |

## Files

- `index.html` – the three screens (landing, sign-up, arena)
- `js/core.js` – physics and rules. No drawing code, so an agent arena can reuse it
- `js/scene.js` – 3D scene, camera, hit and bounce effects
- `js/app.js` – screens, controls, pause, pop-ups
- `js/errors.js` – turns every failure into a sentence for the player and a console group for you
- `js/auth.js` – Supabase sign-up and sign-in, wallet accounts, saving matches
- `js/net.js` – online 1v1: hosting, invites, the realtime link, and the public match feed
- `js/video.js` – camera and microphone between the two players, straight browser to browser
- `js/wallet.js` – finds and connects external Solana wallets
- `js/audio.js` – sound effects (made in code, no audio files)
- `supabase/schema.sql` – tables, security rules, triggers
- `tools/build_preview.py` – packs everything into one HTML file for quick sharing

## When something goes wrong

Every failure goes through `js/errors.js`, which shows it twice.

- **The player** gets a plain sentence and what to do about it: *"Cannot reach the server. Check your
  internet connection and try again."* Never a code, never database wording.
- **You** get a collapsed console group headed `Table · <what was happening> · <code>` holding the
  sentence the player saw, the technical message, the error code and the stack.
- Anything unexpected also raises a banner at the bottom of the screen with a **Details** button that
  prints the technical line on the page, so a bug that only happens on someone else's phone can be
  read out without opening developer tools.
- Uncaught errors and unhandled promise rejections are caught too, so a crash says something instead
  of leaving the game looking frozen.

To add a case, put a rule at the top of `RULES` in `js/errors.js`. The first match wins, so keep the
specific patterns above the general ones: a bare `/denied/` would swallow `permission denied for
table ...` along with the wallet pop-up the player dismissed.

## When sign-in does not work

| What you see | What to do |
|---|---|
| "Your database is out of date" | Re-run all of `supabase/schema.sql` in the SQL Editor |
| `ERROR: 42703: column "wallet" does not exist` | An old copy of the wallet tables. The current `schema.sql` moves them aside and copies the rows over, so just re-run it |
| "Could not find the function …" | Same as above, then run `notify pgrst, 'reload schema';` |
| Sign-up works, sign-in says wrong password | *Confirm email* is on. Click the link in the email, or turn it off (step 3) |
| "Sign-in is not set up yet" | The anon key in `js/config.js` is still a placeholder |

To see what the database thinks, run this in the SQL Editor. Every value should be `true`:

```sql
select public.table_setup_check();
```

If the script moved old tables aside, your rows are copied into the new tables and the originals are
kept as `wallet_players_backup_<timestamp>` and `wallet_matches_backup_<timestamp>`. Nothing reads them,
and you can drop them once you are happy:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename like 'wallet_%_backup_%';
```

## Good to know

- **The wallet is not verified.** The app takes the address from the wallet, but it does not ask the wallet to sign anything.
  Someone who calls the database directly could use another person's address. That is fine for a scoreboard.
  Before any money, prizes or agent tournaments depend on it, add a signed message that a server checks.
- Wins and losses are saved from the browser, so a determined user could fake them.
  The database only rejects matches that are not finished (first to 11, win by 2).
- **Online, the host runs the rules,** so a determined host could cheat, and only the host reports the
  score. Before money rides on a result, a server has to replay the match from the recorded shots.
- **Pulling the plug does not lose you the match.** Pressing Leave hands the other player the win, but a
  closed laptop or a dropped connection ends the match with nothing recorded: the row stays `live` and
  expires. The player still connected deliberately does *not* report the result, because `game_leave`
  always names its caller as the one who left — reporting it would hand the win to whoever dropped.
  Deciding a forfeit properly needs a server that can tell a broken connection from a pulled cable.
- A hidden tab stops `requestAnimationFrame`, so a live 1v1 keeps ticking from a timer instead. It runs
  slower while the tab is in the background; it does not freeze the match for the other player.
- A scheduled match still needs the host's browser open at kick-off, because the host runs the physics.
  The invite survives a closed page; the match itself cannot start without them.
- You can have five invites waiting at once. Cancel one before opening another.
- Each match sends roughly 2,400 realtime messages a minute across both players. That is fine for a
  demo; check your Supabase plan's limits before a tournament.
- Third-party libraries and fonts are included in `vendor/` (three.js r128, supabase-js 2.116,
  flatpickr 4.6.13, and the BBH Bogle and IBM Plex Mono web fonts). BBH Bogle is the display face:
  headline, card titles, scores, match codes and the in-game shout-outs. It has capitals only, so
  anything set in it reads as capitals whatever the user typed, and it ships a single 400 weight,
  so those rules must not ask for a bold the font cannot supply. Nothing is
  fetched from a CDN at runtime, so the game works on a locked-down network and offline apart from
  the database, no third party sees your players' IP addresses, and the Content-Security-Policy in
  `vercel.json` can stay at `font-src 'self'`.
- The kick-off picker is flatpickr, restyled to match the arena. On a phone it steps aside and lets the
  operating system's own date and time wheel do the job, which is easier to use than any web calendar.
  If the library ever fails to load, the field falls back to the browser's built-in `datetime-local`.
