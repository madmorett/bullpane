# Launch checklist and costs

Written 2026-09-06. Prices change; treat the numbers as an order of magnitude, and
re-check before paying. All amounts in USD unless noted.

---

## Part 1 — Accounts you need

### Must have before selling anything

| # | What | Why | Cost |
|---|---|---|---|
| 1 | **Domain** (e.g. `bullpane.com`) | Docs site, checkout links, license emails, the demo. Buy the `.com` if free; also grab `.dev` if cheap. | $10–15/yr |
| 2 | **GitHub organization** | The repo should not live under your personal handle if you want it to look like a product. Free plan gives unlimited public and private repos. | $0 |
| 3 | **Email on your domain** | `matheus@yourdomain.com`, plus `support@`. Sending license keys from Gmail looks amateur. Google Workspace or Zoho or Fastmail. | $0–7/user/mo |
| 4 | **Payment processor** | To take the $49. See Part 2. | ~5% + $0.50/sale |
| 5 | **Company/tax setup** | You are in Brazil selling software abroad. Talk to your accountant about whether this goes through an existing CNPJ, MEI, or something new. **This is the item that can actually bite you.** | ask your accountant |

### Need soon after

| # | What | Why | Cost |
|---|---|---|---|
| 6 | **Docker Hub account** | Publish `yourorg/bullpane:latest`. Free tier is fine; GitHub Container Registry (ghcr.io) is a free alternative already tied to your org. | $0 (or $9/mo Pro) |
| 7 | **A host for the live demo** | The playground is the whole sales pitch. Small VPS: Hetzner, DigitalOcean, Fly.io, Railway. Needs ~2 GB RAM for app + MySQL + Redis + simulator. | $5–12/mo |
| 8 | **Docs / landing page** | Can be GitHub Pages (free) or the same VPS. | $0 |
| 9 | **Analytics** | Plausible, Umami self-hosted, or nothing at first. | $0–9/mo |
| 10 | **Error tracking** | Sentry free tier, for the demo instance. | $0 |

### Probably NOT needed

- **npmjs account** — only if you publish a library. You are shipping a Docker image and a
  repo, not an npm package. Skip it. (Reserve the name `bullpane` for $0 if you
  are worried about squatting, but do not build a release flow around it.)
- **Apple/Google developer accounts** — no mobile app.
- **Code signing certificate** — no desktop binary.
- **Trademark** — not on day one. Revisit if it sells.

### The one legal thing worth doing properly

Read the **BullMQ Pro licence** before you charge money for a tool that advertises Pro
support. You are not redistributing their code (the dashboard reads Redis keys, it does not
bundle `@taskforcesh/bullmq-pro`), which is almost certainly fine, but check that you are
allowed to use "BullMQ" in your product name. Taskforce.sh owns BullMQ and sells a competing
dashboard. Consider a name that does not lead with their trademark if you want zero risk.
This is the single highest-value hour of lawyering on this list.

---

## Part 2 — Payment: pick one

You are selling a $49 one-time digital licence, worldwide, from Brazil. The choice is
between doing tax compliance yourself (Stripe) or paying someone to be the seller of
record (Lemon Squeezy, Paddle, Polar, Gumroad).

| Option | Fee | What you get |
|---|---|---|
| **Lemon Squeezy** | ~5% + $0.50, +1.5% international | Merchant of record: they handle VAT/sales tax worldwide, invoices, refunds, EU compliance. Built-in licence-key generation and a licence API. Simplest for a solo founder. |
| **Paddle** | ~5% + $0.50 (+2–3% FX) | Same model, more enterprise features, heavier onboarding/approval. |
| **Polar** | ~4% + $0.40 | Newer, developer-focused, merchant of record. |
| **Stripe** | 2.9% + $0.30 | Cheapest per transaction, but **you** are responsible for VAT/sales tax in every jurisdiction. Not worth it at low volume. |
| **Gumroad** | ~10% | Simplest, most expensive. Fine to validate demand in week one. |

