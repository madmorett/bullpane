import { Queue, Worker } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };

const SIZES = ["64x64", "128x128", "320x240", "640x480", "1280x720", "1920x1080"];

/**
 * media.thumbnails: progress 0→100 over ~5 s, a big returnvalue, and 5% of jobs
 * throw with a long stack trace so the failure view has something ugly to show.
 */
export async function startMedia(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const queue = ctx.register(new Queue("media.thumbnails", { connection, prefix, defaultJobOptions: ctx.defaultJobOptions }));

  ctx.loop("media.produce", ctx.every(2_000), async () => {
    await queue.add(
      "generate",
      {
        assetId: R.id("asset"),
        tenantId: R.tenant(),
        source: `s3://uploads-prod/${R.tenant()}/${R.uuid()}.${R.pick(["jpg", "png", "heic", "webp"])}`,
        sizes: R.shuffle(SIZES).slice(0, R.int(2, 6)),
        uploadedBy: R.email(),
        sizeBytes: R.int(200_000, 18_000_000),
      },
      { attempts: 2, backoff: { type: "fixed", delay: 5_000 } },
    );
    stats.added("media.thumbnails");
  });

  const worker = new Worker(
    "media.thumbnails",
    async (job) => {
      const sizes: string[] = job.data.sizes;
      await job.log(`downloading ${job.data.source} (${(job.data.sizeBytes / 1_000_000).toFixed(1)} MB)`);
      const stepMs = Math.round(5_000 / (sizes.length + 1));
      await sleep(stepMs);
      const variants: Record<string, unknown> = {};
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i]!;
        await sleep(stepMs);
        await job.updateProgress(Math.round(((i + 1) / (sizes.length + 1)) * 100));
        await job.log(`variant ${size} done`);
        variants[size] = {
          url: `https://cdn.example.com/t/${job.data.assetId}/${size}.webp`,
          bytes: R.int(2_000, 400_000),
          // a fake base64 preview to fatten the return value
          blurhash: Buffer.from(R.sentence(60)).toString("base64"),
          exif: R.bigBlob(6),
        };
      }
      if (R.chance(0.05)) {
        throw R.longStackError(`sharp: Input buffer contains unsupported image format (${job.data.source})`);
      }
      await job.updateProgress(100);
      return { assetId: job.data.assetId, variants, generatedAt: new Date().toISOString() };
    },
    { connection, prefix, concurrency: 3, metrics: METRICS },
  );
  ctx.register(worker);
  worker.on("completed", () => stats.completed("media.thumbnails"));
  worker.on("failed", () => stats.failed("media.thumbnails"));
}
