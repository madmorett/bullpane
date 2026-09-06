import { Queue, Worker, UnrecoverableError } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };

function chargePayload() {
  return {
    chargeId: R.id("ch"),
    tenantId: R.tenant(),
    customer: { id: R.id("cus"), email: R.email(), name: R.fullName() },
    amount: R.amountCents(),
    currency: R.currency(),
    method: R.pick(["card", "card", "card", "pix", "boleto", "apple_pay"]),
    card: { brand: R.pick(["visa", "mastercard", "amex", "elo"]), last4: String(R.int(1000, 9999)) },
    idempotencyKey: R.uuid(),
    ip: R.ipv4(),
    requestedAt: new Date().toISOString(),
  };
}

/**
 * payments.charge          steady ~2 jobs/s, ~4% failures, 200-1500 ms
 * payments.refund          slow trickle, occasional jobs that exhaust 3 attempts
 * payments.webhook-dispatch bursty (100-300 every 30 s), ~10% HTTP 502; worker
 *                          goes "dead" for 60 s every ~4 min so alerts have
 *                          something to fire on.
 */
export async function startPayments(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const jobOpts = ctx.defaultJobOptions;

  // ---- payments.charge -------------------------------------------------
  const charge = ctx.register(new Queue("payments.charge", { connection, prefix, defaultJobOptions: jobOpts }));
  ctx.loop("charge.produce", ctx.every(500), async () => {
    await charge.add("charge", chargePayload(), {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      priority: R.chance(0.15) ? R.int(1, 5) : undefined,
    });
    stats.added("payments.charge");
  });
  const chargeWorker = new Worker(
    "payments.charge",
    async (job) => {
      await job.log(`authorizing ${job.data.amount / 100} ${job.data.currency} for ${job.data.customer.email}`);
      await sleep(R.int(200, 1500));
      if (R.chance(0.04)) {
        const reason = R.pick(["card_declined", "gateway_timeout", "insufficient_funds", "gateway_timeout"]);
        await job.log(`gateway responded: ${reason}`);
        if (reason === "card_declined" || reason === "insufficient_funds") {
          // no point retrying a declined card
          throw new UnrecoverableError(`card_declined: ${reason} (${job.data.card.brand} •••• ${job.data.card.last4})`);
        }
        throw new Error(`gateway_timeout: acquirer did not answer within 1500ms (attempt ${job.attemptsMade + 1})`);
      }
      await job.log("captured");
      return { status: "captured", authCode: R.id("auth").toUpperCase(), fee: Math.round(job.data.amount * 0.029) + 30 };
    },
    { connection, prefix, concurrency: 4, metrics: METRICS },
  );
  ctx.register(chargeWorker);
  chargeWorker.on("completed", () => stats.completed("payments.charge"));
  chargeWorker.on("failed", () => stats.failed("payments.charge"));

  // ---- payments.refund -------------------------------------------------
  const refund = ctx.register(new Queue("payments.refund", { connection, prefix, defaultJobOptions: jobOpts }));
  ctx.loop("refund.produce", ctx.every(6_000), async () => {
    const poison = R.chance(0.2);
    await refund.add(
      poison ? "refund.partial" : "refund.full",
      {
        refundId: R.id("re"),
        chargeId: R.id("ch"),
        tenantId: R.tenant(),
        amount: R.amountCents(),
        currency: R.currency(),
        reason: R.pick(["requested_by_customer", "duplicate", "fraudulent", "product_not_received"]),
        requestedBy: R.email(),
        // a partial refund of a charge that was already refunded: always fails
        alreadyRefunded: poison,
      },
      { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
    );
    stats.added("payments.refund");
  });
  const refundWorker = new Worker(
    "payments.refund",
    async (job) => {
      await job.log(`looking up charge ${job.data.chargeId}`);
      await sleep(R.int(400, 2_000));
      if (job.data.alreadyRefunded) {
        await job.log("charge already fully refunded; acquirer rejected");
        throw new Error(`refund_rejected: charge ${job.data.chargeId} has no refundable balance`);
      }
      return { status: "refunded", settledAt: new Date().toISOString() };
    },
    { connection, prefix, concurrency: 2, metrics: METRICS },
  );
  ctx.register(refundWorker);
  refundWorker.on("completed", () => stats.completed("payments.refund"));
  refundWorker.on("failed", () => stats.failed("payments.refund"));

  // ---- payments.webhook-dispatch --------------------------------------
  const webhooks = ctx.register(
    new Queue("payments.webhook-dispatch", { connection, prefix, defaultJobOptions: jobOpts }),
  );
  const burst = async () => {
    const n = ctx.scale(R.int(100, 300));
    const tenantId = R.tenant();
    const endpoint = `https://hooks.${tenantId.replace("tenant-", "")}.example.com/payments`;
    await webhooks.addBulk(
      Array.from({ length: n }, () => ({
        name: R.pick(["charge.succeeded", "charge.succeeded", "charge.failed", "refund.created"]),
        data: {
          eventId: R.id("evt"),
          tenantId,
          endpoint,
          attemptOf: 1,
          payload: { chargeId: R.id("ch"), amount: R.amountCents(), currency: R.currency() },
          signature: `t=${Date.now()},v1=${R.uuid().replace(/-/g, "")}`,
        },
        opts: { attempts: 3, backoff: { type: "exponential", delay: 3_000 } },
      })),
    );
    stats.added("payments.webhook-dispatch", n);
  };
  // First burst right away so the dashboard is not empty on first paint.
  await burst();
  ctx.loop("webhook.burst", 30_000, burst, 0.1);
  const webhookWorker = new Worker(
    "payments.webhook-dispatch",
    async (job) => {
      await job.log(`POST ${job.data.endpoint}`);
      await sleep(R.int(50, 400));
      if (R.chance(0.02)) {
        // endpoint deleted by the customer: retrying is pointless, fail for good
        await job.log("HTTP 410 Gone");
        throw new UnrecoverableError(`HTTP 410 from customer endpoint ${job.data.endpoint} (endpoint removed)`);
      }
      if (R.chance(0.1)) {
        await job.log("HTTP 502 Bad Gateway");
        throw new Error(`HTTP 502 from customer endpoint ${job.data.endpoint}`);
      }
      return { status: 200, latencyMs: R.int(40, 900) };
    },
    { connection, prefix, concurrency: 8, metrics: METRICS },
  );
  ctx.register(webhookWorker);
  webhookWorker.on("completed", () => stats.completed("payments.webhook-dispatch"));
  webhookWorker.on("failed", () => stats.failed("payments.webhook-dispatch"));

  // "Dead worker" scenario: every ~4 min the dispatcher stops for 60 s, waiting
  // piles up (two bursts land meanwhile), then it resumes and drains.
  const OUTAGE_EVERY = 4 * 60_000;
  const OUTAGE_FOR = 60_000;
  ctx.loop(
    "webhook.outage",
    OUTAGE_EVERY,
    async () => {
      stats.note("payments.webhook-dispatch worker DOWN for 60s");
      await webhookWorker.pause(true);
      ctx.after(OUTAGE_FOR, () => {
        webhookWorker.resume();
        stats.note("payments.webhook-dispatch worker back UP");
      });
    },
    0.05,
  );
}
