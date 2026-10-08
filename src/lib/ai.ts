/**
 * AI suggestion engine.
 *
 * Pure logic, no React: it (1) summarizes the current Excalidraw scene into a
 * compact JSON the model can reason about, (2) asks the model — the local llama.cpp
 * sidecar by default, OpenRouter when opted in — for the next 1-3 useful
 * elements, (3) turns those suggestions into Excalidraw element skeletons the
 * canvas can convert + ghost-render, and (4) generates a picture for a label
 * (Illustrate, cloud only). It never throws on bad model output — a failed
 * parse yields an empty suggestion list.
 */
import type {
  SceneSummary,
  NodeInfo,
  EdgeInfo,
  Suggestion,
  SuggestionKind,
  SuggestionFeedback,
  SuggestOptions,
  SuggestTier,
  RequestTarget,
  IllustrateSubject,
  IllustrateOptions,
  IllustrationStyle,
  IllustrationResult,
  KeyCheck,
  CloudTransport,
  GateResult,
  Point,
  AiConfig,
  ExcalidrawElementSkeleton,
} from "./types";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_BASE_URL,
  OPENROUTER_BASE_URL,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_CLOUD_FAST_MODEL,
  DEFAULT_CLOUD_IMAGE_MODEL,
  ILLUSTRATION_QUALITY,
  APP_ATTRIBUTION,
  DEFAULT_GATE_MODEL,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_IMAGES_URL,
  PRIVACY_ZDR,
  PRIVACY_NO_TRAINING,
} from "./config";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/* ───────────────────────────  1. summarizeScene  ─────────────────────────── */

/** Element types that become scene nodes (everything else is structural ink). */
const NODE_TYPES = new Set(["rectangle", "ellipse", "diamond", "text"]);

/**
 * Reduce a live scene to the minimal graph the model needs: labeled boxes /
 * ellipses / diamonds / text as nodes, and bound arrows as directed edges.
 */
export function summarizeScene(
  elements: readonly NonDeletedExcalidrawElement[],
  intent?: string,
  history?: readonly SuggestionFeedback[],
  spoken?: string,
  project?: string,
): SceneSummary {
  const nodes: NodeInfo[] = [];
  const edges: EdgeInfo[] = [];

  // Index text elements by the shape they label, so a shape can borrow its
  // bound caption. Standalone text (no container) is emitted as its own node.
  const labelByContainer = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId) {
      labelByContainer.set(el.containerId, el.text);
    }
  }

  for (const el of elements) {
    if (!NODE_TYPES.has(el.type)) continue;
    if (el.type === "text") {
      if (el.containerId) continue; // already folded into its container's label
      nodes.push({
        id: el.id,
        type: "text",
        text: el.text,
        x: Math.round(el.x),
        y: Math.round(el.y),
        w: Math.round(el.width),
        h: Math.round(el.height),
      });
      continue;
    }
    nodes.push({
      id: el.id,
      type: el.type,
      text: labelByContainer.get(el.id) ?? "",
      x: Math.round(el.x),
      y: Math.round(el.y),
      w: Math.round(el.width),
      h: Math.round(el.height),
    });
  }

  for (const el of elements) {
    if (el.type !== "arrow") continue;
    const from = el.startBinding?.elementId;
    const to = el.endBinding?.elementId;
    if (from && to) {
      // Carry the arrow's bound label — edge labels often hold the diagram's
      // actual semantics ("approves", the yes/no on a decision branch).
      const label = labelByContainer.get(el.id);
      edges.push(label ? { from, to, label } : { from, to });
    }
  }

  const summary: SceneSummary = { nodes, edges };
  if (intent) summary.intent = intent;
  const recent = recentNodeIds(elements, nodes);
  if (recent.length) summary.recent = recent;
  if (history && history.length) summary.history = history.slice(0, MAX_HISTORY);
  if (spoken?.trim()) summary.spoken = spoken.trim();
  if (project?.trim()) summary.project = project.trim();
  return summary;
}

const MAX_RECENT = 5;
const MAX_HISTORY = 8;

/**
 * The nodes the user touched last, newest first. Excalidraw stamps `updated`
 * on every element; when that is missing (tests, imported scenes) fall back
 * to array order, which is creation order.
 */
function recentNodeIds(
  elements: readonly NonDeletedExcalidrawElement[],
  nodes: readonly NodeInfo[],
): string[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const stamped = elements
    .filter((el) => nodeIds.has(el.id))
    .map((el) => ({ id: el.id, t: (el as { updated?: number }).updated }));
  const haveStamps = stamped.some((s) => typeof s.t === "number");
  const ordered = haveStamps
    ? stamped.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
    : stamped.slice().reverse();
  return ordered.slice(0, MAX_RECENT).map((s) => s.id);
}

/* ───────────────────────────  2. suggestNext  ─────────────────────────── */

const ALLOWED_KINDS: ReadonlySet<string> = new Set<SuggestionKind>([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
]);

const MAX_SUGGESTIONS = 3;
const MAX_AUTO_SUGGESTIONS = 2;

const SYSTEM_PROMPT = [
  "You are a diagramming copilot inside a smart whiteboard.",
  "You are given the current diagram as JSON (nodes have ids, types, text, and",
  "bounding boxes; edges are directed arrows between node ids).",
  '"recent" lists the node ids the user drew last, newest first — the idea is',
  'usually growing there. "history" lists earlier suggestions and whether the',
  "user accepted or dismissed them: do not repeat a dismissed one, and continue",
  "the direction of accepted ones.",
  '"project" describes the codebase this board is open in, taken from that',
  "project's own instructions to agents. Use its words for labels — a node in",
  'a repo that calls something "Guardian" must be labelled "Guardian", never',
  '"Security Module".',
  '"spoken", when present, is what the user has been SAYING out loud while',
  "drawing — the strongest signal of what comes next. Turn the things they name",
  'into nodes, in their words. "hint" is a short steer about the likely next',
  "element kind; follow it unless the diagram clearly says otherwise.",
  "Propose the 1-3 most useful NEXT elements to help express the idea. Prefer",
  "completing obvious structures (flows, hierarchies, groupings) and connect new",
  "nodes to the diagram with arrows. Keep labels short, in the language the",
  "diagram already uses.",
  "",
  "Return STRICT JSON only — no prose, no code fences. Exact schema:",
  '{ "suggestions": [ { "kind": "rectangle"|"ellipse"|"diamond"|"text"|"arrow",',
  '  "text"?: string, "x"?: number, "y"?: number, "w"?: number, "h"?: number,',
  '  "from"?: string, "to"?: string, "rationale"?: string, "confidence": number } ] }',
  "",
  '"confidence" is 0..1: how sure you are the user wants exactly this next.',
  'For arrows, "from"/"to" must be either an existing node id from the input, or',
  '"new:<index>" referencing another suggestion in THIS array by its position',
  "(0-based). Always omit x/y/w/h — the canvas places nodes next to the ones the",
  "user drew last, in the direction the diagram already flows.",
  "",
  "Example — input:",
  '{"nodes":[{"id":"a","type":"rectangle","text":"Build","x":0,"y":0,"w":160,"h":80}],"edges":[]}',
  "Example — output:",
  '{"suggestions":[{"kind":"rectangle","text":"Test","rationale":"next CI stage","confidence":0.8},' +
    '{"kind":"arrow","from":"a","to":"new:0","rationale":"Build flows into Test","confidence":0.8}]}',
].join("\n");

