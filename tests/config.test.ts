import { readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ConfigError,
  loadConfig,
  opencodeSettingsFor,
  parseEnv,
  parseFileConfig,
} from "../src/config/load.js";
import { baseFileConfig, tempDir, testConfig } from "./helpers.js";

describe("repository configuration", () => {
  it("accepts the shipped example and applies defaults", () => {
    const raw = parse(readFileSync("config/repositories.example.yaml", "utf8"));
    const cfg = parseFileConfig(raw);
    expect(cfg.repositories.map((r) => r.id)).toEqual(["songbook", "home-server"]);
    expect(cfg.github.authorized_users).toEqual(["xbankov", "VladoBaca"]);
    expect(cfg.discovery.issue_batch_size).toBe(1);
    expect(cfg.limits.max_review_iterations).toBe(5);
    expect(cfg.opencode.analysis_agent).toBe("maintainer-plan");
  });

  it("fills defaults for a minimal config", () => {
    const cfg = parseFileConfig(baseFileConfig);
    const repo = cfg.repositories[0]!;
    expect(repo.enabled).toBe(true);
    expect(repo.default_branch).toBe("main");
    expect(repo.max_concurrent_tasks).toBe(1);
    expect(repo.commands.test).toEqual([]);
    expect(cfg.github.proposal_label).toBe("ai-proposal");
    expect(cfg.discovery.schedule).toBe("0 8 * * *");
    expect(cfg.limits.max_implementation_retries).toBe(3);
  });

  it("rejects duplicate ids and duplicate repositories", () => {
    const dupId = {
      ...baseFileConfig,
      repositories: [
        { id: "a", owner: "o", name: "one" },
        { id: "a", owner: "o", name: "two" },
      ],
    };
    expect(() => parseFileConfig(dupId)).toThrow(/duplicate id "a"/);
    const dupRepo = {
      ...baseFileConfig,
      repositories: [
        { id: "a", owner: "O", name: "One" },
        { id: "b", owner: "o", name: "one" },
      ],
    };
    expect(() => parseFileConfig(dupRepo)).toThrow(/duplicate repository o\/one/);
  });

  it("rejects unknown keys (typos must not be silently ignored)", () => {
    const typo = { ...baseFileConfig, limits: { max_review_iteration: 3 } };
    expect(() => parseFileConfig(typo)).toThrow(ConfigError);
  });

  it("requires at least one authorized user", () => {
    expect(() => parseFileConfig({ ...baseFileConfig, github: { authorized_users: [] } })).toThrow(
      ConfigError,
    );
  });

  it("supports per-repository OpenCode overrides", () => {
    const cfg = testConfig({
      file: {
        repositories: [
          {
            id: "a",
            owner: "o",
            name: "a",
            opencode: { implementation_agent: "custom-build", model: "p/m" },
          },
        ],
      },
    });
    expect(opencodeSettingsFor(cfg, cfg.file.repositories[0]!)).toEqual({
      analysisAgent: "maintainer-plan",
      implementationAgent: "custom-build",
      model: "p/m",
    });
  });

  it("rejects an allowed label that is a bot status label", () => {
    expect(() =>
      parseFileConfig({
        ...baseFileConfig,
        github: { authorized_users: ["xbankov"], allowed_label: "AI:Queued" },
      }),
    ).toThrow(/status labels/);
  });

  it("accepts the deprecated trusted_issue_authors key with a warning", () => {
    const cfg = testConfig({
      file: { github: { authorized_users: ["xbankov"], trusted_issue_authors: ["xbankov"] } },
    });
    expect(cfg.warnings).toEqual([expect.stringContaining("deprecated")]);
    expect(testConfig().warnings).toEqual([]);
  });

  it("defaults the allowed label and polling interval", () => {
    const d = testConfig().file;
    expect(d.github.allowed_label).toBe("ai:allowed");
    expect(d.discovery.poll_interval_seconds).toBe(300);
  });
});

describe("environment", () => {
  it("parses booleans and defaults", () => {
    const env = parseEnv({ MAINTAINER_PAUSED: "true" });
    expect(env.MAINTAINER_PAUSED).toBe(true);
    expect(env.HTTP_PORT).toBe(8787);
    expect(parseEnv({}).MAINTAINER_PAUSED).toBe(false);
  });

  it("treats GitHub credentials as all-or-nothing", () => {
    expect(testConfig().github).toBeNull();
    expect(() => testConfig({ env: { GITHUB_APP_ID: "1" } })).toThrow(/PRIVATE_KEY/);
  });

  it("loads the private key from a file", () => {
    const dir = tempDir();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const keyPath = join(dir, "app.pem");
    writeFileSync(keyPath, privateKey);
    const cfg = testConfig({ env: { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: keyPath } });
    expect(cfg.github?.appId).toBe("123");
    expect(cfg.github?.privateKey).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("rejects a key file that is not a PEM key", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.pem"), "not a key");
    expect(() =>
      testConfig({
        env: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "bad.pem") },
      }),
    ).toThrow(/not a PEM/);
  });

  it("loadConfig reports unreadable files and invalid YAML clearly", () => {
    const dir = tempDir();
    expect(() => loadConfig({ CONFIG_PATH: join(dir, "missing.yaml") }, dir)).toThrow(
      /Cannot read CONFIG_PATH/,
    );
    writeFileSync(join(dir, "bad.yaml"), "repositories: [unclosed");
    expect(() => loadConfig({ CONFIG_PATH: join(dir, "bad.yaml") }, dir)).toThrow(/Invalid YAML/);
  });
});