**Recommendation: Lemon Squeezy.** At $49 the fee is roughly $3.20/sale, and it removes the
entire international-tax problem, which is exactly the problem you do not want as a solo
founder in Brazil. You also get licence keys as a feature, though note: your product already
does **offline Ed25519 licence keys**, so you can either
(a) let the processor generate keys and ignore your own scheme, or
(b) keep your scheme and use a webhook on `order_created` to sign and email a key.
(b) is better — it keeps validation offline and phone-home-free, which is a selling point.

Sources:
- [Paddle vs Stripe vs Lemon Squeezy (2026)](https://www.artisangrowthstrategies.com/blog/paddle-vs-stripe-vs-lemon-squeezy-2026)
- [Merchant of Record Pricing 2026](https://fungies.io/merchant-of-record-pricing-guide-2026/)
- [Stripe vs Paddle vs Lemon Squeezy vs Gumroad fees](https://www.globalsolo.global/blog/stripe-vs-paddle-vs-lemon-squeezy-2026)

---

## Part 3 — What it costs to run

### Minimum viable launch

| Item | Monthly | Yearly |
|---|---|---|
| Domain | ~$1 | $12 |
| Email (Zoho Mail 1 user, or Google Workspace) | $0–7 | $0–84 |
| Demo VPS (Hetzner CX22 ~2 vCPU/4 GB, or DO $6 droplet) | $5–12 | $60–144 |
| GitHub org (Free plan) | $0 | $0 |
| Docker Hub / ghcr.io | $0 | $0 |
| Payment processor (fixed) | $0 | $0 |
| **Total fixed** | **~$6–20** | **~$72–240** |

Per sale you also lose ~$3.20 to fees at $49 (Lemon Squeezy, roughly 6.5% all-in).

### If it grows

Add later, not now: paid analytics (~$9/mo), a bigger demo box if it gets hugged (~$25/mo),
Sentry paid (~$26/mo), an accountant's time (varies, and the real cost of doing this properly
from Brazil).

### Break-even

At ~$20/mo fixed cost and ~$45.80 net per sale:

| Sales/month | Net revenue | Profit |
|---|---|---|
| 1 | $45.80 | +$26 |
| 5 | $229 | +$209 |
| 20 | $916 | +$896 |
| 100 | $4,580 | +$4,560 |

**One sale a month covers the infrastructure.** The real cost of this product is your time,
not the hosting.

---

## Part 4 — On the $49 price

Some things to weigh, not a recommendation to change it:

- **$49 one-time is cheap** for a tool a company installs to watch production queues. Your own
  employer processes 10M jobs/day; a dashboard that prevents one incident is worth far more
  than $49 to that company.
- **One-time means no recurring revenue.** You will keep shipping fixes and BullMQ compatibility
  updates forever for a single payment. The usual fix is what Metabase/Sidekiq do: charge
  per year, or one-time-with-one-year-of-updates (the JetBrains model — the licence keeps
  working forever, but updates past 12 months need a renewal). Your Ed25519 payload already
  has `expiresAt`, so this is supported today.
- **Consider $49 personal / $199 company**, or per-instance pricing. Companies do not blink at
  $199; individuals do.
- **Whatever you pick, honour $49 for early buyers forever.** It buys goodwill and testimonials
  when you have neither.

The comparison that matters: Taskforce charges monthly per connection. Being "buy it once,
self-host it, own it" is your actual differentiator, so price it like a product, not like a
donation.

---

## Part 5 — Order of operations

1. **Run it at your company in read-only mode** (`docs/PRODUCTION-TRIAL.md`). This is free,
   proves the thing works at 10M jobs/day, and gives you the real screenshots and the real
   BullMQ Pro validation the project has not had yet.
2. Fix whatever that trial finds. Especially the **Pro group key layout**, which is inferred.
3. Buy the domain. Create the GitHub org. Push the repo (public core).
4. Stand up the live demo. This is the single highest-leverage marketing asset.
5. Only then set up payment and the paid tier.
6. Launch where BullMQ users are: the BullMQ GitHub discussions, r/node, Hacker News "Show HN",
   dev.to, LinkedIn. Lead with the demo link and the performance story (Lua, no KEYS,
   read-only mode), not the feature list.

Do not spend a cent on steps 3–5 until step 1 and 2 are done.