/** Appended to the system prompt on the fast tier (auto-suggest after pen-up). */
const FAST_ADDENDUM = [
  "Auto mode: the user just lifted the pen and did not ask for help.",
  "Propose at most 2 elements, and only when the continuation is obvious from",
  "the shape of the diagram. When nothing is clearly next, return",
  '{"suggestions":[]} — an empty list is a good answer here.',
].join("\n");

/**
 * The response shape the cloud tier is constrained to. Strict mode wants every
 * key present, so optional fields are nullable — validateSuggestion() treats
 * null exactly like a missing key.
 */
export const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "text",
          "x",
          "y",
          "w",
          "h",
          "from",
          "to",
          "rationale",
          "confidence",
        ],
        properties: {
          kind: { type: "string", enum: [...ALLOWED_KINDS] },
          text: { type: ["string", "null"] },
          x: { type: ["number", "null"] },
          y: { type: ["number", "null"] },
          w: { type: ["number", "null"] },
          h: { type: ["number", "null"] },
          from: { type: ["string", "null"] },
          to: { type: ["string", "null"] },
          rationale: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

/**
 * Where one request goes. Pure and exported so the routing (local vs cloud,
 * fast vs full model, auth header) is testable without a network.
 * Throws when the cloud provider is selected without a key — the UI disables
 * the buttons in that state, so reaching this is a bug, not a user error.
 */
export function resolveTarget(
  cfg: AiConfig,
  tier: SuggestTier = "full",
): RequestTarget {
  if (cfg.provider === "openrouter") {
    const apiKey = cfg.cloud?.apiKey?.trim() ?? "";
    if (!apiKey) throw new Error("OpenRouter API key missing");
    const model =
      (tier === "fast" ? cfg.cloud.fastModel : cfg.cloud.model)?.trim() ||
      (tier === "fast" ? DEFAULT_CLOUD_FAST_MODEL : DEFAULT_CLOUD_MODEL);
    return {
      provider: "openrouter",
      url: `${OPENROUTER_BASE_URL}/chat/completions`,
      headers: cloudHeaders(apiKey, cfg.cloud.transport ?? DEFAULT_TRANSPORT),
      model,
      structured: true,
    };
  }
  // Tolerate a partial config: fall back to the shared defaults.
  return {
    provider: "local",
    url: (cfg.baseUrl || DEFAULT_AI_BASE_URL) + "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    model: cfg.model || DEFAULT_AI_MODEL,
    structured: false,
  };
}

/**
 * Ask the model for the next elements. Network/HTTP failures reject;
 * malformed model output resolves to an empty list (never throws on parse).
 */
export async function suggestNext(
  scene: SceneSummary,
  cfg: AiConfig,
  opts: SuggestOptions = {},
): Promise<Suggestion[]> {
  const tier: SuggestTier = opts.tier ?? "full";
  const target = resolveTarget(cfg, tier);

  const userParts = [JSON.stringify(scene)];
  if (scene.intent) {
    userParts.push(
      `The user's stated intent is: "${scene.intent}". Prioritise elements that advance this intent.`,
    );
  }
  const system =
    tier === "fast" ? `${SYSTEM_PROMPT}\n\n${FAST_ADDENDUM}` : SYSTEM_PROMPT;

  const body: Record<string, unknown> = {
    model: target.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ],
    temperature: tier === "fast" ? 0.2 : 0.4,
    max_tokens: tier === "fast" ? 400 : 700,
    stream: false,
  };
  if (target.provider === "openrouter") body.provider = cfg.cloud.zdr === false ? PRIVACY_NO_TRAINING : PRIVACY_ZDR;
  if (target.structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "lucida_suggestions", strict: true, schema: SUGGESTION_SCHEMA },
    };
  }

  const res = await tauriFetch(target.url, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) throw new Error(await describeHttpError(res));

  let content: unknown;
  try {
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    content = data.choices?.[0]?.message?.content;
  } catch (err) {
    if (import.meta.env?.DEV) {
      console.warn("suggestNext: failed to parse model response", err);
    }
    return [];
  }
  if (typeof content !== "string") return [];

  const cap = tier === "fast" ? MAX_AUTO_SUGGESTIONS : MAX_SUGGESTIONS;
  const list = parseSuggestions(content, cap);
  return opts.minConfidence === undefined
    ? list
    : filterByConfidence(list, opts.minConfidence);
}

/**
 * Turn a failed response into one readable line. OpenRouter puts the reason
 * ("invalid key", "insufficient credits", "model not found") in the body, and
 * that is the line the user needs to see in the toast.
 */
async function describeHttpError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      detail = j.error?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // no body — status alone will have to do
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 160);
  return `AI request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`;
}

/**
 * Keep only suggestions the model is at least `min` sure about. Items without
 * a confidence are dropped too — the auto tier must never interrupt a drawing
 * with a guess the model did not rate. Arrow references are re-pointed at the
 * compacted positions, exactly like parseSuggestions().
 */
export function filterByConfidence(list: readonly Suggestion[], min: number): Suggestion[] {
  const kept = list
    .map((sug, orig) => ({ sug, orig }))
    .filter(({ sug }) => typeof sug.confidence === "number" && sug.confidence >= min);
  return compact(kept, list.length);
}

/**
 * Strip code fences, isolate the first balanced JSON value (object OR array),
 * validate, and cap to 3. Exported for tests. The model is asked for
 * `{ "suggestions": [...] }`, but smaller models sometimes drop the wrapper and
 * return a bare array — both shapes are accepted.
 */
export function parseSuggestions(raw: string, cap = MAX_SUGGESTIONS): Suggestion[] {
  const fenced = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const jsonText = firstBalancedJson(fenced);
  if (!jsonText) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];

  // Validate while remembering each item's ORIGINAL model index. The model's
  // "new:<i>" arrow references point at positions in its own array, so when we
  // drop invalid items or cap the list we must rewrite those references to the
  // compacted output positions — otherwise arrows silently desync (go missing
  // or bind to the wrong node).
  const kept: Array<{ sug: Suggestion; orig: number }> = [];
  list.forEach((item, orig) => {
    const sug = validateSuggestion(item);
    if (sug) kept.push({ sug, orig });
  });
  return compact(kept, cap);
}

