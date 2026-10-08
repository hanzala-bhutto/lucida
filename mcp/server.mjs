#!/usr/bin/env node
/**
 * Lucida MCP server — lets an agent (Claude Code, Claude Desktop, anything that
 * speaks MCP) read the live board and propose to it.
 *
 *   claude mcp add --scope user lucida -- node /path/to/lucida/mcp/server.mjs
 *
 * Dependency-free on purpose: stdio JSON-RPC, one file, Node 18+. It holds no
 * board state and no API keys — it forwards each tool call to the running app's
 * board API (127.0.0.1:8767, token in %APPDATA%\Lucida\board-api.json), and
 * the app generates pictures with its own OpenRouter key.
 *
 * Everything an agent adds arrives as a proposal the user keeps with Ctrl+Enter
 * or drops with Esc.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const TOKEN_FILE = join(APPDATA, "Lucida", "board-api.json");
/** Lucida.exe: LUCIDA_APP, else the per-user install, the per-machine install, or a local release build. */
const APP_CANDIDATES = process.env.LUCIDA_APP
  ? [process.env.LUCIDA_APP]
  : [
      join(LOCALAPPDATA, "Lucida", "Lucida.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Lucida", "Lucida.exe"),
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "target", "release", "lucida.exe"),
    ];
const SERVER = { name: "lucida", version: "0.2.0" };

/* ───────────────────────────  Tools  ─────────────────────────── */

const KPI = {
  type: "object",
  properties: {
    value: { type: "string", description: 'The number as it should read: "< 50 ms", "99 %", "3", "€ 1,2 Mio"' },
    label: { type: "string", description: "What it measures, a few words" },
  },
  required: ["value", "label"],
};

/** A wiki folder to use when a call names none; otherwise the folder open in Lucida. */
const WIKI = process.env.LUCIDA_WIKI ?? "";

