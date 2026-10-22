# Setti

A project chat for independent interior designers that keeps every dollar in sync with what was agreed: when a client changes their mind after money has already moved, one approval turns into the right PayPal actions (release a hold, capture less, refund minus the restocking fee, charge the difference), each tracked on its own.

> **Status: hackathon build, PayPal Sandbox only.** AI change drafts, designer pricing review, client confirmation and the PayPal Sandbox payment steps (authorize, capture, release, refund) run end to end. See [what is real](#what-is-real) and the [Sandbox evidence](#sandbox-evidence).

## Try it

Open **`/try`**. It starts a fresh demo workspace in your browser with money already on PayPal Sandbox, so you need no PayPal account.

To run it yourself (Node.js 22 or later, Docker):

```bash
cp .env.example .env.local   # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (Sandbox app) and ANTHROPIC_API_KEY
npm install
npm run db:up                # Postgres 17 in Docker
npm run db:migrate
npm run dev                  # then open http://localhost:3000/try
```

`/try` prepares the **Maple Ave** project in about fifteen seconds:

- Emma, the client, has confirmed V2 with a lounge chair ($800) and a wool rug ($300).
- **$800 is held** on PayPal for the lounge chair. Nothing is charged until its supplier confirms the order.
- **$300 is captured** for the wool rug, after its supplier confirmed the order. PayPal's fee and the studio's net are read back from PayPal.

These are real PayPal Sandbox transactions. Setti approves them on the server with PayPal's documented Sandbox test card (`4012 0000 3333 0026`), instead of a buyer on PayPal. Opening `/try` again brings you back to your project; **Start over** prepares a new one. The server prepares at most `SETTI_TRY_PER_HOUR` new projects per hour (default 30).

## Testing instructions

A three-minute walkthrough of one change that moves money three different ways. Every PayPal step runs against the Sandbox.

1. Open `/try` and wait until the **Maple Ave** chat opens.
2. Select **See them in Quote V2**. Under **Payments · V2**, check the $800 hold for the lounge chair and the $300 capture for the wool rug, with their PayPal IDs and the PayPal fee. Then select **Return to the project conversation**.
3. Speaking as **Emma Park** (the client), select **Try chair + rug example**, then send the message. The AI drafts the change: the chair becomes a light oak writing desk and the rug goes back.
4. Switch **Speaking as** to **Jordan Lee** (the designer). Open the current draft and select **Review pricing**.
5. Enter the desk's price (for example $1,100), set the rug's handling to *returned* with its restocking fee (for example $60), and confirm each line and open item. Select **Save pricing review**, then **Generate client change order**.
6. Open the new change order. As Emma, type her name as the signature, tick the acknowledgement and select **Confirm V3 · scope, prices and terms**.
7. Under **Payments · V3**, run the three money steps. Each step asks you to confirm it first:
   - **Lounge chair → desk.** Select **Release $800.00 hold**, then **Confirm release**. Nothing was charged, so nothing is refunded.
   - **Desk.** Select **Authorize $1,100.00 with PayPal**. On the PayPal Sandbox page, choose to pay with a debit or credit card: use `4012 0000 3333 0026`, any future expiry date, any security code and any US address. Back in Setti, select **Record supplier confirmation (demo)**, **Save supplier confirmation**, then **Capture $1,100.00** and **Confirm capture**.
   - **Wool rug.** Select **Record supplier credit (demo)**, enter the $240 credit and select **Save supplier credit**, then **Refund $240.00** and **Confirm refund**. The $60 restocking fee stays with the supplier.
8. Back in the chat, select **Ask about payments** and send the message. The AI explains each item's money from the recorded PayPal results and shows the evidence.

Supplier confirmations are demo records that the designer types in; there is no supplier integration.

## What is real

| Part | Status |
|---|---|
| Authorize, capture, release (void) and refund | Real PayPal Sandbox calls through the official server SDK, with PayPal-Request-Id idempotency; an incomplete or lost answer is read back from PayPal |
| PayPal fees and the studio's net | Read from PayPal's seller breakdown, never estimated |
| Money already on `/try` projects | Real Sandbox transactions, approved on the server with a Sandbox test card |
| AI change drafts and money answers | Real model calls (needs `ANTHROPIC_API_KEY`); the first draft on a `/try` project is scripted |
| Designer pricing review, client change orders and confirmation | Real, saved in Postgres and frozen by content hash; the client signs as a demo identity without a login |
| Supplier order confirmations and credits | Demo records entered by the designer |
| Quote reports | Real AG Grid reports; the Maple and Willow quote contents are demo data |
| Not in this build | Hosted demo, PayPal JS SDK buttons and Pay Later, saved payment methods (Vault), procurement timeline |

## Sandbox evidence

`npm run sandbox:proof` runs one complete change through the app against the PayPal Sandbox, reads every PayPal resource back and writes the results to `evidence/` (see [probes/README.md](probes/README.md#app-level-proof)).

- [2026-10-22 · one change, three money actions](evidence/2026-10-22-mixed-change-lost-refund-answer/README.md): releases an $800 hold, authorizes and captures a $1,100 desk, and refunds a rug minus a $60 restocking fee. The first refund answer was deliberately discarded and recovered without a second refund. All 14 checks passed.

## Quote reports

Open **Quotes** in the sidebar, or `/quotes/maple` and `/quotes/willow`. The report uses **AG Grid Community** for sorting, category and room filtering, search, pagination and a full-quote CSV export. Select an item's **Details** to inspect specifications, price sources and return terms. Totals are calculated from integer-cent line items and stay unchanged when filtering. Approved versions are read-only.

Willow has **28 lines: 22 products from four fictional supplier quotes and six simulated design services**. Each product's details name its supplier quote, price note and return terms. Suppliers, products and prices are invented; service rates, an 8.75% goods-only tax assumption and a single $99 delivery budget are test inputs, not supplier commitments or a location-specific tax calculation.

All project scopes, approvals and signatures are **demo data**. Maple's prices, return fees, $0 tax and delivery remain illustrative. Opening a quote report makes no payment calls.

## Code map

| Path | What it is |
|---|---|
| `src/try/` | The `/try` entry: seeds each visitor's Maple project through the app's own chat, pricing, approval and payment code. |
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
