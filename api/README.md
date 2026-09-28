# The server half

Everything here runs on Vercel, never in a browser. It exists for one reason: a FossaPay key
authorises moving the business's money, and **FossaPay has no sandbox** — every key is a production
key. There is no arrangement of `js/config.js` that makes one safe to ship.

## Environment variables

Set these in Vercel → Project → Settings → Environment Variables. None of them may appear in any file
in this repository.

| Variable | What it is |
|---|---|
| `FOSSAPAY_API_KEY` | Production key. Moves real money. |
| `FOSSAPAY_WEBHOOK_SECRET` | Verifies that a webhook really came from FossaPay. |
| `SUPABASE_URL` | Same project the browser uses. |
| `SUPABASE_ANON_KEY` | Public key, used only to ask Supabase whose access token this is. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses row-level security.** Writes payout records. Server only. |

## Endpoints

| | |
|---|---|
| `GET/POST /api/wallet` | The player's deposit address and USDT balance; POST opens one. |
| `POST /api/stake` | Moves that player's stake into the business master wallet. |
| `POST /api/settle` | Pays the pot to the agreed winner, or gives both stakes back. |
| `POST /api/withdraw` | Sends a player's own balance to the wallet on their profile. |
| `POST /api/webhook` | Signed notifications from FossaPay. Observes; never decides. |
| `GET /api/health` | Is everything configured and reachable? Says nothing secret. |

## After deploying, check the setup

```
https://tablecourt.vercel.app/api/health
```

It answers 200 when every variable is set, the FossaPay key is accepted, a Solana master wallet
exists, and the database schema is new enough. Otherwise 503 with the specific thing that is wrong.
It reports whether each secret is *present*, never what it is: a key that appears in a diagnostic page
ends up in screenshots and support threads.

## The webhook URL

Put this in the FossaPay dashboard, exactly:

```
https://tablecourt.vercel.app/api/webhook
```

**HTTPS, not HTTP.** `http://` gets a 308 redirect from Vercel, and a provider posting a signed body
to a redirect is a good way to lose deliveries.

It verifies the HMAC over `JSON.stringify(body.data)` — the data object alone, not the envelope — and
refuses anything unsigned. It answers 200 immediately, because FossaPay retries up to five times on
anything else and a slow handler turns one event into five.

It deliberately moves no money and settles nothing. Every payout is driven by an explicit request from
a player, checked against the database at the time. A webhook can be replayed, arrive late, or arrive
five times, so it is used to observe and never to decide — which means a missed delivery cannot cost
anybody their stake. It also means there is no events table yet: deduplication is only needed once
this endpoint does something, and it does not.

Each one identifies the caller by asking Supabase whose access token was sent. A player id is never
read from a request body, and neither is an amount or a winner.

## Where the money is, and who can take it

The pot sits in the business master wallet. **You are the custodian.** That is a deliberate choice —
it replaced an on-chain escrow where nobody, including the operator, could move a locked stake — and
it has consequences worth being plain about:

- A player must trust you not to take the pot. The escrow needed no such trust.
- You are holding other people's money, which in most places is a regulated activity, and doing it for
  wagering is regulated further.
- `api/settle.js` is the only thing standing between a player and their money. A bug there pays the
  wrong person; there is no program to refuse it.

## Three rules the code keeps

**Money is decimal, never a float.** Amounts travel as strings and are compared as BigInt in the
token's smallest unit. `tools/test_money.js` checks this.

**What arrives is not what was sent.** FossaPay deducts its transfer fee from the amount submitted, so
a 10 USDT stake reaches the pot as less. Every payout is computed from `stake_net_host` and
`stake_net_guest` — what actually landed. Computing it from the asked-for stake has the business cover
the provider's fee on every match, and above about a 1% provider rate the pot cannot cover its own
payout at all. That was a real bug in the first draft of `settle.js`; the test now states it as an
invariant.

**An accepted request is not a settled one.** FossaPay returns processing states that are not
finality, and a timeout after submitting a transfer is ambiguous rather than failed — the money may
well have gone. Nothing here retries a transfer blindly; the recorded transaction id is checked first.

## What has never been run

**None of this has been executed against FossaPay.** There is no sandbox, so the first run of any of it
moves real money. What has been tested is the arithmetic (`node tools/test_money.js`) and that the
files parse. The request shapes, the response field names, and the payout endpoint are written from the
documentation and have not been confirmed against the live API.

Two specific unknowns:

- `api/settle.js` sends payouts through `master/transactions/sign-and-broadcast`, with a fallback to a
  plain master transfer route. Which one this merchant account actually accepts is unconfirmed.
- The exact field names FossaPay returns for balances and wallet addresses vary across the docs, so
  the readers accept several shapes. One of them is right.

Test with amounts you would not mind losing.
