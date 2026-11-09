# Setti

Design evolves through conversation. Setti's AI spots changes, drafts revised quotes, and links approvals to PayPal authorizations, captures, and refunds—freeing designers to focus on design.

**Live demo: <https://setti.onrender.com/try>** · PayPal Sandbox, so no real money moves

Independent interior designers settle the design with their clients in one project chat. When the design changes after money has already moved, one approval turns into the right PayPal step for each item: release a hold, capture less, refund minus what the supplier keeps, or hold the difference.

> **Status: hackathon build, PayPal Sandbox only.** AI change drafts, designer pricing review, client confirmation and the PayPal Sandbox payment steps (authorize, capture, release, refund) run end to end, and PayPal's webhooks confirm each step. See [what is real](#what-is-real), the [Sandbox evidence](#sandbox-evidence) and [AI quality](#ai-quality).

## Try it

Open **<https://setti.onrender.com/try>** in any browser; there is no account to create. Pick a side of the same private project and switch whenever you like:

- **I'm a designer** opens Jordan's studio. The Maple Ave living-and-dining project has an agreed V1, real Sandbox holds on its furniture and a 19-message discussion waiting for an AI revision.
- **I'm a client** opens the project as Emma, who reviews the revised quote, signs it and pays.

New preparation starts only after choosing a role; an already started setup continues in the background while the app is open.

**Sandbox test accounts.** These are PayPal Sandbox test values and move no real money. The payment page shows them too, with copy buttons.

- **PayPal** or **Pay Later**: log in to the PayPal window as `sb-jhaqe53477496@personal.example.com` with the password `W=3qAuJc`.
- **Card**: choose **Pay with the test card**. Setti approves PayPal's Sandbox Visa `4012 0000 3333 0026` on the server, so there is nothing to type.

When finished, select **End demo & reset** to clear this browser's demo identity and return to `/try`. Your next start gets a fresh private workspace with Maple's agreed V1 and sample discussion, without the previous run's revisions. Ending a demo releases its open holds on PayPal and keeps its project and PayPal Sandbox records as a read-only record; charged payments are not undone. Refreshing, switching roles, returning from PayPal or selecting **Demo home** keeps the current run available to continue.

To run it yourself (Node.js 22 or later, Docker):

```bash
cp .env.example .env.local   # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (Sandbox app) and ANTHROPIC_API_KEY
npm install
npm run db:up                # Postgres 17 in Docker
npm run db:migrate
npm run dev                  # then open http://localhost:3000/try
```

Starting the recommended **Maple Ave · living & dining** walkthrough prepares this history:

- Emma confirmed a six-line V1 agreement totaling $7,730: five furniture lines and $1,000 of unchanged design services. This is the actual signed V1; no artificial V2 is created.
- The quote and discussion open after local database preparation, before any PayPal call. A background runner continues the saved payment stages across pages and roles, with progress and recovery in the project guide.
- When setup completes, the sofa ($2,400), coffee table ($650), dining table ($1,400) and six dining chairs ($1,080) each have their own PayPal Sandbox hold. These goods have not been ordered. The sideboard's $1,200 Sandbox payment and the $1,000 V1 design-service fee are captured. V2 carries the paid service forward without charging it again. When Emma paid that fee she agreed to save the card for the project, so it appears as **Visa •••• 0026** and later holds need no PayPal window. It is PayPal's Sandbox test card, never the visitor's own PayPal wallet.
- Nineteen prepared human messages develop a more open living-and-dining layout: a compact sofa, two movable side tables, a fixed 110 cm round dining table, four chairs instead of six, and no sideboard. Fictional local supplier documents provide the prices and return terms. No new AI revision has been requested yet.

These starting payments are real PayPal Sandbox transactions. Setti approves them on the server with PayPal's documented Sandbox test card (`4012 0000 3333 0026`). A private run identity is saved before money is prepared. Each preparation stage is saved; after an interruption, continue the same run to check its original operations. **Start a separate Maple run** creates a new project without undoing the old transactions. **Previous Maple runs** lets the same visitor return to earlier records. The server allocates at most `SETTI_TRY_PER_HOUR` new Maple runs per hour (default 30).

