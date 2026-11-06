import { describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { setKillSwitch } from "../src/database/settings.js";
import { mockFetch, silentLogger, testConfig } from "./helpers.js";

const healthyOpenCode = () =>
  mockFetch(({ url }) => {
    if (url.pathname === "/api/info") return { body: { version: "2.2.5" } };
    if (url.pathname === "/api/agent")
      return {
        body: { location: {}, data: [{ id: "maintainer-plan" }, { id: "maintainer-build" }] },
      };
    return undefined;
  });
const okOpenCode = healthyOpenCode();

describe("HTTP health endpoints", () => {
  it("/healthz is always ok", async () => {
    const app = await createApplication(testConfig(), silentLogger, {
      opencodeFetch: okOpenCode.fetch,
    });
    const res = await app.http.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("/readyz is 503 while GitHub is not configured, and explains why", async () => {
    const app = await createApplication(testConfig(), silentLogger, {
      opencodeFetch: okOpenCode.fetch,
    });
    const res = await app.http.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.components.database.ok).toBe(true);
    expect(body.components.opencode.ok).toBe(true);
    expect(body.components.github.problems[0]).toMatch(/not configured/);
    await app.close();
  });

  it("/readyz reports an OpenCode outage and the kill switch", async () => {
    const down = mockFetch(() => ({ status: 503, body: {} }));
    const app = await createApplication(testConfig(), silentLogger, { opencodeFetch: down.fetch });
    setKillSwitch(app.db, true, "test", "maintenance");
    const body = (await app.http.inject({ method: "GET", url: "/readyz" })).json();
    expect(body.components.opencode.ok).toBe(false);
    expect(body.killSwitch).toEqual({ paused: true, source: "database", reason: "maintenance" });
    await app.close();
  });

  it("caches external checks between /readyz calls", async () => {
    const counting = healthyOpenCode();
    const app = await createApplication(testConfig(), silentLogger, {
      opencodeFetch: counting.fetch,
    });
    await app.http.inject({ method: "GET", url: "/readyz" });
    await app.http.inject({ method: "GET", url: "/readyz" });
    expect(counting.calls.filter((c) => c.url.pathname === "/api/info")).toHaveLength(1);
    await app.close();
  });

  it("start-up syncs configured repositories into the database", async () => {
    const app = await createApplication(testConfig(), silentLogger, {
      opencodeFetch: okOpenCode.fetch,
    });
    const rows = app.db.$client.prepare("select id, enabled from repositories order by id").all();
    expect(rows).toEqual([
      { id: "home-server", enabled: 1 },
      { id: "songbook", enabled: 1 },
    ]);
    await app.close();
  });
});
