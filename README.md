# StorePilot AI

A human-governed operating system for a single Shopify dropshipping store. Research a product, choose a supplier, build the store, generate creative, then monitor and improve it — with every external write gated behind an approval you click.

All seven phases are built. 54 automated checks pass; `tsc --noEmit` and `next build` are clean across 22 routes.

## The rule the whole system is built around

**No AI output can cause an external action.** An agent returns a JSON proposal validated against a Zod schema. That proposal becomes an `approval_requests` row showing the exact payload. You approve it. Only then does the action executor run — once, idempotently, with the kill switch re-checked immediately before the write.

A prompt injection hidden in a supplier listing or a customer review can therefore corrupt a draft that you then reject. It cannot move money, change a price, or write to Shopify. That property is architectural, not a filter that might miss something.

## Setup

**Deploying to Vercel with no terminal? Read `DEPLOY.md` instead.** It uses `supabase-setup.sql` and a first-run password screen, so you never install Node.

To run it locally you need Node 20+ and a Postgres database (Neon or Supabase free tier is fine).

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

1. `DATABASE_URL` — your connection string.
2. `ADMIN_EMAIL` — the email you log in with.
3. `ADMIN_PASSWORD_HASH` — **optional**. Leave it out and the app shows a one-time password setup screen on first visit. If you do set it, run `npm run hash -- "your-password"` and paste the line **exactly as printed**: the `\$` escaping matters, because Next expands `$VAR` inside `.env` and an unescaped bcrypt hash silently truncates.
4. `SESSION_SECRET` — `openssl rand -base64 48`. Also used as the bearer token for the cron endpoint.
5. `ANTHROPIC_API_KEY` — required for every AI feature.

Leave the Shopify variables blank until you reach the Store Builder tab.

```bash
npm run db:push    # create the tables
npm run seed       # store row, insert-only audit trigger, default settings
npm run verify     # 54 acceptance checks — all must pass
npm run dev        # http://localhost:3000
```

## The five tabs

### 1 · Research

A brief plus whatever evidence you have becomes a ranked list of scored opportunities.

Evidence intake takes competitor and supplier URLs, pasted reviews, pasted competitor data, CSV uploads and free notes. Everything you paste is wrapped in a delimited untrusted block before it reaches Claude, so text inside it is data and never instruction.

Each candidate comes back with: opportunity score 0–100, summary, customer problem, target buyer, why it may sell, competitor price range, estimated product cost, shipping cost, landed cost, suggested price, gross margin, break-even CAC, bundle ideas, objections, quality and return risks, shipping risks, compliance and trademark notes, saturation risk, content/UGC potential, supplier availability, evidence sources, an explicit verified-versus-estimated statement, and a recommendation of pursue / research more / avoid.

**The economics are computed in `src/lib/scoring.ts`, not by the model.** Claude supplies cost and price estimates plus 0–100 judgements; margins, break-even CAC and the final score are arithmetic. A model that computes a margin will occasionally compute it wrong and be confident about it.

**Evidence quality caps the score.** A candidate backed by nothing but a niche name cannot score above about 50, however enthusiastic the analysis. This is the single most important line in the scoring file.

### 2 · Product & Supplier Decision

Side-by-side comparison across 20 tracked attributes, with a weighted 0–100 supplier score (quality 25, shipping 20, cost 20, tracking 10, inventory 10, communication 5, branding 5, integration 5 — editable in Settings, must total 100).

Every value carries how you know it: verified, supplier-provided, estimated, or missing. Blank fields stay blank — the score reports which criteria are missing and drops its confidence rather than assuming a value. An AI review adds judgement, gaps and the questions to ask each supplier, and proposes a primary and a backup.

**The gate:** *Approve Product for Store Build*. You set the primary supplier, backup, target price, delivery estimate, and — the important part — the **claims allowed** and **claims prohibited** lists. Those lists are the complete set of facts Store Builder and Creative Studio may assert. Everything else gets flagged as unsupported. An empty allowed list is rejected, because copy that can state nothing about the product is not a useful deliverable.

Nothing exists in Shopify until after this approval, and the approval itself is recorded through the same queue and audit chain as every other change.

### 3 · Store Builder

24 draft sections: brand identity (names, positioning, voice, palette, typography, logo and image prompts), homepage, product page, bundles, cart upsells, comparison, benefits, how it works, specifications, FAQ, about, contact, four policies, order tracking plan, SEO metadata, email opt-in, trust sections, mobile-first structure, photography shot list, UGC shot list, and a launch checklist.

The product page is the advanced one: headline, value proposition, offer and bundle logic, benefits each naming what backs them, media placement plan, a social-proof area designed to work with zero reviews, FAQ, shipping expectation, returns explanation, a comparison section included only when the approved claims support it, objection handling, sticky add-to-cart, frequently-bought-together logic, post-purchase upsell, and the mobile layout.

Every draft is scanned twice: the deterministic prohibited-claims scanner over the final text, and a claim check against your approved list. A blocking finding disables the push button entirely.

