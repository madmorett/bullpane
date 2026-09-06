import { Queue, Worker } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };

const TEMPLATES = ["welcome", "password-reset", "invoice", "receipt", "weekly-digest", "cart-abandoned", "2fa-code"];

/**
 * notifications.email  high volume with priorities; some ~60 KB rendered bodies
 * notifications.sms    rate-limited worker (10/s) so `waiting` grows visibly
 * notifications.push   mostly delayed jobs (scheduled sends), up to 10 min out
 */
export async function startNotifications(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const jobOpts = ctx.defaultJobOptions;

  // ---- email -----------------------------------------------------------
  const email = ctx.register(new Queue("notifications.email", { connection, prefix, defaultJobOptions: jobOpts }));
  ctx.loop("email.produce", ctx.every(250), async () => {
    const template = R.pick(TEMPLATES);
    const priority = template === "2fa-code" ? 1 : template === "password-reset" ? 2 : R.chance(0.3) ? R.int(3, 10) : undefined;
    const big = R.chance(0.08);
    await email.add(
      template,
      {
        messageId: R.id("msg"),
        tenantId: R.tenant(),
        to: R.email(),
        from: `no-reply@${R.pick(["acme.io", "globex.com", "initech.net"])}`,
        subject: R.sentence(R.int(3, 7)).replace(/\.$/, ""),
        template,
        locale: R.pick(["pt-BR", "en-US", "es-MX"]),
        vars: { firstName: R.firstName(), amount: R.amountCents() / 100 },
        ...(big ? { renderedHtml: R.bigBlob(R.int(50, 100)) } : {}),
      },
      { priority, attempts: 3, backoff: { type: "exponential", delay: 1_000 } },
    );
    stats.added("notifications.email");
  });
  const emailWorker = new Worker(
    "notifications.email",
    async (job) => {
      await job.log(`rendering template ${job.data.template} (${job.data.locale})`);
      await sleep(R.int(80, 350));
      if (R.chance(0.015)) throw new Error(`smtp: 421 4.7.0 Too many connections from ${R.ipv4()}`);
      await job.log(`delivered to ${job.data.to}`);
      return { provider: R.pick(["ses", "sendgrid", "postmark"]), providerMessageId: R.uuid() };
    },
    { connection, prefix, concurrency: 6, metrics: METRICS },
  );
  ctx.register(emailWorker);
  emailWorker.on("completed", () => stats.completed("notifications.email"));
  emailWorker.on("failed", () => stats.failed("notifications.email"));

  // ---- sms (rate limited) ----------------------------------------------
  const sms = ctx.register(new Queue("notifications.sms", { connection, prefix, defaultJobOptions: jobOpts }));
  // ~14/s produced against a 10/s limiter => waiting grows, then bursts shrink.
  ctx.loop(
    "sms.produce",
    ctx.every(1_000),
    async () => {
      const n = ctx.scale(R.int(8, 20));
      await sms.addBulk(
        Array.from({ length: n }, () => ({
          name: R.pick(["otp", "otp", "shipping-update", "marketing"]),
          data: {
            smsId: R.id("sms"),
            tenantId: R.tenant(),
            to: R.phone(),
            body: R.chance(0.5) ? `Your verification code is ${R.int(100000, 999999)}` : R.sentence(R.int(6, 12)),
            sender: R.pick(["ACME", "GLOBEX", "27999"]),
          },
          opts: { attempts: 2 },
        })),
      );
      stats.added("notifications.sms", n);
    },
    0.3,
  );
  const smsWorker = new Worker(
    "notifications.sms",
    async (job) => {
      await sleep(R.int(30, 120));
      if (R.chance(0.02)) throw new Error(`carrier rejected: invalid destination ${job.data.to}`);
      return { segments: Math.ceil(job.data.body.length / 160), carrier: R.pick(["vivo", "claro", "tim", "twilio"]) };
    },
    { connection, prefix, concurrency: 4, limiter: { max: 10, duration: 1_000 }, metrics: METRICS },
  );
  ctx.register(smsWorker);
  smsWorker.on("completed", () => stats.completed("notifications.sms"));
  smsWorker.on("failed", () => stats.failed("notifications.sms"));

  // ---- push (delayed) --------------------------------------------------
  const push = ctx.register(new Queue("notifications.push", { connection, prefix, defaultJobOptions: jobOpts }));
  ctx.loop("push.produce", ctx.every(1_500), async () => {
    const delay = R.chance(0.7) ? R.int(5_000, 10 * 60_000) : 0;
    await push.add(
      R.pick(["order-shipped", "price-drop", "reminder", "new-message"]),
      {
        pushId: R.id("push"),
        tenantId: R.tenant(),
        userId: R.id("usr"),
        deviceTokens: Array.from({ length: R.int(1, 3) }, () => R.uuid().replace(/-/g, "")),
        title: R.sentence(R.int(2, 5)).replace(/\.$/, ""),
        body: R.sentence(),
        scheduledFor: new Date(Date.now() + delay).toISOString(),
      },
      { delay, attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
    );
    stats.added("notifications.push");
  });
  const pushWorker = new Worker(
    "notifications.push",
    async (job) => {
      await sleep(R.int(50, 200));
      if (R.chance(0.03)) throw new Error("apns: 410 Unregistered device token");
      return { sent: job.data.deviceTokens.length };
    },
    { connection, prefix, concurrency: 3, metrics: METRICS },
  );
  ctx.register(pushWorker);
  pushWorker.on("completed", () => stats.completed("notifications.push"));
  pushWorker.on("failed", () => stats.failed("notifications.push"));
}
