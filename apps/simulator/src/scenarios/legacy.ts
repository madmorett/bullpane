import { Queue } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

/**
 * legacy.exports: a paused queue with 40 waiting jobs and no worker. Shows the
 * `paused` state, the "no workers" badge and gives the dashboard something to
 * resume/drain in the playground.
 */
export async function startLegacy(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const queue = ctx.register(new Queue("legacy.exports", { connection, prefix, defaultJobOptions: ctx.defaultJobOptions }));
  await queue.pause();
  const counts = await queue.getJobCounts("waiting", "paused");
  const existing = (counts.waiting ?? 0) + (counts.paused ?? 0);
  const missing = Math.max(0, 40 - existing);
  if (missing > 0) {
    await queue.addBulk(
      Array.from({ length: missing }, (_, i) => ({
        name: "export-v1",
        data: {
          exportId: R.id("exp"),
          tenantId: R.tenant(),
          format: "xml",
          legacySystem: R.pick(["SAP", "Protheus", "Oracle EBS"]),
          requestedBy: R.email(),
          note: i % 10 === 0 ? "blocked since migration to v2 exporter" : undefined,
        },
      })),
    );
    stats.added("legacy.exports", missing);
  }
}
