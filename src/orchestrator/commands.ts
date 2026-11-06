/**
 * `/ai` command parsing. Only these exact commands are recognised; nothing in a
 * comment is ever executed. The command must be the first non-empty line, so a
 * quoted or mentioned "/ai approve" in ordinary discussion never counts.
 */
export type Command =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "revise"; instructions: string }
  | { kind: "invalid"; reason: string };

export const COMMAND_HELP =
  "Supported commands: `/ai approve`, `/ai reject`, `/ai revise <what to change>`.";

export function parseCommand(body: string): Command | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1) return null;
  const line = lines[first]!.trim();
  const match = /^\/ai(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(line);
  if (!match) return null;
  const verb = (match[1] ?? "").toLowerCase();
  const rest = [match[2] ?? "", ...lines.slice(first + 1)].join("\n").trim();
  switch (verb) {
    case "approve":
    case "reject":
      return rest
        ? { kind: "invalid", reason: `\`/ai ${verb}\` takes no arguments` }
        : { kind: verb };
    case "revise":
      return rest
        ? { kind: "revise", instructions: rest.slice(0, 4000) }
        : {
            kind: "invalid",
            reason: "`/ai revise` needs instructions, e.g. `/ai revise also handle X`",
          };
    default:
      return {
        kind: "invalid",
        reason: verb ? `unknown command \`/ai ${verb}\`` : "missing command",
      };
  }
}