/** Cap a validated list and rewrite "new:<i>" arrow refs to the surviving positions. */
function compact(
  kept: ReadonlyArray<{ sug: Suggestion; orig: number }>,
  cap: number,
): Suggestion[] {
  const capped = kept.slice(0, cap);

  const remap = new Map<number, number>();
  capped.forEach((k, i) => remap.set(k.orig, i));
  const fixRef = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    const m = /^new:(\d+)$/.exec(ref);
    if (!m) return ref; // an existing scene-node id — leave untouched
    const mapped = remap.get(Number(m[1]));
    return mapped === undefined ? undefined : `new:${mapped}`; // drop dangling refs
  };

  return capped.map(({ sug }) =>
    sug.kind === "arrow"
      ? { ...sug, from: fixRef(sug.from), to: fixRef(sug.to) }
      : sug,
  );
}

/** Coerce one raw model item into a Suggestion, or null if it is unusable. */
function validateSuggestion(item: unknown): Suggestion | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const kind = rec.kind;
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind)) return null;

  const sug: Suggestion = { kind: kind as SuggestionKind };
  if (typeof rec.text === "string") sug.text = rec.text;
  if (typeof rec.rationale === "string") sug.rationale = rec.rationale;
  if (typeof rec.from === "string") sug.from = rec.from;
  if (typeof rec.to === "string") sug.to = rec.to;
  const confidence = coerceNumber(rec.confidence);
  if (confidence !== undefined) sug.confidence = Math.min(1, Math.max(0, confidence));

  const x = coerceNumber(rec.x);
  const y = coerceNumber(rec.y);
  const w = coerceNumber(rec.w);
  const h = coerceNumber(rec.h);
  if (x !== undefined) sug.x = x;
  if (y !== undefined) sug.y = y;
  if (w !== undefined) sug.w = w;
  if (h !== undefined) sug.h = h;

  return sug;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Return the first balanced JSON value ({...} or [...]) substring, or null. */
function firstBalancedJson(s: string): string | null {
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/* ───────────────────────────  3. suggestionsToSkeletons  ─────────────────────────── */

const FALLBACK_W = 160;
const FALLBACK_H = 80;
const TEXT_H = 30;
const FALLBACK_GAP = 100;
const MIN_GAP = 40;
const COLLISION_MARGIN = 12;

/** A resolved node box for a non-arrow suggestion, keyed by its batch index. */
interface PlacedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: SuggestionKind;
  text?: string;
}

/** What the existing diagram tells us about how to grow it. */
export interface Layout {
  /** unit step of the dominant flow: right, down, left or up. */
  dir: [number, number];
  /** typical shape size — new nodes match the user's, not a constant. */
  w: number;
  h: number;
  /** typical distance between connected nodes along the flow. */
  gap: number;
}

function median(xs: readonly number[], fallback: number): number {
  if (!xs.length) return fallback;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function axisDir(vx: number, vy: number): [number, number] | null {
  if (!vx && !vy) return null;
  return Math.abs(vx) >= Math.abs(vy) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vy) || 1];
}

/**
 * Read flow direction, node size and spacing off the scene. Direction comes
 * from the arrows (sum of from→to vectors); without arrows, from the order the
 * last two nodes were drawn in; default is rightwards. Exported for tests.
 */
export function inferLayout(scene: SceneSummary): Layout {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const shapes = scene.nodes.filter((n) => n.type !== "text");
  const w = median(shapes.map((n) => n.w), FALLBACK_W);
  const h = median(shapes.map((n) => n.h), FALLBACK_H);

  let dx = 0;
  let dy = 0;
  const gaps: number[] = [];
  for (const e of scene.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const vx = b.x + b.w / 2 - (a.x + a.w / 2);
    const vy = b.y + b.h / 2 - (a.y + a.h / 2);
    dx += vx;
    dy += vy;
    const gap =
      Math.abs(vx) >= Math.abs(vy)
        ? vx > 0
          ? b.x - (a.x + a.w)
          : a.x - (b.x + b.w)
        : vy > 0
          ? b.y - (a.y + a.h)
          : a.y - (b.y + b.h);
    if (gap > 0) gaps.push(gap);
  }

  let dir: [number, number] | null = scene.edges.length ? axisDir(dx, dy) : null;
  if (!dir && scene.recent && scene.recent.length >= 2) {
    const prev = byId.get(scene.recent[1]);
    const last = byId.get(scene.recent[0]);
    if (prev && last) dir = axisDir(last.x - prev.x, last.y - prev.y);
  }
  return { dir: dir ?? [1, 0], w, h, gap: Math.max(MIN_GAP, median(gaps, FALLBACK_GAP)) };
}

function overlaps(a: Box, b: Box, margin: number): boolean {
  return (
    a.x < b.x + b.w + margin &&
    a.x + a.w + margin > b.x &&
    a.y < b.y + b.h + margin &&
    a.y + a.h + margin > b.y
  );
}

/** Box one step from `anchor` along `dir`, centred on the perpendicular axis. */
function stepFrom(anchor: Box, dir: [number, number], w: number, h: number, gap: number): Box {
  if (dir[0] !== 0) {
    const x = dir[0] > 0 ? anchor.x + anchor.w + gap : anchor.x - gap - w;
    return { x, y: anchor.y + anchor.h / 2 - h / 2, w, h };
  }
  const y = dir[1] > 0 ? anchor.y + anchor.h + gap : anchor.y - gap - h;
  return { x: anchor.x + anchor.w / 2 - w / 2, y, w, h };
}

/** Shift `box` perpendicular to the flow by k slots (k alternates sign as it grows). */
function sideStep(box: Box, dir: [number, number], k: number, gap: number): Box {
  return dir[0] !== 0
    ? { ...box, y: box.y + k * (box.h + gap / 2) }
    : { ...box, x: box.x + k * (box.w + gap / 2) };
}

/** Nudge `box` sideways until it clears every taken box (bounded search). */
function settle(box: Box, dir: [number, number], taken: readonly Box[], gap: number): Box {
  let candidate = box;
  for (let i = 1; i <= 8; i++) {
    if (!taken.some((t) => overlaps(candidate, t, COLLISION_MARGIN))) return candidate;
    candidate = sideStep(box, dir, Math.ceil(i / 2) * (i % 2 ? 1 : -1), gap);
  }
  return candidate;
}

