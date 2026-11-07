# Security

Setti changes money after a client has already paid: when a project changes, it captures or releases PayPal holds and refunds charges, and an AI agent drafts those changes and explains the money. This file lists the ways someone could try to move money they should not, or make Setti report money wrongly, what stops each one, and the tests that show it holds.

Each item names the code that does the stopping and the tests by their exact names, so you can search for them. `npm test` runs them all; the database tests need Postgres (see [Run the tests](README.md#run-the-tests)). Setti is a Sandbox-only hackathon build, and [what this does not cover](#what-this-does-not-cover) is listed at the end.

| | Threat | What stops it |
|---|---|---|
| 1 | [Prompt injection](#1-prompt-injection) | The model can only propose changes for the designer to review; it has no PayPal client and no field for a price |
| 2 | [The model writes a wrong amount](#2-the-model-writes-a-wrong-amount) | Every amount is checked against the records it cites before anyone sees it |
| 3 | [Changing a price without the right to](#3-changing-a-price-without-the-right-to) | Prices come from the server's frozen quote, and each money step belongs to one role |
| 4 | [Opening another visitor's project](#4-opening-another-visitors-project) | Each browser has its own workspace; shared links are read-only |
| 5 | [Replaying a request](#5-replaying-a-request) | Each step runs once, with one fixed PayPal request id |
| 6 | [Refunding twice, or more than was charged](#6-refunding-twice-or-more-than-was-charged) | Database triggers cap refunds and captures; each PayPal id is recorded once |
| 7 | [Forging a PayPal webhook](#7-forging-a-paypal-webhook) | PayPal verifies every event, and events never move money |
| 8 | [Writing from another site](#8-writing-from-another-site) | Every write needs this app's exact Origin |
| 9 | [Faking a return from PayPal](#9-faking-a-return-from-paypal) | Return links are signed per step, and only PayPal's own order status counts |

## 1. Prompt injection

Someone hides instructions in a chat message, a supplier's product page or a quote field, hoping the AI will change prices, approve something or claim that a refund went out.

- The model's whole output is a strict schema: an answer, a clarifying question, or a list of item changes for the designer to review. It has no field for a price, an approval or a payment. Prices come from the approved quote and from supplier pages the server reads itself.
- The code that calls the model never loads the code that creates a PayPal client, so even a fully hijacked model has nothing to move money with.
- The prompt treats messages, product pages and earlier replies as untrusted data.

Code: [`src/ai/output.ts`](src/ai/output.ts) (`aiOutputSchema`), [`src/ai/draft.ts`](src/ai/draft.ts) (`buildDraft`), [`src/pricing/calculation.ts`](src/pricing/calculation.ts) (`createPricingInput`), [`src/ai/model.ts`](src/ai/model.ts) (`CHANGE_SYSTEM_PROMPT`)

Tests:
- [`src/ai/paypal-boundary.test.ts`](src/ai/paypal-boundary.test.ts): "never loads the code that creates a PayPal client, so the model's side cannot move money", and "does find the PayPal client from the payment routes, so the check above can fail"
- [`src/ai/draft.test.ts`](src/ai/draft.test.ts): "never accepts model-supplied prices or order actions"; "rejects invented quote IDs, product IDs, foreign sources and repeated changes"
- [`src/pricing/calculation.test.ts`](src/pricing/calculation.test.ts): "rejects deleted, duplicate or injected changes and issues, including changed issue labels"
- [`evals/`](evals/README.md): 11 cases with instructions injected into supplier pages, quote fields or the chat, run against the real model (see [AI quality](README.md#ai-quality))

## 2. The model writes a wrong amount

The model could misread the records, add numbers up wrongly, or say a refund went out when it has not.

- A money answer must cite the recorded facts it rests on, and every amount and payment status in it must appear in those facts. Totals the model works out itself are rejected.
- An answer that fails goes back to the model once, with what to fix. If it fails again, the reader sees only the recorded facts, labelled as a system notice.
- A change draft never carries the model's totals. The server prices it again from its own quote, in integer cents.

Code: [`src/ai/money-answer.ts`](src/ai/money-answer.ts) (`verifyMoneyAnswer`), [`src/chat/service.ts`](src/chat/service.ts), [`src/pricing/calculation.ts`](src/pricing/calculation.ts)

Tests:
- [`src/ai/money-answer.test.ts`](src/ai/money-answer.test.ts): "rejects an amount the cited facts do not contain, including totals Setti worked out itself"; "rejects amounts or payment statuses stated without citing a fact, and rows without citations or with several amounts"
- [`src/chat/money-service.test.ts`](src/chat/money-service.test.ts): "sends an unverified answer back once with what to fix, and saves the corrected answer"; "shows only the recorded facts, as a system notice, when the answer fails verification twice"; "does not permit financial claims through clarification prose"
- [`src/pricing/calculation.test.ts`](src/pricing/calculation.test.ts): "old handling uses server-owned quote even if AI before/subtotals are wrong"

## 3. Changing a price without the right to

A client, or a script posing as one, tries to send their own price or total, edit a quote that was already sent, or run a step that belongs to the designer.

- Payment requests carry no amounts: the server prices every payment step from the frozen quote. In the pricing review, where the designer enters prices, the server works out the totals itself and refuses a total sent by the browser. Unknown fields are rejected.
- Each step belongs to one role. Only the project's client pays or changes the saved payment method; only the designer prices changes and captures, releases or refunds money.
- Once a quote is sent, database triggers freeze its lines, and an approval counts only for the exact content that was sent.

Code: [`src/payments/http.ts`](src/payments/http.ts) (`postPaymentsResponse`), [`src/pricing/http.ts`](src/pricing/http.ts), [`src/chat/http.ts`](src/chat/http.ts), [`drizzle/0002_quote_rules.sql`](drizzle/0002_quote_rules.sql) (`revisions_freeze`), [`drizzle/0008_pricing_review.sql`](drizzle/0008_pricing_review.sql) (`change_orders_immutable`)

Tests:
- [`src/payments/http.test.ts`](src/payments/http.test.ts): "routes designer steps without accepting any client-supplied amount"; "enforces the designer role for supplier records and money execution"
- [`src/pricing/http.test.ts`](src/pricing/http.test.ts): "issues only a saved review version, never accepts a client total or forged content hash"; "rejects unknown cases, injected approval/payment fields, and malformed amounts before writing"
- [`src/chat/http.test.ts`](src/chat/http.test.ts): "rejects other origins, unknown cases and client-supplied approval or prices"
- [`src/db/quotes.test.ts`](src/db/quotes.test.ts): "freezes lines once the revision is sent"; "accepts an approval only for the exact content that was sent"

The roles are demo identities, not logins; see [what this does not cover](#what-this-does-not-cover).

## 4. Opening another visitor's project

One visitor tries to read or act on another visitor's demo, for example through a shared link.

- Each browser gets its own workspace, named by a random id in an HttpOnly cookie. A shared link shows the document read-only. Payment steps and client confirmations check that the project belongs to the session asking.
- A client account opens only its own project.

Code: [`src/payments/binding.ts`](src/payments/binding.ts) (`lockConfirmedVersion`), [`src/approval/store.ts`](src/approval/store.ts) (`decide`), [`src/accounts/demo.ts`](src/accounts/demo.ts) (`canOpenProject`)

Tests:
- [`src/payments/binding.test.ts`](src/payments/binding.test.ts): "refuses a shared read-only link, another session and changed displayed content"
- [`src/approval/store.test.ts`](src/approval/store.test.ts): "keeps shared links read-only and rejects another session"
- [`src/payments/authorize.test.ts`](src/payments/authorize.test.ts): "lets neither a shared read-only link nor another session start or reconcile a checkout"
- [`src/payments/item-holds.test.ts`](src/payments/item-holds.test.ts): "refuses to reconcile another session's item hold"
- [`src/chat/http.test.ts`](src/chat/http.test.ts): "limits a chosen demo account to its own projects and role"

## 5. Replaying a request

A double click, a second window, a retried network call or a copied request tries to run the same step twice.

- Every payment step has a unique business key, and asking for it again returns the step already recorded. Each step sends PayPal one fixed `PayPal-Request-Id`, so a retry after a lost answer is the same request to PayPal, not a new one.
- Sending a quote, signing it and posting a chat message can be repeated without effect.

Code: [`src/db/schema.ts`](src/db/schema.ts) (`payment_operations.business_key`, `request_id`), [`src/payments/operations.ts`](src/payments/operations.ts) (`newOperationIds`)

Tests:
- [`src/payments/capture.test.ts`](src/payments/capture.test.ts): "returns the same operation when the same business event is requested twice, even at once"
- [`src/payments/void.test.ts`](src/payments/void.test.ts): "returns the same void when the release is requested again, even after it succeeded"
- [`src/opening/send.test.ts`](src/opening/send.test.ts): "changes nothing when the same send is retried, clicked twice or sent from a second window"
- [`src/opening/sign.test.ts`](src/opening/sign.test.ts): "takes undecided lines in a later signature and never decides a line twice"
- [`src/chat/store.test.ts`](src/chat/store.test.ts): "deduplicates a client UUID, rejects changed content and permits that UUID in another case"

## 6. Refunding twice, or more than was charged

A bug, a retry or a crafted request tries to refund the same money twice, refund more than was captured, or capture more than the client authorized.

- Database triggers refuse a refund larger than what is left of its capture, and a capture larger than its hold plus PayPal's over-capture allowance. Two captures at once are checked one at a time.
- Each PayPal refund id is stored once. A refund whose answer was lost is sent again with the same request id, so PayPal does not refund twice.
- The funding plan subtracts refunds already made before promising a new one.

Code: [`drizzle/0004_money_rules.sql`](drizzle/0004_money_rules.sql) (`refunds_within_capture`, `captures_within_authorization`), [`src/payments/refund.ts`](src/payments/refund.ts) (`executeRefund`), [`src/approval/funding.ts`](src/approval/funding.ts)

Tests:
- [`src/payments/refund-flow.test.ts`](src/payments/refund-flow.test.ts): "does not count a pending refund as returned and never sends it twice"
- [`src/payments/refund-recovery.test.ts`](src/payments/refund-recovery.test.ts): "sends the refund again with the same request id when PayPal has none for this step"
- [`src/db/money.test.ts`](src/db/money.test.ts): "refunds $240 of a $300 capture and refuses another $61"; "records each PayPal id once, so a retried write cannot double-count"; "checks two simultaneous captures one at a time, so together they cannot exceed the hold"
- [`src/approval/funding.test.ts`](src/approval/funding.test.ts): "subtracts completed prior refunds instead of promising the refund twice"

## 7. Forging a PayPal webhook

Someone posts a made-up PayPal event to Setti's webhook, hoping to mark a payment as done.

- An event counts only after PayPal's verify-webhook-signature API confirms it for this server's webhook id. Without a webhook id the endpoint stays closed, and if the token, the check or the network fails, the event is refused.
- Events are stored once by id and only confirm steps Setti already recorded. They never move money or change an amount.

Code: [`src/payments/webhook.ts`](src/payments/webhook.ts) (`paypalWebhookVerifier`, `recordWebhookEvent`), [`src/payments/http.ts`](src/payments/http.ts) (`postPayPalWebhookResponse`)

Tests:
- [`src/payments/webhook-verifier.test.ts`](src/payments/webhook-verifier.test.ts): "stays off without a webhook id and never runs against live PayPal"; "accepts an event only when PayPal verifies its signature for this webhook"; "refuses an event PayPal does not verify"; "refuses when the token, the check or the network fails, instead of letting the event through"
- [`src/payments/http.test.ts`](src/payments/http.test.ts): "stays closed without a webhook id, refuses unverified events, and keeps verified ones"
- [`src/payments/webhook.test.ts`](src/payments/webhook.test.ts): "keeps each event once, matched to the step it confirms, and shows it as confirmed by PayPal"

## 8. Writing from another site

A page on another site makes a visitor's browser post to Setti with the visitor's cookies.

- Every write must carry this app's exact `Origin` header; forwarded host headers are not trusted. Cookies are `SameSite=Lax`, and the private ones are HttpOnly.

Code: [`src/http/origin.ts`](src/http/origin.ts) (`isSameOriginRequest`)

Tests:
- [`src/http/origin.test.ts`](src/http/origin.test.ts): "does not accept forwarded hosts as proof of same origin"
- [`src/approval/http.test.ts`](src/approval/http.test.ts): "requires the exact same origin for writes, including an Origin header"
- [`src/payments/http.test.ts`](src/payments/http.test.ts): "rejects missing, opaque or forged payment origins before contacting PayPal"

## 9. Faking a return from PayPal

Someone opens Setti's PayPal return link by hand, or builds one from ids they have seen, to make a payment look approved.

- Each return link carries a signature made for one step and one route.
- Coming back from PayPal proves nothing by itself. Setti asks PayPal for the order and records only what PayPal reports.

Code: [`src/payments/callback-state.ts`](src/payments/callback-state.ts) (`validCallbackState`), [`src/payments/authorize.ts`](src/payments/authorize.ts) (`completeAuthorization`)

Tests:
- [`src/payments/callback-state.test.ts`](src/payments/callback-state.test.ts): "rejects missing, altered, cross-operation and cross-route state"
- [`src/payments/http.test.ts`](src/payments/http.test.ts): "refuses callbacks reconstructed from the public operation and order ids"
- [`src/payments/authorize.test.ts`](src/payments/authorize.test.ts): "treats the browser coming back as no proof: unapproved checkouts keep waiting and foreign tokens are ignored"

## What this does not cover

- **No real login.** The account picked in the sidebar is a demo identity kept in a cookie, and anyone can switch to the designer or a client. The role rules above decide what each role may do, not who the visitor really is. A real product needs real accounts.
- **Sandbox only.** [`src/config/paypalEnv.ts`](src/config/paypalEnv.ts) (`assertSandbox`) refuses any `PAYPAL_ENV` other than `sandbox` and any PayPal host other than `api-m.sandbox.paypal.com`, so no live money can move ([`src/config/paypalEnv.test.ts`](src/config/paypalEnv.test.ts): "rejects a live environment").
- **The AI evals are a sample.** The injection cases show the checks holding on the cases written for them, not against every possible attack. The protections that do not depend on the model are the ones above: it has no PayPal client, and the server checks its amounts.

## Reporting a problem

Please open an issue on this repository.