**Start with first quote** opens Willow's sent V1 as Sofia without making a payment call. Choose the lines to approve, sign them, then pay for the approved design services. Choose a method from the list: **PayPal** or **Pay Later** opens in a window over the page (the Sandbox buyer login is shown below it, with copy buttons), or **Card** → **Pay with the test card** pays in one click with nothing to type. Leave **Save this payment method for the project** ticked: the same payment then holds each approved furniture item on it, one PayPal authorization per item, and the project chat opens with Sofia's message handing over to Jordan. Nothing is charged for an item until its supplier confirms it. The client can remove the saved method; PayPal deletes it first.

**Browse read-only examples** opens `/try/cases`, which needs no database or PayPal connection. Six fictional cases explain approval, holds, returns, service reductions, saved-method approval and recovery. A separate dated recording shows the real Sandbox proof from 22 October. Example records never become executable projects or payment IDs.

## Testing instructions

A discussion becomes one reviewed proposal, then item-specific payment steps. Every PayPal step runs against the Sandbox.

1. Open `/try` and select **I'm a designer**. The studio project collection opens immediately, without creating payments. Select **Start the live walkthrough** (or **Continue your live project**) on Maple Ave for real AI and Sandbox actions. The living-and-dining V1 and discussion open as Jordan; test-payment setup continues in the background.
2. Read the conversation and expand **Sample supplier documents**. You may continue the discussion before drafting. The designer discusses dimensions, use and preferences without supplying a precomputed answer to the AI.
3. Select **Prepare the revised quote**, edit the filled request if desired, then send. The configured model reads the whole conversation and supplied documents, identifies the five changes and selects the quoted products. Selecting the button alone sends nothing.
4. Inspect the draft and source links. For the supplied direction, source prices produce a $5,670 proposed total: $4,430 of revised goods, $1,000 of unchanged design services and $240 of retained sideboard cost. The $2,060 reduction is an agreement difference, not an amount to pay or refund now.
5. Open **Review pricing**. Select **Review the 5 changes** in the guide bar, or **Review** on a row, to open each change in the side drawer: the AI-selected product, quantity, source price, zero tax/delivery demo assumptions and old-item handling. For this demo, review checks start preselected; inspect them, untick anything that needs work, then select **Save pricing review**. Open-item notes are optional. Sending the version and payment actions stay disabled until the starting payment records are ready; the server enforces this too. Select **Send to Emma as V2** when ready; the project chat opens. The figures remain AI suggestions. Preselected review checks are a demo convenience, not evidence of actual measurement, supplier approval or payment. Once Emma confirms V2, its new furniture is held with her saved card right away; releases, smaller captures and refunds stay with the designer.
6. Switch to **Emma Park**, review V2, type `Emma Park` as the signature and confirm its scope, prices and terms. Agreement in the discussion is not formal client confirmation. The project chat then opens with Emma's message handing over to Jordan.
7. Inspect **Payments · V2**. Replaced goods release their original holds and need separate authorizations for their replacements; the three new items were held with **Visa •••• 0026** when Emma confirmed, without a PayPal window. **Hold all … new items** remains for any hold that did not go through. Reducing the chairs captures less of their hold; the sideboard's planned $960 refund waits for its separately recorded supplier credit. The guide follows each item's saved progress and the required participant. The unchanged $1,000 design fee is already paid under V1 and carries into V2; no new service payment is due.
8. Select **Ask about payments** in chat. Setti writes the answer itself: a conclusion, a line per item and short notes. Before it appears, the server checks every amount and payment status against the recorded PayPal results it cites and sends anything that does not match back for one correction. Ask where the evidence is to see those records and their PayPal links. End the demo when finished to begin a fresh run next time.

Runs of the older chair-and-rug walkthrough and of the living-and-dining story starting at V2 can still be opened from their saved records, but they are no longer prepared. New starts use V1. Dated Sandbox evidence remains historical evidence for its recorded scenario.

Supplier confirmations are demo records that the designer types in; there is no supplier integration.

### Prepared studio projects

**Projects** is a module in the same workspace sidebar as **Chats** and **Quotes**. `/studio` opens its project management panel: project status, client reviews, supplier follow-ups, budgets and next steps. Opening a project switches to its own **Chats** workspace at `/chats/[caseId]`, with the selected project in the conversation list and links to its quotes and payment progress. `/quotes/[caseId]` opens its records; older `/studio/[caseId]` links redirect to the chat. Refreshing or returning to the project preserves the selected conversation.