**The Shopify layer.** Reads cover orders, products, inventory, fulfilments, refunds and shop info; webhooks cover 15 topics with HMAC verification. Writes cover product drafts, product updates, pages, collections, navigation menus, SEO metafields, discount drafts, and theme assets. Every write shows you the rendered HTML or exact payload as a before/after diff before it happens, and every write is additionally gated by the `shopifyWrites` feature flag, which is off by default.

Products and pages are created **unpublished**, so an approved push that turns out wrong is invisible to customers while you delete it.

### 4 · Creative Studio

22 generators producing roughly 150 assets per full run: 15 video hooks, 15 static hooks, 15 headlines, 15 primary texts, 10 UGC scripts, 5 demo, 5 problem-solution, 5 founder-story, 5 objection-handling angles, 5 retargeting concepts, 3 landing angles, 3 offer tests, 3 ad test plans, four email sequences (welcome, abandoned cart, post-purchase, review request), creator outreach, creator briefs, photography briefs, video shot lists, and a Claude prompt pack for ad images and video storyboards.

Each ad concept carries target customer, platform, funnel stage, hook, core message, offer, CTA, script, visual instructions, text overlays, creator instructions, the claims it used, a compliance warning, the test metric, and a suggested budget sized against your daily ad spend.

Every asset runs through the same deterministic scanner. Blocked assets cannot be approved — the button is disabled and the server action refuses. The scanner covers medical and health claims, outcome guarantees, false scarcity, fake discounts, invented testimonials and customer counts, unsupported comparatives, unsubstantiated environmental claims, and delivery promises other than your approved estimate.

The founder-story generator is explicitly instructed that the brand is new: no invented factory, team, decade of experience, or personal medical history.

### 5 · Command Center

Deterministic metrics first, AI interpretation second, approval third.

Tracked: revenue, orders, conversion rate, AOV, gross margin, contribution profit, refund rate, product cost changes, supplier stock, shipping performance, missing tracking, delayed orders, customer complaint themes, review sentiment, inventory risk, ad spend, CAC, ROAS, break-even CAC, and performance by SKU.

`src/lib/detect.ts` computes signals with no model involvement: conversion below floor, negative contribution, CAC above break-even, refund rate high, margin below target, SKU revenue-positive but contribution-negative, orders unfulfilled past threshold, fulfilments shipped without tracking, low inventory, supplier cost increases above 8%, repeated customer objections, and costs that are mostly estimated.

Only signals reach the analyst, never raw metrics. A quiet week costs no tokens at all.

Recommendations carry evidence quoting the actual figures, a financial impact range in cents or an honest null, a calibrated confidence, a risk level, the exact Shopify change if there is one, whether approval is required, a rollback plan, and what data is missing before the decision is responsibly made. *Send to approval queue* turns one into an approval request carrying its payload.

Since the Admin API does not expose sessions, conversion rate needs a session count — entered on this tab, alongside ad spend, costs and customer signals. Customer text is PII-redacted before it is stored, so raw text can never reach a prompt.

### Store stack

Evaluates 13 app categories and recommends only what the store actually needs, with the category left empty and the reason recorded when it does not. Each recommendation shows why it is needed, whether it is essential before launch, free plan availability, estimated monthly price, data permissions, setup steps, risks, alternatives, and the listing link. Approving records the decision; **installation is always manual and stays that way.**

## What requires your approval

Connecting or installing any paid app · buying a domain · spending money · selecting or changing a supplier · importing or publishing a product · changing a product price · publishing product-page changes · changing theme settings · creating a discount · sending any customer email or SMS · issuing a refund, replacement, credit or discount · launching or changing ads · increasing ad budgets · publishing the store · **any external API write at all**.

## What runs automatically

Gathering and organising data · scoring products and suppliers · computing unit economics · detecting anomalies · raising internal alerts · drafting store content, ad creative, product-page improvements and email flows · creating approval requests · producing reports and recommendations.

## Running the checks

```bash
npm run verify
```

54 assertions across unit economics, opportunity scoring, supplier scoring, the compliance scanner (8 adversarial copy samples), PII redaction, draft rendering and HTML escaping, the approval pipeline, the kill switch, the audit trail, and store scoping. It exercises the real pipeline, not a mock of it.

The load-bearing ones:

| Assertion | Why it matters |
|---|---|
| Approved action executes; rejected action never does | The queue is the only path to a write |
| Duplicate execution is suppressed | A double-click cannot produce two writes |
| Write is blocked while the kill switch is on, and queued rather than discarded | Stopping the AI never loses work |
| Settings still readable with the switch on | Stopping the AI never means going blind |
| One correlation id retrieves the whole chain | Any action is reconstructible end to end |
| `audit_logs` rejects UPDATE and DELETE | History cannot be rewritten, by this app or by anything that compromises it |
| Thin evidence caps the opportunity score | Enthusiasm cannot outrank sourcing |
| Scanner blocks all 6 deceptive copy patterns and passes clean copy | The compliance gate is real, not decorative |
| Rendering escapes injected markup | Draft content cannot inject script into your storefront |