/**
 * Turn suggestions into Excalidraw skeletons. Non-arrow nodes are emitted first
 * (so batch arrow bindings can reference their ids), then arrows.
 *
 * Placement follows the drawing: a node an arrow leads to sits one step along
 * the flow from its source (an existing node, or an earlier node of this
 * batch); a free node sits one step from the node drawn last. Sizes and gaps
 * are the median of what is already there, and a spot that would overlap is
 * nudged sideways. Coordinates the model insists on are honoured. Never throws.
 */
export function suggestionsToSkeletons(
  suggestions: Suggestion[],
  scene: SceneSummary,
): ExcalidrawElementSkeleton[] {
  const layout = inferLayout(scene);
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const toBox = (n: NodeInfo): Box => ({ x: n.x, y: n.y, w: n.w, h: n.h });
  const taken: Box[] = scene.nodes.map(toBox);

  // Where the idea is growing: the node drawn last, else the flow-most node.
  let growth: Box | null = null;
  const lastId = scene.recent?.[0];
  const lastNode = lastId ? byId.get(lastId) : undefined;
  if (lastNode) growth = toBox(lastNode);
  else if (scene.nodes.length) {
    const [ux, uy] = layout.dir;
    const score = (n: NodeInfo) => ux * (n.x + n.w) + uy * (n.y + n.h);
    growth = toBox(scene.nodes.reduce((a, b) => (score(b) > score(a) ? b : a)));
  }

  // Which batch node each arrow leads to / from, for anchoring.
  const inbound = new Map<number, string>(); // new:<i>  ←  from
  const outbound = new Map<number, string>(); // new:<i>  →  to
  for (const sug of suggestions) {
    if (sug.kind !== "arrow") continue;
    const toIdx = /^new:(\d+)$/.exec(sug.to ?? "");
    const fromIdx = /^new:(\d+)$/.exec(sug.from ?? "");
    if (toIdx && sug.from && !inbound.has(Number(toIdx[1]))) inbound.set(Number(toIdx[1]), sug.from);
    if (fromIdx && sug.to && !outbound.has(Number(fromIdx[1]))) outbound.set(Number(fromIdx[1]), sug.to);
  }

  // Pass 1 — resolve geometry + ids for every non-arrow suggestion.
  const placed = new Map<number, PlacedNode>();
  const nodeSkeletons: ExcalidrawElementSkeleton[] = [];
  let free = 0;

  const resolveRef = (ref: string): Box | null => {
    const m = /^new:(\d+)$/.exec(ref);
    if (m) {
      const p = placed.get(Number(m[1]));
      return p ? { x: p.x, y: p.y, w: p.w, h: p.h } : null;
    }
    const n = byId.get(ref);
    return n ? toBox(n) : null;
  };

  suggestions.forEach((sug, index) => {
    if (sug.kind === "arrow") return;

    const id = `sugg-${index}`;
    const isText = sug.kind === "text";
    const w = sug.w ?? (isText ? Math.max(80, (sug.text?.length ?? 0) * 9) : layout.w);
    const h = sug.h ?? (isText ? TEXT_H : layout.h);

    let box: Box;
    if (sug.x !== undefined && sug.y !== undefined) {
      box = { x: sug.x, y: sug.y, w, h };
    } else {
      const from = inbound.has(index) ? resolveRef(inbound.get(index)!) : null;
      const to = !from && outbound.has(index) ? resolveRef(outbound.get(index)!) : null;
      const back: [number, number] = [-layout.dir[0], -layout.dir[1]];
      let candidate: Box;
      if (from) candidate = stepFrom(from, layout.dir, w, h, layout.gap);
      else if (to) candidate = stepFrom(to, back, w, h, layout.gap);
      else if (growth) {
        candidate = stepFrom(growth, layout.dir, w, h, layout.gap);
        // several free nodes fan out perpendicular to the flow
        if (free > 0) candidate = sideStep(candidate, layout.dir, Math.ceil(free / 2) * (free % 2 ? 1 : -1), layout.gap);
        free++;
      } else {
        const o = scene.origin ?? { x: 200, y: 200 };
        candidate = { x: o.x + free * (w + layout.gap), y: o.y, w, h };
        free++;
      }
      box = settle(candidate, layout.dir, taken, layout.gap);
    }
    taken.push(box);

    placed.set(index, { id, ...box, kind: sug.kind, text: sug.text });

    if (sug.kind === "text") {
      // Carry the id so an arrow can bind to this text node by "new:<i>".
      nodeSkeletons.push({ type: "text", id, x: box.x, y: box.y, text: sug.text ?? "" });
    } else {
      // sug.kind is narrowed to "rectangle" | "ellipse" | "diamond" here.
      nodeSkeletons.push({
        type: sug.kind,
        id,
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        ...(sug.text ? { label: { text: sug.text } } : {}),
      });
    }
  });

  // Pass 2 — arrows. Resolve endpoints, compute boundary points, bind only to
  // batch nodes; existing scene nodes are connected geometrically.
  const arrowSkeletons: ExcalidrawElementSkeleton[] = [];

  for (const sug of suggestions) {
    if (sug.kind !== "arrow") continue;
    const source = resolveEndpoint(sug.from, placed, scene);
    const target = resolveEndpoint(sug.to, placed, scene);
    if (!source || !target) continue;

    const sc = boxCenter(source.box);
    const tc = boxCenter(target.box);
    const [startX, startY] = boundaryPoint(source.box, tc);
    const [endX, endY] = boundaryPoint(target.box, sc);

    arrowSkeletons.push({
      type: "arrow",
      x: startX,
      y: startY,
      points: [
        [0, 0],
        [endX - startX, endY - startY],
      ],
      ...(source.bindId ? { start: { id: source.bindId } } : {}),
      ...(target.bindId ? { end: { id: target.bindId } } : {}),
      ...(sug.text ? { label: { text: sug.text } } : {}),
    });
  }

  return [...nodeSkeletons, ...arrowSkeletons];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ResolvedEndpoint {
  box: Box;
  /** Present only when the endpoint is a node added in THIS batch (bindable). */
  bindId?: string;
}

/**
 * Resolve an arrow endpoint ref to a box. "new:<i>" hits the batch map (and is
 * bindable); a bare id is looked up in the existing scene (geometry only).
 */
function resolveEndpoint(
  ref: string | undefined,
  placed: Map<number, PlacedNode>,
  scene: SceneSummary,
): ResolvedEndpoint | null {
  if (!ref) return null;

  const m = /^new:(\d+)$/.exec(ref);
  if (m) {
    const node = placed.get(Number(m[1]));
    if (!node) return null;
    return { box: { x: node.x, y: node.y, w: node.w, h: node.h }, bindId: node.id };
  }

  const node = scene.nodes.find((n) => n.id === ref);
  if (!node) return null;
  return { box: { x: node.x, y: node.y, w: node.w, h: node.h } };
}

function boxCenter(b: Box): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/**
 * Point on box boundary along the ray from the box center toward `toward`.
 * Falls back to the center if the two points coincide.
 */
function boundaryPoint(b: Box, toward: [number, number]): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];

  const hw = b.w / 2;
  const hh = b.h / 2;
  // Scale the direction so it just touches the nearest box edge.
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return [cx + dx * t, cy + dy * t];
}

