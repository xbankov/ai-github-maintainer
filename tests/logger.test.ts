import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger("info", stream), lines };
}

describe("structured logging", () => {
  it("emits JSON with level labels, timestamps and service name", () => {
    const { logger, lines } = capture();
    logger.info({ repo: "songbook" }, "hello");
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: "info",
      msg: "hello",
      repo: "songbook",
      service: "ai-github-maintainer",
    });
    expect(typeof entry.time).toBe("string");
  });

  it("redacts secrets", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        token: "ghs_x",
        auth: { password: "p", privateKey: "k" },
        req: { headers: { authorization: "Basic abc" } },
      },
      "secret stuff",
    );
    const text = lines.join("");
    for (const secret of ["ghs_x", '"p"', '"k"', "Basic abc"]) expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  });
});
