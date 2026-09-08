/**
 * BULLPANE_READ_ONLY=true must refuse every write, with no route left behind.
 * The hook is what production trials rely on, so it is tested directly.
 */
import { describe, expect, it } from "vitest";
import { blockWrites } from "../plugins/gates";
import { HttpError } from "../plugins/errors";

type Req = Parameters<typeof blockWrites>[0];

function request(method: string, url: string, readOnly: boolean): Req {
  return { method, url, server: { ctx: { config: { readOnly } } } } as unknown as Req;
}
const reply = {} as Parameters<typeof blockWrites>[1];

async function run(method: string, url: string, readOnly = true): Promise<HttpError | null> {
  try {
    await blockWrites(request(method, url, readOnly), reply);
    return null;
  } catch (err) {
    return err as HttpError;
  }
}

describe("read-only mode", () => {
  it("is inert when the flag is off", async () => {
    expect(await run("POST", "/api/connections/x/queues/q/jobs", false)).toBeNull();
    expect(await run("DELETE", "/api/users/1", false)).toBeNull();
  });

  it("allows every read", async () => {
    for (const url of ["/api/connections", "/api/connections/c/queues/q/jobs?state=failed", "/api/alerts/events"]) {
      expect(await run("GET", url)).toBeNull();
      expect(await run("HEAD", url)).toBeNull();
    }
  });

  it("refuses every mutating verb with 423 read_only", async () => {
    const writes: Array<[string, string]> = [
      ["POST", "/api/connections/c/queues/q/jobs"],
      ["POST", "/api/connections/c/queues/q/jobs/1/retry"],
      ["POST", "/api/connections/c/queues/q/jobs/1/promote"],
      ["DELETE", "/api/connections/c/queues/q/jobs/1"],
      ["POST", "/api/connections/c/queues/q/jobs/bulk/retry"],
      ["POST", "/api/connections/c/queues/q/jobs/bulk/remove"],
      ["POST", "/api/connections/c/queues/q/jobs/bulk/promote"],
      ["POST", "/api/connections/c/queues/q/pause"],
      ["POST", "/api/connections/c/queues/q/clean"],
      ["POST", "/api/connections/c/queues/q/retry-all"],
      ["POST", "/api/connections/c/queues/q/drain"],
      ["POST", "/api/connections/c/queues/q/obliterate"],
      ["POST", "/api/connections"],
      ["PATCH", "/api/connections/c"],
      ["DELETE", "/api/connections/c"],
      ["POST", "/api/alerts"],
      ["PATCH", "/api/alerts/a"],
      ["DELETE", "/api/alerts/a"],
      ["POST", "/api/connections/c/hidden-queues"],
      ["DELETE", "/api/connections/c/hidden-queues/legacy"],
      ["POST", "/api/folders"],
      ["PUT", "/api/folders/f/queues"],
      ["POST", "/api/users"],
      ["PUT", "/api/license"],
      ["POST", "/api/setup"],
      // Settings → Attention deliberately skips `blockInDemo`, so this hook is
      // the ONLY thing refusing it during a production trial.
      ["PUT", "/api/settings/attention"],
      // SSO admin CRUD is a configuration write; only the IdP callback is exempt
      // (covered in "still lets people log in and out").
      ["POST", "/api/sso/providers"],
      ["PATCH", "/api/sso/providers/p"],
      ["DELETE", "/api/sso/providers/p"],
    ];
    for (const [method, url] of writes) {
      const err = await run(method, url);
      expect(err, `${method} ${url} should be refused`).toBeInstanceOf(HttpError);
      expect(err?.status).toBe(423);
      expect(err?.error).toBe("read_only");
    }
  });

  it("still lets people log in and out", async () => {
    expect(await run("POST", "/api/auth/login")).toBeNull();
    expect(await run("POST", "/api/auth/logout")).toBeNull();
    // query strings must not defeat the allowlist match
    expect(await run("POST", "/api/auth/login?next=/")).toBeNull();
  });
});
