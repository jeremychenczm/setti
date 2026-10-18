# Setti

A project chat for independent interior designers that keeps every dollar in sync with what was agreed: when a client changes their mind after money has already moved, one approval turns into the right PayPal actions (release a hold, capture less, refund minus the restocking fee, charge the difference), each tracked on its own.

> **Status: scaffolding.** The money rules engine and PayPal sandbox probes exist; the app UI, database and AI features are not built yet.

## Try it

_Placeholder: hosted demo link and no-signup entry points will go here._

## Testing instructions

_Placeholder: sandbox buyer credentials and a three-minute walkthrough will go here._

## What is here today

| Path | What it is |
|---|---|
| `src/money/` | Pure money rules: what each change does to held or captured money, the over-capture allowance, the reauthorization window, refund promises, and a ledger snapshot. Amounts are integer cents. |
| `src/config/paypalEnv.ts` | Sandbox-only guard. Every PayPal client goes through it. |
| `probes/` | Scripts that record how the PayPal sandbox really behaves (partial captures, over-capture, reauthorization, vault, Pay Later, void). See [probes/README.md](probes/README.md). |

## Run the tests

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (includes the probes)
```

## Run the probes

```bash
cp .env.example .env.local   # then fill in the sandbox app credentials
npx tsx probes/p1-standing-authorization.ts --label wallet-a
```

The probes print a buyer-approval link when a buyer step is needed and write their results to `probes/recorded/`.

## Sandbox only

This is a hackathon build. `PAYPAL_ENV` must be `sandbox`, and any base URL other than `api-m.sandbox.paypal.com` is rejected. No live PayPal account is ever used.

## Stack

Next.js (App Router) and TypeScript, Postgres with Drizzle, pg-boss for background jobs, the PayPal Server SDK, and the Anthropic SDK. Deployment target: Render.

## License

[MIT](LICENSE)
