# Table – the staking escrow

The on-chain half of a staked 1v1. Two players put up the same stake in an SPL token; the pot sits here
until **both of them say who won**. Only a result they agree on pays anybody.

Program ID `9FMrUJ9Ahmxqagixp89t29rs6HoP5KckZLtsgVrnnrAU` · devnet only so far · not deployed yet.

## Why both players

The match runs in the two browsers and the host runs the physics, so the host alone could claim any
result it liked. Nothing on chain can prove a rally ever happened. What it *can* do is refuse to pay
unless the player who lost agrees.

So a cheating host cannot take anybody's stake. The furthest it reaches is a disagreement, which pays
nobody and returns both stakes. Losing costs the cheat nothing either, so this prevents theft rather
than discouraging attempts. A sore loser can also refuse to confirm a result they did lose, and force a
refund — that is griefing, not theft, and the cost of not being able to prove the score.

## The fee

1% of **each** player's stake, so 2% of the pot. Both stake 10 USDC → the winner receives 19.8 and 0.2
goes to the platform. Rounding is down, so a stake too small to carry a fee carries none.

**Refunds are never charged.** No fee on a dispute, a no-show, or a cancel.

The fee wallet is a `const` in `lib.rs`, not an instruction argument, so no caller can redirect it. Each
match also records the fee rate it was opened under, so upgrading the program cannot change the terms of
a match already under way.

## What can happen

| Instruction | Who | What it does |
|---|---|---|
| `open` | host | creates the match, names the guest, pays the host's stake in |
| `join` | the named guest | pays the guest's stake in; the match locks |
| `claim` | either player | records who *they* say won; cannot be changed once given |
| `settle` | either player | both agreed → pays the winner, takes the fee, closes the pot |
| `refund` | either player | they disagree, or the deadline passed → each takes their own stake back |
| `cancel` | host | nobody ever joined → the host takes its stake back |

The guest is named at `open` rather than left open, so a stranger cannot take the invited player's seat
and strand the pot until the deadline.

## Tests

```bash
anchor test
```

18 in total: 6 Rust unit tests on the fee arithmetic, and 12 against a real validator. Most of them are
attempts to take money that is not yours, and each has to fail for a *named* reason:

- paying out on one signature → `ResultIncomplete`
- changing your answer after seeing theirs → `AlreadyClaimed`
- an answer from someone who was not playing → `NotYourMatch`
- settling the same match twice
- being paid as a winner you are not → `WrongWinner`
- sending the fee to your own wallet → `WrongFeeWallet`
- refunding a live, undisputed match → `NotRefundableYet`
- cancelling after the guest's money is in → `WrongState`
- taking the invited player's seat → `NotYourMatch`

The happy path checks balances to the last unit, and that the pot account is *closed* rather than left
holding dust.

## Back up the program keypair

`target/deploy/table_bet-keypair.json` is git-ignored, which is right — it should not be in a repo. But
it is also the only thing that can deploy to this program ID. **Copy it somewhere safe now.** Lose it
and the program address is gone, along with any funds held under its PDAs.

## Three local-setup traps

Worth knowing, because none of them report what is actually wrong.

**Dependency versions.** The SBF toolchain ships its own rustc (1.84.1 for platform-tools v1.51), older
than current crates.io. Eight crates had moved to edition 2024 and the build failed with
`feature edition2024 is required`, naming a crate you have never heard of. `Cargo.lock` pins them back
and is committed — do not run a blanket `cargo update`.

**Validator ports.** `solana-test-validator` defaults its gossip port to 8000 and panics if anything
holds it. `Anchor.toml` moves it to 8011. Setting `gossip_port` alone then fails a *second* way
(`UnspecifiedIpAddr`) because Anchor passes `--bind-address 0.0.0.0`, so `bind_address` is pinned too.

**yarn.** On Debian and Ubuntu the `yarn` on PATH is usually cmdtest's unrelated tool. It fails with
`no such option: -p`. `Anchor.toml` uses npm instead.

## Not wired up yet

- **Nothing is deployed.** Next step is `anchor deploy --provider.cluster devnet`.
- **The browser does not call this.** `js/` has no Solana code; the game plays and settles through
  Supabase as before, and `game_claim` already collects both players' answers off-chain.
- **Ephemeral Rollups are not used.** The escrow is plain base-layer Anchor, which is the right shape
  for it: a bet is three transactions, so the speed and zero fees an ER exists for buy little, and
  MagicBlock's own security guide requires base-layer settlement before treating a payout as final. ER
  earns its place if match *state* later moves on-chain, which would also remove the need for players
  to agree at all.