| Project | Business | Current stage | Materials and scope |
| --- | --- | --- | --- |
| Alder Bistro | Restaurant | Revised quote awaiting client | Floor tile, oak lining and acoustic panels |
| Juniper Coffee | Café | Approved; supplier confirmation pending | Solid-surface counter sheets, backsplash tile and pendants |
| Fieldwork Goods | Retail shop | Supplier return credit pending | Returned display panels, wall coating and modular shelves |
| Harbor Flat | Apartment | Settled with a partial refund | Flooring, underlay and a separately retained return cost |
| Northline Office | Small office | V2 declined; V1 remains approved | Carpet tile, glass panels and an optional privacy-film upgrade |
| Stillwater Salon | Hair salon | Quote still in draft | Washable coating, vinyl planks and worktop sheets |

The initial conversations, quotes, approvals and payment figures are **prepared histories**, not PayPal receipts. In-progress projects accept designer messages and genuine `@Setti` replies, saved privately per browser session and project in `studio_threads`. AI reads that project’s complete conversation and prepared context; it can advise and outline changes, but cannot issue quotes or execute financial actions in these histories. Failed requests can be retried without duplicating the human message or AI reply. Harbor Flat stays read only. Opening a project does not call a model. Maple remains the walkthrough for issuing revisions, client approval and real Sandbox transactions. Example prices explicitly use zero line tax and exclude installation unless a line says otherwise.

### Recover a payment that did not finish

On **Design services**, use **Check PayPal status** after a timeout or a lost checkout response. It recovers the original checkout with the same request id; it does not create a replacement payment. If approval is still needed, the project's client continues the same order in the PayPal window, or opens PayPal in the tab as a fallback. After PayPal confirms the hold, Setti captures each service once, then holds the approved furniture with the saved method; a remaining capture can be resumed with **Finish charging the design services**.

On **Approved items**, a hold with a saved method can require the buyer again. The client sees **Continue on PayPal** for that same order, while either project participant can check its status. Leaving PayPal keeps an unresolved order available to check; it is not proof that money did not move. No replacement hold starts while its outcome is unresolved.

The server checks the selected demo account as well as the owning browser session. Only the project's client starts or leaves its checkout; designer-only payment and supplier actions are refused from client accounts. These are demo roles, not real identity authentication.

## Payment statuses

On **Payments**, every item carries one status, worked out from that item's own PayPal records. The table follows the money, and says who moves it on.

| Money | Status | Next step | In the Maple walkthrough |
|---|---|---|---|
| **Not held yet** | `Authorization needed` | The client approves a hold through PayPal. `Additional authorization needed` means an existing hold covers only part of a larger new amount. | A V2 item whose hold did not go through |
| | `Payment required` | The client pays. Design services are charged rather than held. | Design services before they are paid |
| | `Awaiting client approval` | The client finishes the PayPal window they opened. | — |
| **Held, not charged** | `Awaiting supplier confirmation` | The designer records the supplier's order. Nothing is charged before that. | Sofa, coffee table, dining table and chairs at V1; after V2, the compact sofa, two side tables and round table |
| | `Ready for capture` | The designer charges the confirmed amount. Charging less releases the rest of the hold in the same step. | Chairs: $1,080 held for six, $720 charged for four, $360 released |
| | `Hold release required` | Rare: the item is fully paid while a hold is still open, so the designer releases it. | — |
| **Settled** | `Payment completed` | None. Exactly the confirmed amount was charged. | Sideboard at V1 ($1,200) and the design services |
| | `Hold released` | None. The money was never charged, so this is not a refund. | Original sofa, coffee table and dining table after V2 |
| | `Cancelled by the studio` | None. The designer's reason is posted in the chat; until PayPal confirms the release, the status reads `Cancelled · hold not released yet`. | Any uncharged hold the designer cancels, and every item still on hold when a demo ends |
| | `No payment required` | None. Nothing is due for the item under this version. | — |
| **Going back** | `Awaiting supplier credit` | The supplier credits the studio and the designer records it. The new version needs less than was charged. | Sideboard after V2: $1,200 charged, $240 kept under the supplier's return terms, $960 to refund |
| | `Refund required` | The designer sends the refund. | Sideboard once the credit is recorded |
| | `Refund completed` | None. The item's net payment matches its confirmed amount. | Sideboard: $960 refunded, $240 kept |
| **Being checked** | `… in progress`, `Capture pending at PayPal`, `Refund pending at PayPal`, `… outcome unknown` | Setti checks the existing operation with PayPal before anything is repeated. | Only after an interrupted call |

## Inbox, reminders and renewals

Setti keeps watching the holds after everyone has signed.