/* ───────────────────────────  4. illustrate  ─────────────────────────── */

/**
 * The looks a picture can have. Every prompt ends with the same guard rails so
 * a mind map full of them reads as one set, whatever the style.
 */
export const ILLUSTRATION_STYLES: Record<IllustrationStyle, { label: string; prompt: string }> = {
  // The organisation's own look, from the settings: its name and its one
  // accent colour. One accent only — a picture model given three produces mush.
  house: {
    label: "House",
    prompt:
      "Flat geometric vector illustration in the house style of {org}. One " +
      "subject, built from clean geometric forms with one even stroke weight " +
      "and generous negative space. Palette: cool charcoal greys from #111827 " +
      "to #6b7280 and exactly one accent colour, {accent}, used on one or two " +
      "key surfaces. No gradients, no shadows, no people's faces, no other " +
      "colours. Calm, precise, engineering-grade — it should read as a " +
      "well-made icon, not a poster.",
  },
  precise: {
    label: "Precise",
    prompt:
      "Precise technical illustration. One subject, drawn with engineering " +
      "clarity: thin even line weight, exact geometry, restrained forms, " +
      "generous empty space. Cool neutral greys with a single luminous cyan " +
      "accent used sparingly. A faint sense of depth, no heavy shading. It " +
      "should read as calm, modern and credible — the look of a well-made " +
      "instrument rather than a poster.",
  },
  flat: {
    label: "Flat",
    prompt:
      "Simple flat vector illustration, one subject, centered, clean outlines, soft muted palette.",
  },
  sketch: {
    label: "Sketch",
    prompt:
      "Loose pencil sketch, confident hand-drawn lines, light graphite shading, monochrome on white paper.",
  },
  doodle: {
    label: "Doodle",
    prompt:
      "Playful whiteboard-marker doodle, thick black outlines, two or three bright accent colors, a little wobbly.",
  },
  isometric: {
    label: "3D",
    prompt: "Isometric 3D illustration, soft shading, gentle pastel palette, clean edges.",
  },
  photo: {
    label: "Photo",
    prompt: "Photorealistic studio photograph of the subject, soft daylight, shallow depth of field.",
  },
};

const ILLUSTRATE_GUARDS =
  "The subject alone on an empty background, no scenery. No text, no letters, " +
  "no watermark, no frame. It will be placed on a whiteboard next to a word.";

export const DEFAULT_ILLUSTRATION_STYLE: IllustrationStyle = "precise";

/**
 * Prompt for one subject. The board's intent gives the domain ("Haus" in a
 * real-estate map ≠ in a fairy tale); a sketch is described by the model
 * itself, so the prompt only says how to treat it.
 */
export function buildIllustratePrompt(
  subject: IllustrateSubject,
  intent?: string,
  style: IllustrationStyle = DEFAULT_ILLUSTRATION_STYLE,
  house: { name?: string; accent?: string } = {},
): string {
  const label = subject.label?.trim();
  const context = intent?.trim() ? ` The diagram is about: ${intent.trim()}.` : "";
  const look = (ILLUSTRATION_STYLES[style] ?? ILLUSTRATION_STYLES.flat).prompt
    .replace("{org}", house.name?.trim() || "a modern technical company")
    .replace("{accent}", house.accent?.trim() || "#2563eb");

  // Editing is its own instruction: everything not named must survive, or
  // iterating turns into re-rolling and the picture drifts away from the board.
  if (subject.edit) {
    const what = subject.edit.instruction.trim();
    const subjectLine = label ? ` It shows "${label}".` : "";
    return (
      `The attached image is the current picture.${subjectLine} Change exactly this: ` +
      `${what}. Keep everything else identical — same subject, same composition, ` +
      `same colours, same style.${context} ${look} ${ILLUSTRATE_GUARDS}`
    );
  }

  let ask: string;
  if (subject.sketch && label) {
    ask = `The attached image is the user's own sketch or handwriting; it shows "${label}". Draw that.`;
  } else if (subject.sketch) {
    ask =
      "The attached image is the user's own handwriting or rough sketch. Read what it " +
      "says or shows, and draw that thing — not the handwriting itself.";
  } else {
    ask = `Draw "${label ?? ""}".`;
  }
  return `${ask}${context} ${look} ${ILLUSTRATE_GUARDS}`;
}

/**
 * Generate a picture for a label and/or the user's own ink. Cloud only — the
 * local llama.cpp sidecar is a text model.
 *
 * Image models live on OpenRouter's images endpoint, which rejects nothing and
 * returns raw base64; the chat endpoint refuses them by name. Three attempts,
 * each cheaper in assumptions than the last: the full request (transparent
 * background, high quality, square), then bare {model, prompt} for a model
 * that does not take those options, then the chat endpoint for a model that
 * only speaks chat. Rejects when all three fail.
 */
export async function illustrate(
  subject: IllustrateSubject,
  cfg: AiConfig,
  opts: IllustrateOptions = {},
): Promise<IllustrationResult> {
  if (cfg.provider !== "openrouter") {
    throw new Error("Illustrate needs the OpenRouter provider");
  }
  if (!subject.label?.trim() && !subject.sketch && !subject.edit) {
    throw new Error("Nothing to illustrate");
  }
  const target = resolveTarget(cfg, "full");
  const model = cfg.cloud.imageModel?.trim() || DEFAULT_CLOUD_IMAGE_MODEL;
  const prompt = buildIllustratePrompt(subject, opts.intent, opts.style, opts.house);
  const reference = subject.edit?.image ?? subject.sketch;
  const references = reference
    ? [{ type: "image_url", image_url: { url: reference } }]
    : undefined;

  const full = {
    model,
    prompt,
    n: 1,
    aspect_ratio: "1:1",
    // A picture on a whiteboard should not arrive in a white box.
    background: "transparent",
    output_format: "png",
    quality: ILLUSTRATION_QUALITY,
    ...(references ? { input_references: references } : {}),
  };
  const bare = { model, prompt, n: 1, ...(references ? { input_references: references } : {}) };
  // Zero Data Retention first; a model without a ZDR endpoint gets "no data
  // collection" instead. Never a request without either.
  const zdr = cfg.cloud.zdr !== false;
  const bodies: Record<string, unknown>[] = [
    ...(zdr ? [{ ...full, provider: PRIVACY_ZDR }] : []),
    { ...full, provider: PRIVACY_NO_TRAINING },
    ...(zdr ? [{ ...bare, provider: PRIVACY_ZDR }] : []),
    { ...bare, provider: PRIVACY_NO_TRAINING },
  ];

  let lastError = "";
  for (const body of bodies) {
    const res = await tauriFetch(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (res.ok) {
      const image = parseImagesResponse(await res.json());
      if (image) return image;
      lastError = `"${model}" returned no image`;
      continue;
    }
    lastError = (await describeHttpError(res)).replace(/^AI request failed: /, "");
    // A bad request about our optional fields is worth one plainer retry; an
    // auth or billing problem is not going to improve.
    if (res.status === 401 || res.status === 402 || res.status === 403) break;
  }

  // Last resort: a model that only exists on the chat endpoint.
  const chat = await illustrateViaChat(subject, target, model, prompt, opts.signal);
  if (chat) return chat;
  throw new Error(lastError || `"${model}" returned no image`);
}

/** The older chat-endpoint path, kept for models the images endpoint does not serve. */
async function illustrateViaChat(
  subject: IllustrateSubject,
  target: RequestTarget,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<IllustrationResult | null> {
  const content: unknown = subject.sketch
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: subject.sketch } },
      ]
    : prompt;
  try {
    const res = await tauriFetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
        stream: false,
        provider: PRIVACY_NO_TRAINING,
      }),
      signal,
    });
    if (!res.ok) return null;
    return parseImageDataUrl(await res.json());
  } catch {
    return null;
  }
}

