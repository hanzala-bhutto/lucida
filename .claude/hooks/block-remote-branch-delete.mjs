// PreToolUse hook: refuse any shell command that would delete a remote branch.
// Remote branches in this repository are never deleted (see docs/WORKFLOW.md).
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const raw = String(input.tool_input?.command ?? "");

// Heredoc bodies (commit messages, PR descriptions) are text, not commands.
const command = raw.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");

// A rule only matches where a command starts: the beginning of a line, or
// after ; & | ( or $( — never inside an argument such as a quoted message.
const AT = String.raw`(?:^|[;&|(]|\$\()\s*`;
const RULES = [
  [String.raw`gh\s+pr\s+merge\b[^\n;&|]*\s(--delete-branch|-d)(\s|$)`, "gh pr merge --delete-branch"],
  [String.raw`git\s+push\b[^\n;&|]*\s(--delete|-d)(\s|=|$)`, "git push --delete"],
  [String.raw`git\s+push\b[^\n;&|]*\s\+?:[^\s]`, "git push <remote> :<branch>"],
  [String.raw`git\s+push\b[^\n;&|]*\s(--prune|--mirror)\b`, "git push --prune / --mirror"],
  [String.raw`gh\s+api\b(?=[^\n;&|]*(-X|--method)\s*DELETE)(?=[^\n;&|]*refs\/heads)`, "gh api DELETE refs/heads"],
].map(([body, name]) => [new RegExp(AT + body, "im"), name]);

const hit = RULES.find(([re]) => re.test(command));
if (hit) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Remote branches are never deleted in this repository (${hit[1]}). Merge without deleting the branch.`,
      },
    }),
  );
}