- **Jordan's Inbox** lists what needs the designer today, one line per item: a hold whose supplier order is still not recorded after three days, an item ready to charge, a hold close to PayPal's 29-day limit, a hold that failed, expired or could not be renewed, and a PayPal result Setti could not confirm.
- **Emma's Inbox** is her money: every hold, charge, release and refund, with its PayPal ID and time. Opening it reads the latest entries back from PayPal, and once PayPal's webhook for a step arrives, the entry says **Confirmed by PayPal**.
- **AI summaries** open both inboxes. The server checks every amount and status in a summary against the entries it cites, and shows no summary when one still fails after a rewrite.
- **A daily check** (Render cron, 15:00 UTC) reads back holds past their 29 days and renews a furniture hold still waiting for its supplier on day 25 with the client's saved payment method: a new hold first, then the old one released. Both people get a chat notice three days before.
- **Cancel a hold.** The designer can cancel the hold on any uncharged item, with a reason; PayPal releases the money and the reason is posted in the chat.
- **A demo left alone for a week ends.** The daily check cancels its items still on hold, releases them on PayPal and posts one notice; charged payments stay, and the project remains as a read-only record. **End demo & reset** does the same at once. A visit with the demo cookie counts as activity.
- **Skip ahead 3 days** in the walkthrough guide moves a simulated clock so the reminders appear. PayPal calls still happen now, in the Sandbox.
- **Limits.** Each visitor can ask the AI 40 times an hour (`SETTI_AI_PER_HOUR`), the whole demo 500 times a day (`SETTI_AI_PER_DAY`), and the server starts at most 30 new Maple runs an hour (`SETTI_TRY_PER_HOUR`).

## What is real

| Part | Status |
|---|---|
| Authorize, capture, release (void) and refund | Real PayPal Sandbox calls through the official server SDK, with PayPal-Request-Id idempotency; an incomplete or lost answer is read back from PayPal |
| PayPal fees and the studio's net | Read from PayPal's seller breakdown, never estimated |
| Prepared Maple payments | Real Sandbox transactions created after the visitor starts preparation, approved with a Sandbox test card; preparation progress and operation references are saved |
| `/try/cases` examples | Read-only fictional teaching cases; the separately labelled 22 October evidence is a historical real Sandbox recording |
| Payment methods | PayPal / Pay Later in a JS SDK window over the page, or PayPal's Sandbox test card approved on the server (labelled Demo). With the client's consent PayPal saves the PayPal account or card in its vault; later item holds use it merchant-initiated, with no window. Removing it deletes the token at PayPal, then the database refuses further holds with it. Design services are one authorization split into per-service captures. |
| AI change drafts and money answers | New `@Setti` requests use the configured model (needs `ANTHROPIC_API_KEY`), and every reply is the model's own. The server verifies amounts and payment statuses against the project's records before saving; a reply that still fails after one correction is replaced by the recorded facts, labelled as a system notice. The initial V1 and human discussion are prepared examples; the living-and-dining revision starts only when Jordan requests it. Source prices and integer-cent calculations are server owned. Recorded V1 payment evidence is available before the first change order. |
| Designer pricing review, client change orders and confirmation | Real, saved in Postgres and frozen by content hash; the client signs as a demo identity without a login |
| Supplier order confirmations and credits | Demo records entered by the designer |
| Quote reports | Real AG Grid reports; the Maple and Willow quote contents are demo data |
| PayPal webhooks | Each event is verified with PayPal's verify-webhook-signature, stored once and matched to its payment step. Webhooks confirm what Setti recorded; they never move money |
| Not in this build | Procurement timeline, supplier integration and real user authentication |

## AI quality

[`evals/`](evals/README.md) runs Setti's three AI features through the same code the app uses, on 50 fictional cases graded in code against answer keys written before any model answered. The cases lean hard: several changes in one thread, corrections and withdrawn decisions, quotes up to 295 lines (315,000 characters), and 11 cases with instructions injected into supplier pages, quote fields or the chat. With Claude Sonnet 5.5 at high effort on the Claude API, 5 November 2026:

| Feature | Runs | Passed | Passed on the first try |
|---|---|---|---|
| Change drafts | 65 | 65 | 62 of 64 model runs |
| Money answers | 14 | 14 | 14 |
| Client inbox summaries | 21 | 21 | 21 |

