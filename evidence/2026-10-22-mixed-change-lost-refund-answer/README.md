# Sandbox proof: one change, three money actions

Generated 2026-10-22T07:16:36.874Z from `90f978f` against the PayPal Sandbox (test money).

**Result: all 14 checks passed.**

One client-confirmed change replaces a held lounge chair with a writing desk and returns a captured rug with a $60 restocking fee. Setti releases the chair's hold, authorizes and captures the desk, and refunds the rug minus the fee, each as its own PayPal action.

## Steps

| Step | PayPal operations |
|---|---|
| Authorize the lounge chair ($800.00) | authorize $800.00 · succeeded · `1GM257889T578012B` |
| Authorize the wool rug ($300.00) | authorize $300.00 · succeeded · `5HM215209C4369018` |
| Capture the rug after supplier confirmation | capture $300.00 · succeeded · `8HM7406342578603W` |
| Release the lounge chair hold | void $800.00 · succeeded · `1GM257889T578012B` |
| Authorize the writing desk ($1,100.00) | authorize $1,100.00 · succeeded · `8E002103LB3280808` |
| Capture the desk after supplier confirmation | capture $1,100.00 · succeeded · `9RA17236TV607770F` |
| Refund the rug minus the restocking fee | refund $240.00 · unknown |
| Check the refund whose answer was lost | refund $240.00 · succeeded · `0FS14777WJ130534X` |

## Checks

| Check | Result | Detail |
|---|---|---|
| Authorization 5HM215209C4369018 matches the ledger | pass | PayPal CAPTURED 30000¢; ledger captured 30000¢ |
| Authorization 1GM257889T578012B matches the ledger | pass | PayPal VOIDED 80000¢; ledger voided 80000¢ |
| Authorization 8E002103LB3280808 matches the ledger | pass | PayPal CAPTURED 110000¢; ledger captured 110000¢ |
| Capture 8HM7406342578603W matches the ledger | pass | PayPal PARTIALLY_REFUNDED 30000¢; ledger completed 30000¢ |
| Capture 9RA17236TV607770F matches the ledger | pass | PayPal COMPLETED 110000¢; ledger completed 110000¢ |
| Refund 0FS14777WJ130534X matches the ledger | pass | PayPal COMPLETED 24000¢ custom_id 8769b1bc-fdfe-4d87-afb1-4fc2aec5e366; ledger completed 24000¢ operation 8769b1bc-fdfe-4d87-afb1-4fc2aec5e366 |
| Order 7J224378F75142154 lists exactly the recorded refunds | pass | PayPal [0FS14777WJ130534X]; ledger [0FS14777WJ130534X] |
| Order 6NC21383849530012 lists exactly the recorded refunds | pass | PayPal []; ledger [] |
| Order 2YF73904CB732241D lists exactly the recorded refunds | pass | PayPal []; ledger [] |
| Refund step 8769b1bc-fdfe-4d87-afb1-4fc2aec5e366 produced exactly one PayPal refund | pass | 1 PayPal refund(s) carry this step's custom_id |
| A refund whose answer was lost is recovered without a second refund | pass | operation succeeded after 2 attempt(s); order lookup found the refund by custom_id |
| Lounge chair hold released, nothing charged | pass | as confirmed |
| Writing desk captured in full | pass | as confirmed |
| Rug refunded except the $60 restocking fee | pass | as confirmed |

## PayPal resources read back with GET

| Kind | PayPal ID | Status | Amount | Debug ID |
|---|---|---|---|---|
| authorization | `5HM215209C4369018` | CAPTURED | $300.00 | `ca4e6b7b289e2` |
| authorization | `1GM257889T578012B` | VOIDED | $800.00 | `ca4e6b7b45adb` |
| authorization | `8E002103LB3280808` | CAPTURED | $1,100.00 | `ca4e6b7b5db8e` |
| capture | `8HM7406342578603W` | PARTIALLY_REFUNDED | $300.00 | `ca4e6b7b7ecd5` |
| capture | `9RA17236TV607770F` | COMPLETED | $1,100.00 | `ca4e6b7b95d81` |
| refund | `0FS14777WJ130534X` | COMPLETED | $240.00 | `ca4e6b7bb2e8d` |
| order | `7J224378F75142154` | COMPLETED | $300.00 | `ca4e6b7bc8f35` |
| order | `6NC21383849530012` | COMPLETED | $800.00 | `ca4e6b7bf1889` |
| order | `2YF73904CB732241D` | COMPLETED | $1,100.00 | `ca4e6b7c29a2a` |

## Seller breakdown reported by PayPal

| Kind | PayPal ID | Gross | PayPal fee | Net |
|---|---|---|---|---|
| capture | `8HM7406342578603W` | $300.00 | $12.00 | $288.00 |
| capture | `9RA17236TV607770F` | $1,100.00 | $43.20 | $1,056.80 |
| refund | `0FS14777WJ130534X` | $240.00 | $0.00 | $240.00 |

## How this was produced

- `npm run sandbox:proof` ran the app's own chat, pricing, approval and payment code against an isolated proof database and the PayPal Sandbox.
- The sandbox buyer approved each authorization on PayPal's checkout page. The AI draft step used a fixed draft; supplier confirmations and credits are designer-entered demo records.
- `provider-verification.json` holds every GET result and check; `ledger.json` holds the local money records and steps. Payment source files are fingerprinted by SHA-256.
