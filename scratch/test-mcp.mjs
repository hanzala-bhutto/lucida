/**
 * MCP server handshake (run: node scratch/test-mcp.mjs).
 *
 * Speaks to mcp/server.mjs over stdio exactly as Claude Code does: initialize,
 * list the tools, and one call that must fail cleanly — not crash — when the
 * app is unreachable. Needs no running Lucida.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

// Point the server at an app that does not exist, so the call cannot launch one.
const child = spawn(process.execPath, [join(here, "../mcp/server.mjs")], {
  env: { ...process.env, LUCIDA_APP: "C:\\nonexistent\\Lucida.exe", APPDATA: join(here, ".mcp-test-home") },
  stdio: ["pipe", "pipe", "inherit"],
});
const waiting = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});
let next = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
check("initialize: echoes the protocol version", init.result?.protocolVersion === "2025-06-18");
check("initialize: offers tools", !!init.result?.capabilities?.tools);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name);
for (const n of ["get_board", "render_masterplan", "add_nodes", "add_image", "export_png", "discard_proposal", "set_intent", "open_folder", "company_map", "plan_board"]) {
  check(`tools/list: ${n}`, names.includes(n));
}
const rm = list.result.tools.find((t) => t.name === "render_masterplan");
check("render_masterplan: title and phases required", JSON.stringify(rm.inputSchema.required) === '["title","phases"]');

const call = await rpc("tools/call", { name: "get_board", arguments: {} });
check("tools/call without the app: an error result, not a crash", call.result?.isError === true, call.result?.content?.[0]?.text);

const unknown = await rpc("no/such/method", {});
check("unknown method: JSON-RPC error", unknown.error?.code === -32601);

child.kill();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
