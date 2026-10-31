# PayPal Sandbox probes

Small scripts that ask the PayPal **sandbox** how it really behaves before the
app depends on it. Each run writes what happened (request summary, response or
error, PayPal debug id, timing) to `probes/recorded/<probe>-<date>.json` with
personal fields redacted. Those recordings are evidence for the README and the
templates for the fake PayPal used in tests.

All probes refuse to start unless `PAYPAL_ENV=sandbox` (see `.env.example`).

## Setup

1. Create a sandbox REST app at developer.paypal.com and copy its client id and secret into `.env.local`.
2. In the app settings, make sure **Vault** (save payment methods) is enabled for P6/P7.
3. Have a sandbox **personal (buyer)** account ready; probes that need buyer approval print a link and wait.
4. Run a probe with `npx tsx probes/<file>.ts [args]`.

Shared state between probes (standing authorization ids, the vault token) is kept in
`probes/.state.json`, which is gitignored. Each authorization is labelled so you can
pick which one a probe uses.

## The probes

| Probe | What it checks | Args | Needs buyer | Wait |
|---|---|---|---|---|
| P1 `p1-standing-authorization.ts` | Creates an AUTHORIZE order, buyer approves, authorizes it and keeps the hold open as a labelled "standing authorization" | `--label <name> [--amount 100]` | yes | - |
| P2 `p2-multiple-partial-captures.ts` | Several partial captures on one authorization, a final capture, then one more capture (expected to fail) | `--auth <label>` | no | - |
| P3 `p3-over-capture.ts` | Capturing above the authorized amount: exactly at the allowance (15% or $75, whichever is less) and one cent past it | `--within <label> --beyond <label>` | no | - |
| P4 `p4-reauthorize-timing.ts` | Reauthorizing inside the 3-day honor period (expected to fail); after day 3, reauthorizing once, comparing expiry dates, then trying a second reauthorization | `--auth <label>` | no | run once now, again after 3+ days |
| P5 `p5-reauthorize-after-partial.ts` | Partial capture, then reauthorizing the remaining amount | `--auth <label> [--force]` | no | authorization must be 3+ days old |
| P6 `p6-vault-setup.ts` | Saves the buyer's PayPal (setup token, buyer approval, payment token) | - | yes | - |
| P7 `p7-vault-authorization.ts` | Merchant-initiated AUTHORIZE orders with the vault id (no buyer step): one hold is partially then fully captured, a second `<label>-aged` hold is kept for P4/P5 later | `--label <name> [--amount 100]` | no | - |
| P8 `p8-pay-later-authorize.ts` | Whether an AUTHORIZE order works when the buyer chooses Pay Later | `[--amount 200]` | yes | - |
| P9 `p9-void-after-partial.ts` | Partial capture, void the rest, read the authorization back to see which amount PayPal reports | `--auth <label>` | no | - |
| P10 `p10-test-card-approval.ts` | Approves an order from the server with a Sandbox test card: confirms the app's own order with the card and authorizes it, and creates an order with the card as its payment source. Voids both holds | `[--card 4012000033330026]` | no | - |
| P12 `p12-card-vault.ts` | Saves the test card in the vault while confirming the app's own order, reads it back, holds a new amount with the saved card (merchant-initiated, no buyer), captures 115% of a card hold, reads and deletes the token, then holds with the deleted token and deletes it again. Voids every open hold | - | no | - |

### Suggested order

Day 0:

```bash
# standing holds for the tests that consume them
npx tsx probes/p1-standing-authorization.ts --label wallet-a   # for P2
npx tsx probes/p1-standing-authorization.ts --label wallet-b   # for P3 (within)
npx tsx probes/p1-standing-authorization.ts --label wallet-c   # for P3 (beyond)
npx tsx probes/p1-standing-authorization.ts --label wallet-d   # for P4, keep for day 4+
npx tsx probes/p1-standing-authorization.ts --label wallet-e   # for P5, keep for day 4+
npx tsx probes/p1-standing-authorization.ts --label wallet-f   # for P9

npx tsx probes/p2-multiple-partial-captures.ts --auth wallet-a
npx tsx probes/p3-over-capture.ts --within wallet-b --beyond wallet-c
npx tsx probes/p4-reauthorize-timing.ts --auth wallet-d          # expect "too soon"
npx tsx probes/p9-void-after-partial.ts --auth wallet-f
npx tsx probes/p6-vault-setup.ts
npx tsx probes/p7-vault-authorization.ts --label vault-a
npx tsx probes/p8-pay-later-authorize.ts
```

Day 4 or later (an authorization can only be reauthorized between day 4 and day 29):

```bash
npx tsx probes/p4-reauthorize-timing.ts --auth wallet-d
npx tsx probes/p5-reauthorize-after-partial.ts --auth wallet-e
npx tsx probes/p5-reauthorize-after-partial.ts --auth vault-a-aged
```

## App-level proof

`npm run sandbox:proof` runs one complete change through the app's own chat, pricing, approval and payment code against the Sandbox, then reads every PayPal resource back with GET and writes `evidence/<date>-mixed-change/` (`README.md`, `provider-verification.json`, `ledger.json`).

The scenario: a lounge chair and a wool rug are authorized and the rug is captured; one confirmed change then replaces the chair with a writing desk and returns the rug with a $60 restocking fee. Setti releases the chair hold, authorizes and captures the desk, and refunds the rug minus the fee.

- The sandbox buyer approves three authorizations; the runner prints each link and waits.
- It uses its own database (`SETTI_PROOF_DATABASE_URL`, default `setti_proof` on the `DATABASE_URL` server) and empties it first; any name not ending in `_proof` is refused.
- `--drop-refund-response` discards the first refund answer after PayPal processes it, then checks that the step is recovered by its custom_id without a second refund.
- The run fails (exit code 1) if any PayPal read disagrees with the local ledger.

## Reading the results

- `ok: true` with a `response` means PayPal accepted the call; check `status`, amounts and `expirationTime` in the response.
- `ok: false` keeps PayPal's error body (`name`, `details[].issue`, `debug_id`). Several steps are expected to fail; the step name says so.
- `notes` summarise the numbers the probe cared about (e.g. original vs. new expiry after reauthorization).
- Review every file before committing it. Redaction removes names, emails, payer ids, phones and addresses, but not order or authorization ids (sandbox only).

Known expectations to confirm or refute: reauthorization is allowed once and does not extend the 29-day expiry; a capture after a final capture is rejected; Pay Later may not be offered in the redirect flow.