The first round found two prompt problems (a change a client said the designer had approved by phone was drafted, and totals were left out beside a one-item question), and the second found a server check that read "settled" as a payment word. All three were fixed and measured again; [evals/README.md](evals/README.md#results) has both rounds, what changed and the limits of a set this size. The model answers behind these numbers are committed in [`evals/recorded/`](evals/recorded), and CI replays them through the same checks on every push without calling the model (`npm run eval:replay`).

## Security

[SECURITY.md](SECURITY.md) lists nine ways someone could try to move money or make Setti misreport it, from prompt injection to forged PayPal webhooks, with the code that stops each one and the tests that show it.

## Sandbox evidence

`npm run sandbox:proof` runs one complete change through the app against the PayPal Sandbox, reads every PayPal resource back and writes the results to `evidence/` (see [probes/README.md](probes/README.md#app-level-proof)).

- [2026-10-22 · one change, three money actions](evidence/2026-10-22-mixed-change-lost-refund-answer/README.md): releases an $800 hold, authorizes and captures a $1,100 desk, and refunds a rug minus a $60 restocking fee. The first refund answer was deliberately discarded and recovered without a second refund. All 14 checks passed.

## Quote reports

Open **Quotes** in the sidebar, or `/quotes/maple` and `/quotes/willow`. The report uses **AG Grid Community** for sorting, category and room filtering, search, pagination and a full-quote CSV export. Select an item's **Details** to inspect specifications, price sources and return terms. Totals are calculated from integer-cent line items and stay unchanged when filtering. Approved versions are read-only.

Willow's V1 starts as the designer's draft. Signed in as Jordan Lee, open the Willow chat and select **+** → **Send quote V1**: the server freezes its own copy with a SHA-256 hash and posts it as a quote card. Clients see quotes under **Proposals** only after they are sent. Switch accounts from the avatar at the bottom left of the sidebar.

Signed in as Sofia Martinez, select **Review quote**. Select a line to approve or decline it (a decline needs a reason) or to ask about it; a question goes to the chat right away, tagged with the line. Every undecided line starts ticked: **Approve ticked** approves them together, and **Review & sign** records one typed signature for every chosen line against the locked V1. Lines left undecided can be signed later; signed decisions cannot be changed. Only the approved lines become the baseline: AI drafts and new versions start from them, and nothing is charged by signing.

Back as Jordan Lee, **To resolve** on the quote lists declined lines with the client's reason and undecided lines with their questions. **Revise** puts a declined line on a designer draft, filled in from V1, and opens the pricing page to edit it by hand; AI drafts come from discussing the change with the client in the chat. **Drop** (or **Withdraw** for an undecided line) removes the line without a client signature, since it was never agreed. Undecided lines come along into the next version for the client's decision, so issuing it closes V1 without leaving anything behind. If the draft changes after you save a pricing review, the review is carried onto the new draft field by field: values only the draft changed are updated, values you edited stay, and where both changed the same value the pricing page asks which to keep. **Send to Sofia as V2** freezes the next version and posts it to the chat as a quote card, which marks V1 as replaced; the client confirms it from that card.

Willow has **26 lines: 20 products (furniture, lighting and supply-only finish materials: flooring, tile, paint, downlights and built-in shelving) from seven fictional supplier quotes, and six simulated design services**. Installation is by the client's contractor and is not in the quote. Each product's details name its supplier quote, price note and return terms. Suppliers, products and prices are invented; service rates, an 8.75% goods-only tax assumption and a single $99 delivery budget are test inputs, not supplier commitments or a location-specific tax calculation.

All project scopes, approvals and signatures are **demo data**. Maple's prices, return fees, $0 tax and delivery remain illustrative. Opening a quote report makes no payment calls.

## Code map

| Path | What it is |
|---|---|
| `src/try/` | Private visitors and saved runs; explicit, resumable Maple preparation through the normal business services; a payment-free Willow quote entry. |
| `src/demo/`, `src/ui/try/` | Labelled sample supplier materials, read-only cases, the entry page and role-aware guides derived from saved project state. |
| `src/chat/`, `src/ai/` | Project chat, AI change drafts and money answers grounded in the PayPal ledger. |
| `evals/` | AI evals for change drafts, money answers and inbox summaries, run through the app's own entry points. See [evals/README.md](evals/README.md). |
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

## Photo credits

The `/try` hero photo (`public/images/try-living-room.webp`) is by Collov Home Design on [Unsplash](https://unsplash.com/photos/living-room-with-brown-sofa-and-glass-window-4_jQL4JCS98), used under the [Unsplash License](https://unsplash.com/license).
