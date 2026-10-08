/**
 * The webview half of the board API.
 *
 * The Rust side (src-tauri/src/board_api.rs) accepts an agent's HTTP request
 * and hands it over as a `board-api` event; this module runs it against the
 * live board and answers through `board_api_reply`. The MCP server in
 * `mcp/server.mjs` is one client of it — anything that can read the token file
 * and speak HTTP is another.
 *
 * Every method that adds something adds a *proposal*: the user keeps it with
 * Ctrl+Enter or drops it with Esc. An agent proposes to the board; it never changes it.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectContext } from "./project";
import type { AgentEdge, AgentNode, WhiteboardHandle } from "./types";

interface BoardCall {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** What a request can reach, read fresh for every call. */
export interface BoardContext {
  /** the launch folder is open; before that the board is about to be replaced */
  ready: boolean;
  handle: WhiteboardHandle | null;
  project: ProjectContext | null;
  intent: string;
  cloud: boolean;
  setIntent: (text: string) => void;
  openFolder: (path: string) => Promise<void>;
  /** tell the shell a proposal arrived, and what it is called */
  onProposal: (title: string) => void;
}

/** The methods, named as the MCP tools name them. */
export const BOARD_METHODS = [
  "get_board",
  "add_nodes",
  "render_masterplan",
  "add_image",
  "export_png",
  "discard_proposal",
  "set_intent",
  "open_folder",
  "company_map",
  "plan_board",
] as const;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A remount (a folder switch) leaves the handle empty for a moment. */
async function board(get: () => BoardContext): Promise<WhiteboardHandle> {
  for (let i = 0; i < 40; i++) {
    const h = get().handle;
    if (h) return h;
    await new Promise((r) => window.setTimeout(r, 75));
  }
  throw new Error("the board is not ready");
}

/**
 * Right after launch the folder is still being opened, and opening it mounts a
 * fresh board. A proposal drawn onto the board before that would be drawn onto
 * one about to be thrown away — so every call waits for the real one.
 */
async function launched(get: () => BoardContext): Promise<void> {
  for (let i = 0; i < 200 && !get().ready; i++) {
    await new Promise((r) => window.setTimeout(r, 50));
  }
  if (!get().ready) throw new Error("Lucida is still opening its folder — try again in a moment");
  // one more frame, so the board for that folder has mounted
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export async function dispatch(call: BoardCall, get: () => BoardContext): Promise<unknown> {
  const p = call.params ?? {};
  await launched(get);
  switch (call.method) {
    case "get_board": {
      const ctx = get();
      const b = (await board(get)).agentBoard();
      return {
        folder: ctx.project?.path ?? null,
        project: ctx.project?.name ?? null,
        intent: ctx.intent || null,
        pictures: ctx.cloud ? "available (OpenRouter key set)" : "unavailable — no OpenRouter key in Lucida",
        ...b,
      };
    }
    case "add_nodes": {
      const nodes = (Array.isArray(p.nodes) ? p.nodes : []) as AgentNode[];
      const edges = (Array.isArray(p.edges) ? p.edges : []) as AgentEdge[];
      const r = (await board(get)).agentAddNodes(
        nodes.filter((n) => str(n?.text).trim()),
        edges.filter((e) => e && e.from !== undefined && e.to !== undefined),
      );
      if (r.count) get().onProposal(`${nodes.length} nodes`);
      return r;
    }
    case "render_masterplan": {
      const spec = p.spec ?? p;
      const r = await (await board(get)).agentRenderMasterplan(spec, { images: p.images !== false });
      get().onProposal(str((spec as { title?: unknown }).title) || "Masterplan");
      return r;
    }
    case "add_image": {
      const label = str(p.label);
      const r = await (await board(get)).agentAddImage(label, str(p.near) || undefined);
      get().onProposal(label);
      return r;
    }
    case "export_png": {
      const scope = p.scope === "board" || p.scope === "all" || p.scope === "map" || p.scope === "plan" ? p.scope : "proposal";
      const r = await (await board(get)).agentExport(scope);
      return { ...r, folder: get().project?.path ?? null };
    }
    case "discard_proposal":
      return { removed: (await board(get)).agentDiscard() };
    case "set_intent": {
      const text = str(p.text).trim();
      get().setIntent(text);
      return { intent: text };
    }
    case "open_folder": {
      const path = str(p.path).trim();
      if (!path) throw new Error("open_folder needs a path");
      await get().openFolder(path);
      await board(get);
      return { folder: get().project?.path ?? path };
    }
    case "company_map": {
      if (p.off === true) return (await board(get)).companyMap(null);
      const root = str(p.root).trim();
      if (!root) throw new Error("company_map needs the wiki folder");
      // The map of a wiki belongs on that folder's own board.
      if (get().project?.path !== root) {
        await get().openFolder(root);
      }
      const r = await (await board(get)).companyMap(root, p.restricted === true);
      return { ...r, folder: get().project?.path ?? root, live: true };
    }
    case "plan_board": {
      if (p.off === true) return (await board(get)).planBoard(null);
      const root = str(p.root).trim();
      if (!root) throw new Error("plan_board needs the folder holding wiki/plan");
      if (get().project?.path !== root) await get().openFolder(root);
      const look = p.look === "clean" || p.look === "heist" ? p.look : undefined;
      const r = await (await board(get)).planBoard(root, look);
      return { ...r, folder: get().project?.path ?? root, live: true };
    }
    default:
      throw new Error(`unknown method "${call.method}" — one of ${BOARD_METHODS.join(", ")}`);
  }
}

/** Start answering board API requests. Resolves to the unsubscribe function. */
export function connectBoardApi(get: () => BoardContext): Promise<() => void> {
  return listen<BoardCall>("board-api", async ({ payload }) => {
    let reply: { ok: boolean; result?: unknown; error?: string };
    try {
      reply = { ok: true, result: await dispatch(payload, get) };
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await invoke("board_api_reply", { id: payload.id, reply });
    } catch {
      // the request timed out on the Rust side; nobody is waiting any more
    }
  });
}