const TOOLS = [
  {
    name: "get_board",
    description:
      "Read the Lucida whiteboard that is open right now: its folder, the labelled nodes and arrows, pictures, " +
      "pending proposals and the visible area. Call this before adding anything, so you build on what is there.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "render_masterplan",
    description:
      "Turn a plan the user has explained into one finished infographic poster on the Lucida board, in the " +
      "organisation's house style set in Lucida (name, accent colour and logo from its settings; neutral without), " +
      "with a generated picture per phase. Phases become a numbered timeline (flow 'sequence') or side-by-side " +
      "pillars ('parallel'). It arrives as a proposal; the user keeps it with Ctrl+Enter. Pictures take ~20-40 s in total.\n\n" +
      "Writing the content: short headlines (≤ 8 words for phase titles, ≤ 13 for the title), concrete numbers " +
      "instead of adjectives, no buzzwords, points of ≤ 10 words. Use the user's language and set `lang` to match. " +
      "Only state numbers and facts the user gave you or " +
      "that you verified — never invent a KPI. 3-6 phases read best; 2-5 points each. An `image` is a concrete, " +
      "drawable object ('a server rack with a shield', 'a handshake over a contract'), never an abstraction.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The plan's headline" },
        subtitle: { type: "string", description: "One sentence: what the plan achieves" },
        eyebrow: { type: "string", description: 'Small line above the title; default "<ORGANISATION> · MASTERPLAN"' },
        flow: { type: "string", enum: ["sequence", "parallel"], description: "sequence = timeline, parallel = pillars" },
        lang: { type: "string", enum: ["de", "en"], description: "Language of the poster's own labels (Ziel/Goal)" },
        kpis: { type: "array", items: KPI, maxItems: 4, description: "Headline numbers across the top" },
        phases: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              period: { type: "string", description: '"Q1 2027", "Monat 1-3"' },
              summary: { type: "string", description: "One or two sentences" },
              points: { type: "array", items: { type: "string" }, maxItems: 5 },
              image: { type: "string", description: "A concrete object to draw for this phase" },
              kpi: KPI,
            },
            required: ["title"],
          },
        },
        goal: {
          type: "object",
          description: "Where it all leads — the dark band at the bottom",
          properties: { title: { type: "string" }, text: { type: "string" }, image: { type: "string" } },
          required: ["title"],
        },
        footer: { type: "string", description: "Bottom line, e.g. owner and date" },
        images: { type: "boolean", description: "Generate pictures (default true; needs the key in Lucida)" },
      },
      required: ["title", "phases"],
    },
  },
  {
    name: "add_nodes",
    description:
      "Propose plain diagram nodes and arrows, placed by Lucida's flow-aware layout next to what is already drawn. " +
      "Edges refer to nodes by their index in this call, or by the id of a node already on the board (see get_board).",
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              kind: { type: "string", enum: ["rectangle", "ellipse", "diamond", "text"] },
            },
            required: ["text"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: ["integer", "string"] },
              to: { type: ["integer", "string"] },
              label: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["nodes"],
    },
  },
  {
    name: "add_image",
    description:
      "Propose one generated picture in the style chosen in Lucida's panel — below an existing node (`near`: its id) " +
      "or beside the drawing. ~17 s.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "What to draw, as a concrete object" },
        near: { type: "string", description: "Id of a node to place it under" },
      },
      required: ["label"],
    },
  },
  {
    name: "export_png",
    description:
      "Render the pending proposal (default), the accepted board, or both to a PNG file at 2x, and show it to you so " +
      "you can check the result. Look at it: fix overflowing text or weak wording and render again before telling " +
      "the user it is done.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["proposal", "board", "all", "map", "plan"], description: "map = the live company map, plan = the live masterplan" },
        path: { type: "string", description: "Where to write the PNG; default <board folder>/.lucida/exports/" },
      },
    },
  },
  {
    name: "company_map",
    description:
      "Put the live company map of a wiki folder (<folder>/wiki/entities/*.md) on its board: team, products, customers, " +
      "pipeline, partners, investors & advisors, technology, strategy, competition — every entity page, grouped by " +
      "its tags, with the index's one-liner on the most-cited ones and a dot on pages changed in the last 3 days. " +
      "It stays live: while Lucida is open it redraws itself within seconds of any wiki change, and it picks that up " +
      "again whenever the board is reopened. Only frontmatter and index.md are read; `access: leadership` pages are " +
      "left off unless `restricted` is true (never for a shared screen). `off: true` removes it.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "The wiki folder (it holds wiki/); default: the folder open in Lucida" },
        restricted: { type: "boolean", description: "Include access: leadership pages" },
        off: { type: "boolean", description: "Take the live map off the board" },
      },
    },
  },
  {
    name: "plan_board",
    description:
      "Put the live masterplan of a folder on its board: the goal with a countdown, the crew, fronts × horizons " +
      "as a grid of cards (status, owner, due, what each waits on), open decisions, risks with the cards they threaten, " +
      "and the processes as lanes. The single source of truth is wiki/plan/*.md — one small file per item, structure in " +
      "the frontmatter (kind, front, horizon, status, owner, date, depends_on, affects, order). Edits on the board " +
      "(drag a card to another cell, drop a name on a card, draw an arrow, type a title, write a word into a cell) write " +
      "those files; editing a file redraws the board within ~2 s. To change the plan yourself, edit the files directly — " +
      "never duplicate the plan elsewhere. `off: true` removes it from the board (files stay).",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "The folder holding wiki/plan/; default: the folder open in Lucida" },
        look: { type: "string", enum: ["heist", "clean"], description: "heist (default): cork wall, pinned cards, red string · clean: the plain grid" },
        off: { type: "boolean" },
      },
    },
  },
  {
    name: "discard_proposal",
    description: "Remove what you proposed and the user has not kept. Their own drawing is never touched.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_intent",
    description: "Set the board's stated intent — the one line every suggestion and picture on it is steered by.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "open_folder",
    description:
      "Switch the board to another folder. Each folder has its own board in <folder>/.lucida/, and Lucida reads that " +
      "folder's AGENTS.md / CLAUDE.md for vocabulary. Defaults to the directory this session runs in.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

/* ───────────────────────────  Board API client  ─────────────────────────── */

function readToken() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Find the running app, starting it on `folder` if nothing answers. */
async function connection(folder) {
  const t = readToken();
  if (t && (await healthy(t.port))) return t;
  const app = APP_CANDIDATES.find((p) => existsSync(p));
  if (!app) {
    throw new Error(
      `Lucida is not running, and Lucida.exe was not found (looked in ${APP_CANDIDATES.join(", ")}). ` +
        "Install it, build it with `npm run tauri build`, or set LUCIDA_APP.",
    );
  }
  spawn(app, [folder ?? process.cwd()], { stdio: "ignore", detached: true }).unref();
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    const t2 = readToken();
    if (t2 && (await healthy(t2.port))) {
      // the webview needs a moment after the server binds
      await new Promise((r) => setTimeout(r, 1500));
      return t2;
    }
  }
  throw new Error("Started Lucida, but its board API did not come up within 30 s.");
}