/**
 * Read the images endpoint's answer: `data[]` entries carrying `b64_json` plus
 * a `media_type`. Exported for tests.
 */
export function parseImagesResponse(data: unknown): IllustrationResult | null {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const b64 = (row as { b64_json?: unknown })?.b64_json;
    if (typeof b64 !== "string" || !b64) continue;
    const raw = (row as { media_type?: unknown })?.media_type;
    const mime =
      raw === "image/jpeg" || raw === "image/webp" ? raw : "image/png";
    return { dataURL: `data:${mime};base64,${b64}`, mimeType: mime };
  }
  return null;
}

/**
 * No app attribution and no webview Origin: OpenRouter sees the key and
 * nothing else, which is also the variant that never hit the
 * 401 the attribution headers once caused.
 */
export const DEFAULT_TRANSPORT: CloudTransport = { attribution: false, origin: false };

/**
 * Request headers for OpenRouter under a given transport. `Origin: ""` is the
 * tauri-plugin-http (unsafe-headers) idiom for "send no Origin at all".
 */
export function cloudHeaders(apiKey: string, transport: CloudTransport): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey.trim()}`,
  };
  if (transport.attribution) {
    h["HTTP-Referer"] = APP_ATTRIBUTION.referer;
    h["X-Title"] = APP_ATTRIBUTION.title;
  }
  if (!transport.origin) h.origin = "";
  return h;
}

/** Header variants to try, most complete first. */
const TRANSPORT_VARIANTS: ReadonlyArray<{ name: string; transport: CloudTransport }> = [
  // Attribution is never sent any more; only the Origin header is probed.
  { name: "key only", transport: { attribution: false, origin: false } },
  { name: "with Origin", transport: { attribution: false, origin: true } },
];

/**
 * Probe a key the moment it is pasted: first the auth lookup, then a real
 * one-token inference with the exact production request. If inference is
 * refused while the lookup passed, retry with fewer optional headers and keep
 * the first variant OpenRouter accepts. Resolves for any HTTP answer; rejects
 * only when OpenRouter is unreachable.
 */
export async function checkKey(
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<KeyCheck> {
  const key = apiKey.trim();
  const steps: string[] = [];

  const auth = await tauriFetch(`${OPENROUTER_BASE_URL}/auth/key`, {
    headers: { authorization: `Bearer ${key}` },
    signal,
  });
  if (!auth.ok) {
    const message = (await describeHttpError(auth)).replace(/^AI request failed: /, "");
    steps.push(`auth/key: ${auth.status}`);
    return { ok: false, message, steps };
  }
  steps.push("auth/key: OK");
  let label: string | undefined;
  let management = false;
  try {
    const data = (await auth.json()) as {
      data?: { label?: unknown; is_provisioning_key?: unknown };
    };
    if (typeof data.data?.label === "string" && data.data.label) label = data.data.label;
    management = data.data?.is_provisioning_key === true;
  } catch {
    // label is cosmetic; a missing flag just means we learn it from inference
  }
  if (management) {
    steps.push("key type: management");
    return { ok: false, label, kind: "management", steps };
  }

  let lastMessage = "";
  for (const variant of TRANSPORT_VARIANTS) {
    const res = await tauriFetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: cloudHeaders(key, variant.transport),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    });
    if (res.ok) {
      steps.push(`inference (${variant.name}): OK`);
      return { ok: true, label, transport: variant.transport, steps };
    }
    lastMessage = (await describeHttpError(res)).replace(/^AI request failed: /, "");
    steps.push(`inference (${variant.name}): ${res.status}`);
    // Only an auth refusal is worth retrying with other headers; a 402 or a
    // 400 is about the account or the request, not the transport.
    if (res.status !== 401 && res.status !== 403) break;
  }
  return { ok: false, label, message: lastMessage, steps };
}

const DATA_URL_RE = /data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+/;

/**
 * Pull the first image out of a chat-completions response. OpenRouter's
 * documented shape is `message.images[].image_url.url` (a data URL); some
 * models inline the data URL in `message.content` instead, so both are read.
 * Exported for tests.
 */
export function parseImageDataUrl(data: unknown): IllustrationResult | null {
  const msg = (data as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: unknown }; url?: unknown }>;
        content?: unknown;
      };
    }>;
  })?.choices?.[0]?.message;
  if (!msg) return null;

  const candidates: unknown[] = [];
  for (const img of msg.images ?? []) {
    candidates.push(img?.image_url?.url, img?.url);
  }
  candidates.push(msg.content);

  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const m = DATA_URL_RE.exec(c);
    if (!m) continue;
    return { dataURL: m[0], mimeType: `image/${m[1]}` as IllustrationResult["mimeType"] };
  }
  return null;
}

/* ───────────────────────────  5. decision gate (Jev)  ─────────────────────────── */

/**
 * Criteria are read literally by the decision model, so each one is a
 * definition of the class and nothing else — no instructions, no hedging. When
 * a class is mispredicted in production, the fix is a sharper definition here,
 * not a friendlier prompt.
 */
const GATE_KINDS = {
  rectangle: "A process step, task, or named thing drawn as a box.",
  ellipse: "A start point, end point, actor, or external entity.",
  diamond: "A decision with two or more outgoing branches.",
  text: "A standalone label, heading, or annotation with no shape around it.",
  arrow: "A connection between two nodes that both already exist on the board.",
  none: "No element follows obviously from the current board.",
} as const;

const GATE_DIAGRAMS = {
  flowchart: "Steps connected by arrows in sequence, with a start and an end.",
  mindmap: "One central idea with branches radiating outwards.",
  hierarchy: "A tree: org chart, breakdown structure, or taxonomy.",
  timeline: "Events placed in time order along one axis.",
  freeform: "Loose sketch or notes with no recurring structure.",
} as const;

/** The compact state the gate reads — labels and structure, never coordinates. */
export function gateState(scene: SceneSummary): string {
  const labels = scene.nodes.map((n) => n.text.trim()).filter(Boolean);
  const parts = [
    `Diagram in progress with ${scene.nodes.length} nodes and ${scene.edges.length} arrows.`,
    labels.length ? `Node labels: ${labels.join(" | ")}.` : "No labels yet.",
  ];
  if (scene.recent?.length) {
    const last = scene.nodes.find((n) => n.id === scene.recent![0]);
    if (last) parts.push(`Last drawn: ${last.type}${last.text ? ` "${last.text}"` : ""}.`);
  }
  if (scene.project) parts.push(scene.project);
  if (scene.intent) parts.push(`Stated intent: ${scene.intent}.`);
  if (scene.spoken) parts.push(`User is saying: "${scene.spoken}"`);
  return parts.join(" ");
}

/**
 * Ask the System One model whether a next element is obvious, of what kind,
 * and what the drawing is becoming. ~100 ms, a fraction of a cent. Any
 * failure returns null and the caller proceeds as if there were no gate —
 * the gate may only make the board quieter, never break it.
 */
export async function gate(scene: SceneSummary, cfg: AiConfig, signal?: AbortSignal): Promise<GateResult | null> {
  if (cfg.provider !== "openrouter") return null;
  try {
    const target = resolveTarget(cfg, "fast");
    const res = await tauriFetch(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: DEFAULT_GATE_MODEL,
        state: gateState(scene),
        questions: {
          ready: {
            type: "noul",
            instructions:
              "Is there an obvious next element to add to this diagram right now, given its structure and what the user is saying?",
          },
          kind: { type: "choice", instructions: "What kind of element comes next?", criteria: GATE_KINDS },
          diagram: { type: "choice", instructions: "What kind of diagram is this becoming?", criteria: GATE_DIAGRAMS },
        },
      }),
      signal,
    });
    if (!res.ok) return null;
    return parseGate(await res.json());
  } catch {
    return null;
  }
}

/** Tolerant reader for the decisions answer shape. Exported for tests. */
export function parseGate(data: unknown): GateResult | null {
  const answers = (data as { answers?: Record<string, unknown> })?.answers;
  if (!answers || typeof answers !== "object") return null;
  const readyRaw = (answers.ready as { noul?: unknown })?.noul;
  const ready = typeof readyRaw === "number" ? Math.min(1, Math.max(0, readyRaw)) : NaN;
  if (Number.isNaN(ready)) return null;
  const out: GateResult = { ready };
  const kind = (answers.kind as { choice?: unknown })?.choice;
  if (typeof kind === "string" && kind in GATE_KINDS) out.kind = kind as GateResult["kind"];
  const diagram = (answers.diagram as { choice?: unknown })?.choice;
  if (typeof diagram === "string" && diagram in GATE_DIAGRAMS) out.diagram = diagram;
  return out;
}

/** One line for the prompt from a gate result. */
export function gateHint(g: GateResult): string | undefined {
  const bits: string[] = [];
  if (g.kind && g.kind !== "none") bits.push(`most likely next: ${g.kind} (${GATE_KINDS[g.kind]})`);
  if (g.diagram) bits.push(`this is a ${g.diagram}`);
  return bits.length ? bits.join("; ") : undefined;
}

/* ───────────────────────────  6. live stroke prediction (Jev)  ─────────────────────────── */

/** What a half-drawn stroke looks like, in numbers the state string turns into words. */
export interface StrokeFeatures {
  /** bounding box in scene coords */
  x: number;
  y: number;
  w: number;
  h: number;
  /** raw point count */
  n: number;
  /** endpoints close enough to call the path closed */
  closed: boolean;
  /** 0..1 — chord / path length; 1 is a perfect straight line */
  straightness: number;
  /** sharp direction changes along a simplified polyline */
  corners: number;
  /** travel direction in degrees, 0 = right, 90 = down */
  heading: number;
  /** node the stroke started on */
  startNodeId?: string;
  /** node the stroke currently ends on or near */
  endNodeId?: string;
}

const STROKE_SIMPLIFY = 24;
const CORNER_RAD = Math.PI / 4;

/**
 * Geometry of the stroke in progress plus which nodes it touches. Pure, so the
 * same numbers can be asserted in a test without a canvas. Returns null for a
 * stroke too short to say anything about.
 */
export function strokeFeatures(
  points: readonly Point[],
  scene: SceneSummary,
): StrokeFeatures | null {
  if (points.length < 4) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let path = 0;
  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[i];
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
    if (i) path += Math.hypot(px - points[i - 1][0], py - points[i - 1][1]);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (!diag || !path) return null;

  const [sx, sy] = points[0];
  const [ex, ey] = points[points.length - 1];
  const chord = Math.hypot(ex - sx, ey - sy);

  const step = Math.max(1, Math.floor(points.length / STROKE_SIMPLIFY));
  const simple: Point[] = [];
  for (let i = 0; i < points.length; i += step) simple.push(points[i]);
  let corners = 0;
  for (let i = 1; i < simple.length - 1; i++) {
    const a = Math.atan2(simple[i][1] - simple[i - 1][1], simple[i][0] - simple[i - 1][0]);
    const b = Math.atan2(simple[i + 1][1] - simple[i][1], simple[i + 1][0] - simple[i][0]);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > CORNER_RAD) corners++;
  }

  const hit = (px: number, py: number, pad: number): NodeInfo | undefined =>
    scene.nodes.find(
      (n) => px >= n.x - pad && px <= n.x + n.w + pad && py >= n.y - pad && py <= n.y + n.h + pad,
    );
  const start = hit(sx, sy, 8);
  const end = hit(ex, ey, 24);

  return {
    x: minX,
    y: minY,
    w,
    h,
    n: points.length,
    closed: chord < diag * 0.25,
    straightness: Math.min(1, chord / path),
    corners,
    heading: (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI,
    startNodeId: start?.id,
    endNodeId: end && end.id !== start?.id ? end.id : undefined,
  };
}

/** Literal geometric definitions. Handwriting is a separate question. */
const STROKE_KINDS = {
  rectangle: "A four-sided box with roughly square corners.",
  ellipse: "A closed round or oval outline.",
  diamond: "A four-sided shape standing on a corner.",
  arrow: "A line from one thing towards another, meant as a connection.",
  line: "A plain straight line or underline that connects nothing.",
  text: "Letters, digits or a written word.",
  none: "None of the above; the raw stroke should be kept.",
} as const;

const compass = (deg: number): string => {
  const d = ((deg % 360) + 360) % 360;
  if (d < 45 || d >= 315) return "rightwards";
  if (d < 135) return "downwards";
  if (d < 225) return "leftwards";
  return "upwards";
};

/** The stroke and its surroundings in words. Exported for tests. */
export function strokeState(f: StrokeFeatures, scene: SceneSummary): string {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const name = (id?: string) => {
    const n = id ? byId.get(id) : undefined;
    return n ? `${n.type}${n.text ? ` "${n.text}"` : ""}` : undefined;
  };
  const ratio = f.h ? f.w / f.h : 0;
  const parts = [
    `A stroke is being drawn: ${Math.round(f.w)} by ${Math.round(f.h)} pixels,`,
    `${f.closed ? "the ends meet (closed)" : "the ends are apart (open)"},`,
    `${f.straightness > 0.9 ? "almost perfectly straight" : f.straightness > 0.6 ? "fairly straight" : "curved or bent"},`,
    `${f.corners} sharp corners, travelling ${compass(f.heading)},`,
    `width/height ratio ${ratio.toFixed(1)}.`,
  ];
  const from = name(f.startNodeId);
  const to = name(f.endNodeId);
  if (from) parts.push(`It started on ${from}.`);
  if (to) parts.push(`It currently ends on ${to}.`);
  parts.push(
    scene.nodes.length
      ? `The board already has ${scene.nodes.length} nodes and ${scene.edges.length} arrows.`
      : "The board is empty.",
  );
  const labels = scene.nodes.map((n) => n.text.trim()).filter(Boolean);
  if (labels.length) parts.push(`Labels: ${labels.slice(0, 12).join(" | ")}.`);
  if (scene.intent) parts.push(`Stated intent: ${scene.intent}.`);
  if (scene.spoken) parts.push(`The user is saying: "${scene.spoken}"`);
  return parts.join(" ");
}

export type StrokeKind = keyof typeof STROKE_KINDS;

/** What the decision model thinks the stroke is going to be. */
export interface StrokePrediction {
  kind: StrokeKind;
  /** 0..1, the model's own calibrated confidence in that choice */
  confidence: number;
  /** for arrows: the node the arrow should end at */
  targetId?: string;
  /** 0..1 from its own question — a high value overrides a shape guess */
  handwriting?: number;
}

/** Nodes worth offering as an arrow target: nearest to the stroke end, capped. */
function targetCandidates(f: StrokeFeatures, scene: SceneSummary, max = 8): NodeInfo[] {
  const ex = f.x + f.w;
  const ey = f.y + f.h;
  return [...scene.nodes]
    .filter((n) => n.id !== f.startNodeId)
    .sort(
      (a, b) =>
        Math.hypot(a.x + a.w / 2 - ex, a.y + a.h / 2 - ey) -
        Math.hypot(b.x + b.w / 2 - ex, b.y + b.h / 2 - ey),
    )
    .slice(0, max);
}

/**
 * Ask the System One model what the stroke in flight is becoming. One typed
 * choice plus a calibrated confidence, in about a hundred milliseconds — fast
 * enough to answer before the pen is lifted. Any failure returns null and the
 * canvas falls back to the pure-geometry recognizer.
 */
export async function predictStroke(
  f: StrokeFeatures,
  scene: SceneSummary,
  cfg: AiConfig,
  signal?: AbortSignal,
): Promise<StrokePrediction | null> {
  if (cfg.provider !== "openrouter") return null;
  try {
    const target = resolveTarget(cfg, "fast");
    const candidates = targetCandidates(f, scene);
    // Every question rides in one request: the model evaluates them in
    // parallel and output tokens are free, so a second question costs nothing
    // but sharpens the decision. Each question covers exactly one dimension —
    // mixing two makes its confidence impossible to threshold.
    const questions: Record<string, unknown> = {
      shape: {
        type: "choice",
        instructions: "What is this stroke going to be once the pen is lifted?",
        criteria: STROKE_KINDS,
      },
      handwriting: {
        type: "noul",
        instructions: "The stroke is written letters or a word, not a drawn shape.",
      },
    };
    if (candidates.length) {
      questions.target = {
        type: "choice",
        instructions: "Which node is the end of this stroke heading towards?",
        criteria: {
          ...Object.fromEntries(
            candidates.map((n) => [n.id, `${n.type}${n.text ? ` labelled "${n.text}"` : ""}`]),
          ),
          none: "The stroke is not heading towards any of these nodes.",
        },
      };
    }
    const res = await tauriFetch(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: DEFAULT_GATE_MODEL,
        state: strokeState(f, scene),
        questions,
      }),
      signal,
    });
    if (!res.ok) return null;
    return parseStrokePrediction(await res.json());
  } catch {
    return null;
  }
}

/** Tolerant reader for the stroke answer. Exported for tests. */
export function parseStrokePrediction(data: unknown): StrokePrediction | null {
  const answers = (data as { answers?: Record<string, unknown> })?.answers;
  if (!answers || typeof answers !== "object") return null;
  const shape = answers.shape as { choice?: unknown; confidence?: unknown } | undefined;
  const kind = shape?.choice;
  if (typeof kind !== "string" || !(kind in STROKE_KINDS)) return null;
  const conf = typeof shape?.confidence === "number" ? Math.min(1, Math.max(0, shape.confidence)) : 0;
  const out: StrokePrediction = { kind: kind as StrokeKind, confidence: conf };

  const hw = (answers.handwriting as { noul?: unknown })?.noul;
  if (typeof hw === "number") {
    out.handwriting = Math.min(1, Math.max(0, hw));
    // The dedicated question beats the shape class: "is this a word" and
    // "which shape is it" are different dimensions, and only the first one is
    // asked plainly enough to threshold.
    if (out.handwriting >= HANDWRITING_SURE) {
      return { ...out, kind: "text", confidence: Math.max(conf, out.handwriting) };
    }
  }

  // The target question no longer asks whether this is an arrow, so the shape
  // answer is what decides whether a target is meaningful at all.
  const t = (answers.target as { choice?: unknown })?.choice;
  if (out.kind === "arrow" && typeof t === "string" && t !== "none") out.targetId = t;
  return out;
}

/** Above this, the handwriting question overrides whatever shape was chosen. */
const HANDWRITING_SURE = 0.7;