Then, in the browser: change a setting and watch the audit log record before *and* after state; create a test approval on `/approvals` and approve it; engage the kill switch, approve another, and watch the execution come back `blocked_by_kill_switch` while the decision still records.

## Ongoing sync

Point a scheduler at the cron endpoint hourly:

```
GET /api/cron/sync
Authorization: Bearer <SESSION_SECRET>
```

It syncs Shopify, rebuilds daily metrics and runs detection. It deliberately does **not** run the analyst: interpreting signals costs tokens, so that stays a button you press.

On Vercel, add to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/sync", "schedule": "0 * * * *" }] }
```

## Layout

```
src/
  app/
    (app)/            dashboard · research · suppliers · store-builder · creative
                      command-center · stack · approvals · audit · settings
    api/auth/         login, logout
    api/health/       liveness + database check
    api/webhooks/     Shopify receiver: HMAC-verified, raw-first, idempotent
    api/cron/sync/    scheduled sync, metrics rebuild, detection
  lib/
    db/               schema (34 tables), connection, store-scoped accessor
    auth/             JWT cookie session, bcrypt
    ai/claude.ts      the only path to Claude: Zod-validated, repaired once, costed, budget-broken
    ai/schemas.ts     every structured output the system will accept
    ai/redact.ts      PII tokenisation, rehydration, untrusted-content fencing
    agents/           research · supplier · store-builder · creative · analyst
    approvals.ts      propose → decide → execute, idempotent, kill-switch checked
    executors.ts      every external write the system can perform, in one file
    shopify.ts        Admin REST + GraphQL, retry, HMAC, webhook registration
    scoring.ts        unit economics, supplier score, opportunity score
    compliance.ts     deterministic prohibited-claims scanner
    detect.ts         deterministic signal detection
    metrics.ts        sync, contribution profit, rollups, read models
    render-draft.ts   draft → the exact HTML that would be sent to Shopify
    audit.ts settings.ts killswitch.ts flags.ts logger.ts ratelimit.ts env.ts
scripts/
  seed.ts             store row, audit immutability trigger, default settings
  hash-password.ts    generates ADMIN_PASSWORD_HASH
  verify.ts           54-check acceptance suite
  verify-phase1.ts    the five database-level safety assertions
```

## Cost control

Two tiers: Haiku-class for classification and list generation, Sonnet-class for drafting and analysis. A monthly budget with a circuit breaker that **degrades to rules-only and never falls open into acting without validation**. Per-run token and cost accounting on every call, visible on the dashboard. Rule gating means a quiet week invokes no model at all.

Set the application budget in Settings and a higher limit on the API key itself in the Anthropic console, so the application's breaker always trips first.

Rough expectations: a research run is a few cents. A full store draft is about 20 calls. A full creative run is about 22 calls producing ~150 assets — call it a dollar or two. Ongoing monitoring is pennies per week.

## Assumptions in force

Set during onboarding, editable in Settings, used to seed every research run:

| | |
|---|---|
| Market | United States |
| Niche | High-ticket home, wellness and outdoor equipment |
| Target price | $349 |
| Max landed cost | $110 |
| Min gross margin | 65% |
| Max delivery | 12 days |
| Launch budget | $2,500 |
| Daily ad test budget | $70 |
| Avoided | ingestibles, medical devices, certified electricals, baby safety, vape, weapons, trademark lookalikes |

Break-even CAC at those numbers is about $228, so a $70/day test needs roughly one sale every three days to stay viable. That is the bar the Research tab scores candidates against.

## Honest limitations

- **Costs are only as good as what you enter.** Contribution profit on estimated supplier costs is directional, and the dashboard says so on every affected row rather than presenting a guess as a fact.
- **No supplier API.** Supplier data is what you enter. Cost drift is detected from your own cost records, not from a live feed.
- **No tracking provider.** Shipping exceptions are detected from Shopify fulfilment state — unfulfilled past threshold, shipped with no tracking number. Carrier-level stalls need a tracking provider such as 17TRACK; the detector is structured to take one.
- **Sessions are entered manually.** The Admin API does not expose them.
- **Attribution is blended**, not platform-reported. Platform ROAS and blended contribution profit will disagree; the blended figure is the one shown.
- **Theme asset writes are the highest-risk capability here.** They are behind the write flag, go through approval like everything else, and are worth testing on a duplicated theme first.
- **Policy drafts are drafts.** The terms and privacy pages flag what needs a lawyer rather than pretending they do not.

## Deploy

Vercel plus Neon or Supabase works out of the box. Set every `.env` variable in the project settings, run `npm run db:push` and `npm run seed` against the production database once, then register webhooks from the Store Builder tab with `APP_URL` pointing at the deployed URL.

Use a Shopify **development store** first. Turn on the `shopifyWrites` flag only once you have watched a push land where you expected it.
