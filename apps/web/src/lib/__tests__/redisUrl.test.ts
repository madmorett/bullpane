import { describe, expect, it } from "vitest";
import { partsFromUrl, urlFromParts, partsChanged, DEFAULT_REDIS_PARTS } from "../redisUrl";

describe("redis url <-> fields", () => {
  it("round-trips a password with reserved characters and TLS", () => {
    const parts = { host: "cache.acme.internal", port: "6380", username: "bullpane", password: "p@ss:w/rd?", db: "2", tls: true };
    const url = urlFromParts(parts);
    expect(url).toBe("rediss://bullpane:p%40ss%3Aw%2Frd%3F@cache.acme.internal:6380/2");
    expect(partsFromUrl(url)).toEqual(parts);
  });
  it("omits auth and database when they are empty / default", () => {
    expect(urlFromParts({ ...DEFAULT_REDIS_PARTS, host: "10.0.0.5" })).toBe("redis://10.0.0.5:6379");
    expect(urlFromParts({ ...DEFAULT_REDIS_PARTS, password: "s3cret" })).toBe("redis://:s3cret@localhost:6379");
  });
  it("treats the API's redacted password as empty so the form never shows ****", () => {
    expect(partsFromUrl("redis://:****@host:6379/0").password).toBe("");
    expect(partsFromUrl("redis://:****@host:6379/0").host).toBe("host");
  });
  it("falls back to defaults on garbage and ignores the password when comparing", () => {
    expect(partsFromUrl("not a url")).toEqual(DEFAULT_REDIS_PARTS);
    expect(partsChanged(DEFAULT_REDIS_PARTS, { ...DEFAULT_REDIS_PARTS, password: "x" })).toBe(false);
    expect(partsChanged(DEFAULT_REDIS_PARTS, { ...DEFAULT_REDIS_PARTS, tls: true })).toBe(true);
  });
});
