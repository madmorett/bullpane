/**
 * The same journey a person makes, in a real browser (Playwright, headless
 * Chromium) against the real server: sign in, add a PostgreSQL connection
 * through the dialog, read a queue, search, open a job, remove it, pause and
 * resume, check the health page, delete the connection.
 *
 * Every step leaves a screenshot in SMOKE_SCREENSHOTS (default: a temp dir) so a
 * failure can be looked at, not guessed at.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { JobDetail, JobsPage, RedisConnection } from "@bullpane/shared";
import { Api } from "./server.js";
import { assert, check, heading, info, waitFor } from "./harness.js";

export async function runUi(opts: {
  base: string;
  api: Api;
  pgUrl: string;
  schema: string;
  login: { email: string; password: string } | null;
}): Promise<void> {
  heading("Browser: the journey a person makes");
  const shots = process.env.SMOKE_SCREENSHOTS ?? path.join(tmpdir(), `bullpane-smoke-shots-${Date.now()}`);
  mkdirSync(shots, { recursive: true });
  info(`screenshots: ${shots}`);

  let browser: Browser;
  try {
    browser = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {});
  } catch (err) {
    await check("launch Chromium (run `pnpm --filter @bullpane/smoke exec playwright install chromium`)", () => {
      throw err;
    });
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15_000);
  let n = 0;
  const shot = (name: string) => page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, "0")}-${name}.png`) });
  const step = async (name: string, fn: (p: Page) => Promise<void>) =>
    check(name, async () => {
      try {
        await fn(page);
        await shot(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
      } catch (err) {
        await shot(`FAILED-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`).catch(() => undefined);
        throw err;
      }
    });

  const { api, pgUrl, schema } = opts;
  let cid = "";
  try {
    if (opts.login) {
      const login = opts.login;
      await step("sign in", async (p) => {
        await p.goto(opts.base);
        await p.getByLabel("Email").fill(login.email);
        await p.getByLabel("Password").fill(login.password);
        await p.getByRole("button", { name: "Sign in", exact: true }).click();
        await p.getByRole("link", { name: "Overview" }).first().waitFor();
      });
    }

    await step("add a PostgreSQL connection through the dialog, testing it first", async (p) => {
      await p.goto(`${opts.base}/settings/connections`);
      await p.getByRole("button", { name: "Add connection" }).first().click();
      const dialog = p.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Postgres (BullMQ 6)" }).click();
      await dialog.getByLabel("Name").fill("pg-ui");
      await dialog.getByLabel("Postgres URL").fill(pgUrl);
      await dialog.getByLabel("Schema").fill(schema);
      await dialog.getByRole("button", { name: "Test connection" }).click();
      await dialog.getByText(/Connected in .* · Postgres \d+/).waitFor();
      await dialog.getByRole("button", { name: "Add connection" }).click();
      await dialog.waitFor({ state: "detached" });
      await p.getByRole("cell", { name: /pg-ui/ }).getByText("postgres").waitFor();
      const list = await api.get<RedisConnection[]>("/connections");
      const c = list.find((x) => x.name === "pg-ui");
      assert(c?.kind === "postgres" && c.prefix === schema, `stored as ${JSON.stringify(c)}`);
      cid = c.id;
    });
    if (!cid) return;

    await step("connection page shows the Postgres server and every queue", async (p) => {
      await p.goto(`${opts.base}/c/${cid}`);
      await p.getByText("Postgres", { exact: true }).first().waitFor();
      for (const q of ["orders", "emails", "assemble", "parts"]) await p.getByRole("link", { name: q, exact: true }).first().waitFor();
    });

    await step("open a queue from the sidebar and read its waiting jobs", async (p) => {
      await p.getByRole("link", { name: "orders", exact: true }).first().click();
      await p.waitForURL(/\/q\/orders/);
      await p.getByText("needle-xyz").first().waitFor();
      const text = await p.locator("body").innerText();
      assert(!/Redis/.test(text), `a Postgres queue page talks about Redis: …${text.slice(Math.max(0, text.indexOf("Redis") - 60), text.indexOf("Redis") + 40)}…`);
    });

    let jobId = "";
    await step("search the payload: exactly one hit", async (p) => {
      await p.getByLabel("Search jobs").fill("needle");
      await p.getByLabel("Search jobs").press("Enter");
      await p.getByText(/^1\s*match/).first().waitFor();
      const rows = p.locator("tbody tr").filter({ has: p.getByRole("checkbox") });
      assert((await rows.count()) === 1, `${await rows.count()} result rows`);
      assert((await rows.first().innerText()).includes("needle-xyz"), "the hit is not the needle job");
      jobId = (await rows.first().getByRole("link").first().innerText()).trim();
    });

    await step("open the job: its data is rendered", async (p) => {
      await p.getByRole("link", { name: jobId, exact: true }).first().click();
      await p.waitForURL(new RegExp(`/j/${jobId}`));
      await p.getByText("needle-xyz").first().waitFor();
    });

    await step("remove the job from its page; the API confirms it is gone", async (p) => {
      await p.getByRole("button", { name: "Remove", exact: true }).click();
      await p.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
      await p.getByRole("dialog").waitFor({ state: "detached" });
      const res = await api.request("GET", `/connections/${cid}/queues/orders/jobs/${jobId}`);
      assert(res.status === 404, `job still there (${res.status})`);
    });

    await step("pause the queue from the UI, then resume it", async (p) => {
      await p.goto(`${opts.base}/c/${cid}/q/orders`);
      await p.getByRole("button", { name: "Pause", exact: true }).click();
      await p.getByRole("dialog").getByRole("button", { name: /Pause/ }).click();
      await p.getByRole("button", { name: "Resume", exact: true }).waitFor();
      await p.getByRole("button", { name: "Resume", exact: true }).click();
      await p.getByRole("button", { name: "Pause", exact: true }).waitFor();
    });

    await step("retry a failed job from its page", async (p) => {
      const failed = await api.get<JobsPage>(`/connections/${cid}/queues/emails/jobs?state=failed&pageSize=1`);
      const id = failed.jobs[0]!.id;
      await p.goto(`${opts.base}/c/${cid}/q/emails/j/${id}`);
      await p.getByRole("tab", { name: /Error/ }).click();
      await p.getByText("smtp down").first().waitFor();
      await p.getByRole("button", { name: "Retry", exact: true }).click();
      await waitFor("the job to be waiting", async () => (await api.get<JobDetail>(`/connections/${cid}/queues/emails/jobs/${id}`)).state === "waiting");
      await p.getByText("waiting", { exact: true }).first().waitFor();
    });

    await step("health page shows the Postgres card", async (p) => {
      await p.goto(`${opts.base}/health`);
      await p.getByText(/Postgres \d+/).first().waitFor();
      await p.getByText("Events table").first().waitFor();
    });

    await step("delete the connection from settings", async (p) => {
      await p.goto(`${opts.base}/settings/connections`);
      await p.getByRole("row", { name: /pg-ui/ }).getByRole("button", { name: "Delete connection" }).click();
      const dialog = p.getByRole("dialog");
      await dialog.getByRole("textbox").fill("pg-ui");
      await dialog.getByRole("button", { name: "Remove connection" }).click();
      await dialog.waitFor({ state: "detached" });
      const list = await api.get<RedisConnection[]>("/connections");
      assert(!list.some((c) => c.id === cid), "connection still listed");
    });
  } finally {
    await browser.close();
  }
}
