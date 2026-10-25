# Setti

A project chat for independent interior designers that keeps every dollar in sync with what was agreed: when a client changes their mind after money has already moved, one approval turns into the right PayPal actions (release a hold, capture less, refund minus the restocking fee, charge the difference), each tracked on its own.

> **Status: hackathon build, PayPal Sandbox only.** AI change drafts, designer pricing review, client confirmation and the PayPal Sandbox payment steps (authorize, capture, release, refund) run end to end. See [what is real](#what-is-real) and the [Sandbox evidence](#sandbox-evidence).

## Try it

Open **`/try`**. Read the starting story, choose a role and select **Work through this change**. Opening the page only reads saved state; it does not create a payment. Each visitor gets a private workspace, and both roles share the same project.

To run it yourself (Node.js 22 or later, Docker):

```bash
cp .env.example .env.local   # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (Sandbox app) and ANTHROPIC_API_KEY
npm install
npm run db:up                # Postgres 17 in Docker
npm run db:migrate
npm run dev                  # then open http://localhost:3000/try
```

Starting the recommended **Maple Ave** walkthrough prepares this history:

- Emma, the client, has confirmed V2 with a lounge chair ($800) and a wool rug ($300).
- **$800 is held** on PayPal for the lounge chair. Nothing is charged until its supplier confirms the order.
- **$300 is captured** for the wool rug, after its supplier confirmed the order. PayPal's fee and the studio's net are read back from PayPal.

These starting payments are real PayPal Sandbox transactions. Setti approves them on the server with PayPal's documented Sandbox test card (`4012 0000 3333 0026`). A private run identity is saved before money is prepared. Each preparation stage is saved; after an interruption, continue the same run to check its original operations. **Start a separate Maple run** creates a new project without undoing the old transactions. **Previous Maple runs** lets the same visitor return to earlier records. The server allocates at most `SETTI_TRY_PER_HOUR` new Maple runs per hour (default 30).

**Start with first quote** opens Willow's sent V1 as Sofia without making a payment call. Choose the lines to approve, sign them, then pay for approved design services and save PayPal through its Sandbox wallet. This wallet approval is separate from Maple's prepared test-card transactions.

**Browse read-only examples** opens `/try/cases`, which needs no database or PayPal connection. Six fictional cases explain approval, holds, returns, service reductions, saved-method approval and recovery. A separate dated recording shows the real Sandbox proof from 22 October. Example records never become executable projects or payment IDs.

## Testing instructions

A walkthrough of one change that moves money three different ways. Every PayPal step runs against the Sandbox.

1. Open `/try`, keep **Emma · client** selected and select **Work through this change**. The preparation page reports the saved stages before opening the Maple chat.
2. Expand the guide's starting story and select **Inspect the prepared V2 payment records**. Under **Payments · V2**, inspect the chair's $800 hold and rug's $300 capture, including their PayPal references. Return to the chat.
3. Select **Use chair + rug message**, edit it if desired, then send. This asks the configured model for a new draft; selecting the example alone sends nothing.
4. Use the guide's **Continue as Jordan** hand-off to open the designer pricing review. The guide stays available on the pricing and change-order pages.
5. Select **Load sample supplier details** for this exact desk-and-rug scenario. Review the fictional desk's $1,100 price, SKU, zero tax and delivery, the unplaced chair order and the rug's $60 retained cost. The editable fields are filled, but confirmations and open checks remain yours. Resolve each issue with a review note, confirm the changed lines and check the terms. Select **Save pricing review**, then **Send to client as V3**.
6. Switch the account to **Emma Park**. In the chat, select **Review and confirm** on the V3 card. Type `Emma Park` as the signature, tick the acknowledgement and select **Confirm V3 · scope, prices and terms**. Only the client's account can confirm.
7. Under **Payments · V3**, run the three money steps. Switch to **Jordan Lee** for supplier records, releases, captures and refunds; switch to **Emma Park** for a PayPal checkout. Each money step asks you to confirm it first:
   - **Lounge chair → desk.** Select **Release $800.00 hold**, then **Confirm release**. Nothing was charged, so nothing is refunded.
   - **Desk.** Select **Authorize $1,100.00 with PayPal**. On the PayPal Sandbox page, choose to pay with a debit or credit card: use `4012 0000 3333 0026`, any future expiry date, any security code and any US address. Back in Setti, select **Record supplier confirmation (demo)**, **Save supplier confirmation**, then **Capture $1,100.00** and **Confirm capture**.
   - **Wool rug.** Select **Record supplier credit (demo)**, enter the $240 credit and select **Save supplier credit**, then **Refund $240.00** and **Confirm refund**. The $60 restocking fee stays with the supplier.
8. Back in the chat, select **Ask about payments** and send the message. The AI explains each item's money from the recorded PayPal results and shows the evidence.

Supplier confirmations are demo records that the designer types in; there is no supplier integration.

### Recover a payment that did not finish

On **Design services**, use **Check PayPal status** after a timeout or a lost checkout response. It recovers the original checkout with the same request id; it does not create a replacement payment. If approval is still needed, the project's client can select **Continue on PayPal**. After PayPal confirms the hold, Setti captures each service once; a remaining capture can be resumed with **Finish charging the design services**.

On **Approved items**, a saved PayPal hold can require the buyer again. The client sees **Continue on PayPal** for that same order, while either project participant can check its status. Leaving PayPal keeps an unresolved order available to check; it is not proof that money did not move. No replacement hold starts while its outcome is unresolved.

The server checks the selected demo account as well as the owning browser session. Only the project's client starts or leaves its checkout; designer-only payment and supplier actions are refused from client accounts. These are demo roles, not real identity authentication.

## What is real

| Part | Status |
|---|---|
| Authorize, capture, release (void) and refund | Real PayPal Sandbox calls through the official server SDK, with PayPal-Request-Id idempotency; an incomplete or lost answer is read back from PayPal |
| PayPal fees and the studio's net | Read from PayPal's seller breakdown, never estimated |
| Prepared Maple payments | Real Sandbox transactions created after the visitor starts preparation, approved with a Sandbox test card; preparation progress and operation references are saved |
| `/try/cases` examples | Read-only fictional teaching cases; the separately labelled 22 October evidence is a historical real Sandbox recording |
| Design-services checkout and saved PayPal | PayPal / Pay Later JS SDK buttons; one authorization split into per-service captures, with saved PayPal used for individual approved-item holds. Provider payer-action approval resumes the original order. |
| AI change drafts and money answers | Real model calls (needs `ANTHROPIC_API_KEY`); the first draft on a `/try` project is scripted |
| Designer pricing review, client change orders and confirmation | Real, saved in Postgres and frozen by content hash; the client signs as a demo identity without a login |
| Supplier order confirmations and credits | Demo records entered by the designer |
| Quote reports | Real AG Grid reports; the Maple and Willow quote contents are demo data |
| Not in this build | Hosted demo, procurement timeline, supplier integration and real user authentication |

## Sandbox evidence

`npm run sandbox:proof` runs one complete change through the app against the PayPal Sandbox, reads every PayPal resource back and writes the results to `evidence/` (see [probes/README.md](probes/README.md#app-level-proof)).

- [2026-10-22 · one change, three money actions](evidence/2026-10-22-mixed-change-lost-refund-answer/README.md): releases an $800 hold, authorizes and captures a $1,100 desk, and refunds a rug minus a $60 restocking fee. The first refund answer was deliberately discarded and recovered without a second refund. All 14 checks passed.

## Quote reports

Open **Quotes** in the sidebar, or `/quotes/maple` and `/quotes/willow`. The report uses **AG Grid Community** for sorting, category and room filtering, search, pagination and a full-quote CSV export. Select an item's **Details** to inspect specifications, price sources and return terms. Totals are calculated from integer-cent line items and stay unchanged when filtering. Approved versions are read-only.

Willow's V1 starts as the designer's draft. Signed in as Jordan Lee, open the Willow chat and select **+** → **Send quote V1**: the server freezes its own copy with a SHA-256 hash and posts it as a quote card. Clients see quotes under **Proposals** only after they are sent. Switch accounts from the avatar at the bottom left of the sidebar.

Signed in as Sofia Martinez, select **Review quote**. Select a line to approve or decline it (a decline needs a reason) or to ask about it; a question goes to the chat right away, tagged with the line. **Approve all remaining** fills in the rest, and one typed signature records every chosen line against the locked V1. Lines left undecided can be signed later; signed decisions cannot be changed. Only the approved lines become the baseline: AI drafts and new versions start from them, and nothing is charged by signing.

Back as Jordan Lee, **To resolve** on the quote lists declined lines with the client's reason and undecided lines with their questions. **Revise** puts a declined line on a designer draft, filled in from V1, and opens the pricing page to edit it by hand; AI drafts come from discussing the change with the client in the chat. **Drop** (or **Withdraw** for an undecided line) removes the line without a client signature, since it was never agreed. Undecided lines come along into the next version for the client's decision, so issuing it closes V1 without leaving anything behind. If the draft changes after you save a pricing review, the review is carried onto the new draft field by field: values only the draft changed are updated, values you edited stay, and where both changed the same value the pricing page asks which to keep. **Send to client** freezes the next version and posts it to the chat as a quote card, which marks V1 as replaced; the client confirms it from that card.

Willow has **28 lines: 22 products from four fictional supplier quotes and six simulated design services**. Each product's details name its supplier quote, price note and return terms. Suppliers, products and prices are invented; service rates, an 8.75% goods-only tax assumption and a single $99 delivery budget are test inputs, not supplier commitments or a location-specific tax calculation.

All project scopes, approvals and signatures are **demo data**. Maple's prices, return fees, $0 tax and delivery remain illustrative. Opening a quote report makes no payment calls.

## Code map

| Path | What it is |
|---|---|
| `src/try/` | Private visitors and saved runs; explicit, resumable Maple preparation through the normal business services; a payment-free Willow quote entry. |
| `src/demo/`, `src/ui/try/` | Labelled sample supplier materials, read-only cases, the entry page and role-aware guides derived from saved project state. |
| `src/chat/`, `src/ai/` | Project chat, AI change drafts and money answers grounded in the PayPal ledger. |
| `src/pricing/`, `src/approval/` | Designer pricing review, frozen client change orders, client confirmation and the funding plan. |
| `src/payments/` | PayPal Sandbox execution: authorize, capture, release, refund, supplier gates, fee read-back and recovery of lost answers. |
| `src/money/` | Pure money rules: what each change does to held or captured money, the over-capture allowance, the reauthorization window, refund promises, and a ledger snapshot. Amounts are integer cents. |
| `src/proof/` | The Sandbox proof runner behind `npm run sandbox:proof` and the evidence it writes. |
| `src/ui/` | The workspace, chat, pricing, change order, payments and quote report screens. |
| `src/quotes/` | Typed Maple and Willow V1 examples and integer-cent quote totals, with validation and tests. |
| `src/db/`, `drizzle/` | Postgres schema, migrations and database triggers that freeze sent versions and guard payment records. |
| `src/config/paypalEnv.ts` | Sandbox-only guard. Every PayPal client goes through it. |
| `probes/` | Scripts that record how the PayPal Sandbox really behaves (partial captures, over-capture, reauthorization, vault, Pay Later, void, test-card approval). See [probes/README.md](probes/README.md). |

## Run the database

The local database runs in Docker (Postgres 17 on port 5433, see `docker-compose.yml`). It creates a separate `setti_test` database for tests.

```bash
cp .env.example .env.local   # the default DATABASE_URL and TEST_DATABASE_URL match docker-compose.yml
npm run db:up                # start Postgres and wait until it is healthy
npm run db:migrate           # apply migrations to the development database
npm run db:down              # stop it
```

After changing `src/db/schema.ts`, run `npm run db:generate` to create a new migration.

## Run the tests

```bash
npm install
npm run db:up     # needed for the database tests
npm test          # vitest; migrates the test database first
npm run typecheck # tsc --noEmit (includes the probes)
```

Database tests run only when `TEST_DATABASE_URL` is set. Without it they are skipped and the rest of the suite still runs. GitHub Actions runs lint, typecheck, the full test suite against Postgres, and the build on every push; there, a missing `TEST_DATABASE_URL` fails the run instead of skipping the database tests.

## Run the probes

```bash
cp .env.example .env.local   # then fill in the sandbox app credentials
npx tsx probes/p1-standing-authorization.ts --label wallet-a
```

The probes print a buyer-approval link when a buyer step is needed and write their results to `probes/recorded/`.

## Sandbox only

This is a hackathon build. `PAYPAL_ENV` must be `sandbox`, and any base URL other than `api-m.sandbox.paypal.com` is rejected. No live PayPal account is ever used.

## Stack

Next.js (App Router) and TypeScript, Postgres with Drizzle, the PayPal Server SDK, and the Anthropic SDK. Deployment target: Render.

## License

[MIT](LICENSE)