async function call(method, params = {}, folder) {
  const t = await connection(folder);
  const res = await fetch(`http://127.0.0.1:${t.port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(320_000),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.result;
}

/* ───────────────────────────  Tool handlers  ─────────────────────────── */

const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

function slug(s) {
  return (
    String(s || "board")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "board"
  );
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

let lastTitle = "";

/** The folder to work on: the one named, LUCIDA_WIKI, else the one open in Lucida. */
async function wikiRoot(named) {
  if (named) return resolve(named);
  if (WIKI) return resolve(WIKI);
  const b = await call("get_board");
  if (!b.folder) throw new Error("Lucida has no folder open — pass `root`, or open one in Lucida first.");
  return b.folder;
}

async function runTool(name, args = {}) {
  switch (name) {
    case "get_board":
      return [text(await call("get_board"))];

    case "render_masterplan": {
      const { images, ...spec } = args;
      lastTitle = spec.title ?? "";
      const r = await call("render_masterplan", { spec, images });
      const lines = [
        `Proposed "${spec.title}" on the board: ${r.count} elements.`,
        r.images && (r.images.placed || r.images.failed)
          ? `Pictures: ${r.images.placed} drawn, ${r.images.failed} failed${r.images.errors?.length ? ` (${r.images.errors.join("; ")})` : ""}.`
          : null,
        r.notes?.length ? `Notes: ${r.notes.join("; ")}.` : null,
        "The user keeps it with Ctrl+Enter or drops it with Esc. Call export_png to look at it before calling it done.",
      ].filter(Boolean);
      return [text(lines.join("\n"))];
    }

    case "add_nodes":
      return [text(await call("add_nodes", { nodes: args.nodes ?? [], edges: args.edges ?? [] }))];

    case "add_image":
      return [text(await call("add_image", { label: args.label, near: args.near }))];

    case "export_png": {
      const r = await call("export_png", { scope: args.scope ?? "proposal" });
      const base = r.folder ? join(r.folder, ".lucida", "exports") : join(homedir(), "Downloads");
      const out = args.path ? resolve(args.path) : join(base, `${slug(r.title || lastTitle || "board")}-${stamp()}.png`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(r.png, "base64"));
      return [
        text(`Wrote ${out} (${r.width}×${r.height} px).`),
        { type: "image", data: r.preview, mimeType: "image/png" },
      ];
    }

    case "company_map": {
      const root = await wikiRoot(args.root);
      const r = await call("company_map", { root, restricted: args.restricted === true, off: args.off === true }, root);
      if (args.off) return [text(`Removed the company map (${r.count} elements).`)];
      return [
        text(
          `Company map is live on the board of ${r.folder}: ${r.count} elements. It redraws itself when the wiki changes. ` +
            "Call export_png with scope \"map\" to look at it or share it.",
        ),
      ];
    }

    case "plan_board": {
      const root = await wikiRoot(args.root);
      const r = await call("plan_board", { root, look: args.look, off: args.off === true }, root);
      if (args.off) return [text(`Removed the masterplan board (${r.count} elements); wiki/plan/ is untouched.`)];
      return [
        text(
          `Masterplan is live on the board of ${r.folder}: ${r.count} elements from ${root}/wiki/plan/. ` +
            "Board edits write those files and file edits redraw the board. Call export_png with scope \"plan\" to see it.",
        ),
      ];
    }

    case "discard_proposal":
      return [text(await call("discard_proposal"))];

    case "set_intent":
      return [text(await call("set_intent", { text: args.text ?? "" }))];

    case "open_folder": {
      const path = resolve(args.path || process.cwd());
      return [text(await call("open_folder", { path }, path))];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ───────────────────────────  MCP over stdio  ─────────────────────────── */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: SERVER,
            instructions:
              "Lucida is the user's local whiteboard. To turn an explained plan into a visual, call render_masterplan, " +
              "then export_png and look at the result. Everything you add is a proposal the user keeps with Ctrl+Enter.",
          },
        });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        try {
          const content = await runTool(params?.name, params?.arguments ?? {});
          return send({ jsonrpc: "2.0", id, result: { content } });
        } catch (err) {
          return send({
            jsonrpc: "2.0",
            id,
            result: { content: [text(String(err?.message ?? err))], isError: true },
          });
        }
      }
      default:
        if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  void onMessage(msg);
});
