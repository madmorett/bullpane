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
import type { Target } from "./seed.js";
import { assert, check, heading, info, waitFor } from "./harness.js";

export async function runUi(opts: {
  base: string;
  api: Api;
  target: Target;
  login: { email: string; password: string } | null;
}): Promise<void> {
  heading(`Browser: the journey a person makes (${opts.target.kind})`);
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

  const { api, target: t } = opts;
  const pg = t.kind === "postgres";
  const name = `${t.kind}-ui`;
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

    await step(`add a ${pg ? "PostgreSQL" : "Redis"} connection through the dialog, testing it first`, async (p) => {
      await p.goto(`${opts.base}/settings/connections`);
      await p.getByRole("button", { name: "Add connection" }).first().click();
      const dialog = p.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      if (pg) {
        await dialog.getByRole("tab", { name: "Postgres (BullMQ 6)" }).click();
        await dialog.getByLabel("Postgres URL").fill(t.url);
        await dialog.getByLabel("Schema").fill(t.ns);
      } else {
        // Redis is the default backend; the URL tab is what most people paste into
        await dialog.getByRole("tab", { name: "Connection URL" }).click();
        await dialog.getByLabel("Redis URL").fill(t.url);
        await dialog.getByLabel("Key prefix").fill(t.ns);
      }
      await dialog.getByRole("button", { name: "Test connection" }).click();
      await dialog.getByText(pg ? /Connected in .* · Postgres \d+/ : /Connected in .* · Redis \d+/).waitFor();
      await dialog.getByRole("button", { name: "Add connection" }).click();
      await dialog.waitFor({ state: "detached" });
      await p.getByRole("cell", { name: new RegExp(name) }).first().waitFor();
      if (pg) await p.getByRole("cell", { name: new RegExp(name) }).getByText("postgres", { exact: true }).waitFor();
      const list = await api.get<RedisConnection[]>("/connections");
      const c = list.find((x) => x.name === name);
      assert(c?.kind === t.kind && c.prefix === t.ns, `stored as ${JSON.stringify(c)}`);
      cid = c.id;
    });
    if (!cid) return;

    await step(`connection page shows the ${pg ? "Postgres" : "Redis"} server and every queue`, async (p) => {
      await p.goto(`${opts.base}/c/${cid}`);
      await p.getByText(pg ? "Postgres" : "Redis", { exact: true }).first().waitFor();
      if (!pg) await p.getByText("Memory", { exact: true }).first().waitFor();
      for (const q of ["orders", "emails", "assemble", "parts"]) await p.getByRole("link", { name: q, exact: true }).first().waitFor();
    });

    await step("open a queue from the sidebar and read its waiting jobs", async (p) => {
      await p.getByRole("link", { name: "orders", exact: true }).first().click();
      await p.waitForURL(/\/q\/orders/);
      await p.getByText("needle-xyz").first().waitFor();
      if (pg) {
        const text = await p.locator("body").innerText();
        assert(!/Redis/.test(text), `a Postgres queue page talks about Redis: …${text.slice(Math.max(0, text.indexOf("Redis") - 60), text.indexOf("Redis") + 40)}…`);
      }
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

    await step(`health page shows the ${pg ? "Postgres" : "Redis"} card`, async (p) => {
      await p.goto(`${opts.base}/health`);
      if (pg) {
        await p.getByText(/Postgres \d+/).first().waitFor();
        await p.getByText("Events table").first().waitFor();
      } else {
        // exact: the top bar's tooltip also mentions commands and memory
        await p.getByText("Commands/sec", { exact: true }).first().waitFor();
        await p.getByText("Memory", { exact: true }).first().waitFor();
        // the Redis card still has its Redis-only details
        await p.getByText("Maxmemory policy").first().waitFor({ state: "attached" });
      }
    });

    await step("delete the connection from settings", async (p) => {
      await p.goto(`${opts.base}/settings/connections`);
      await p.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Delete connection" }).click();
      const dialog = p.getByRole("dialog");
      await dialog.getByRole("textbox").fill(name);
      await dialog.getByRole("button", { name: "Remove connection" }).click();
      await dialog.waitFor({ state: "detached" });
      const list = await api.get<RedisConnection[]>("/connections");
      assert(!list.some((c) => c.id === cid), "connection still listed");
    });
  } finally {
    await browser.close();
  }
}
