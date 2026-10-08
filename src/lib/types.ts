/**
 * Shared contracts for Lucida — an AI-enhanced "smart whiteboard".
 *
 * Every feature module (recognizer, AI engine, canvas component, UI shell,
 * Rust sidecar bridge) is written against the types in this file. Keep it the
 * single source of truth: change a contract here, not in the consumers.
 */
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

/** A plain [x, y] point in scene (canvas) coordinates. */
export type Point = [number, number];

/* ───────────────────────────  Shape beautify (recognizer)  ─────────────────────────── */

export type PrimitiveType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "line"
  | "arrow";

export interface RecognizedShape {
  type: PrimitiveType;
  /** 0..1 — the caller only beautifies above its threshold. */
  confidence: number;
  /** Axis-aligned bounding box, ABSOLUTE scene coords. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * For "line" | "arrow" | "triangle": ordered vertices in ABSOLUTE scene
   * coords (the cleaned polyline; triangle is closed implicitly). Omitted for
   * rectangle/ellipse/diamond, which are fully described by the bounding box.
   */
  points?: Point[];
}

export interface RecognizerOptions {
  /** Minimum confidence to return a shape at all (default 0.55). */
  minConfidence?: number;
  /** Closed-path gap tolerance as a fraction of the bbox diagonal (default 0.2). */
  closeTolerance?: number;
}

/* ───────────────────────────  AI suggestions  ─────────────────────────── */

export interface NodeInfo {
  id: string;
  /** excalidraw element type, e.g. "rectangle" | "ellipse" | "text" … */
  type: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeInfo {
  /** source node id */
  from: string;
  /** target node id */
  to: string;
  /** the arrow's bound label, if any (e.g. "approves", "yes") */
  label?: string;
}

export interface SceneSummary {
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  /** optional free-text intent typed by the user ("a CI/CD pipeline"). */
  intent?: string;
  /** ids of the most recently drawn nodes, newest first (max 5). */
  recent?: string[];
  /** what the user did with earlier suggestions, newest first (max 8). */
  history?: SuggestionFeedback[];
  /** what the user has been saying out loud (tail of the transcript). */
  spoken?: string;
  /** a one-line steer from the decision gate ("most likely a diamond next"). */
  hint?: string;
  /** what project folder this board is open in, and that project's vocabulary. */
  project?: string;
  /** where to put the first node when the board is empty (viewport centre). */
  origin?: { x: number; y: number };
}

/* ───────────────────────────  Listen  ─────────────────────────── */

export interface TranscriptSegment {
  /** epoch seconds */
  t: number;
  text: string;
}

/** One audio input this machine offers. A call installs its own. */
export interface AudioInput {
  name: string;
  channels: number;
}

/** What the speech server reports about itself. */
export interface ListenHealth {
  ready: boolean;
  listening: boolean;
  /** the input being captured, or "system default" */
  device: string;
  inputs: AudioInput[];
  error?: string | null;
}

export interface ListenSnapshot {
  listening: boolean;
  /** Whisper model loaded */
  ready: boolean;
  error?: string | null;
  segments: TranscriptSegment[];
}

/* ───────────────────────────  Decision gate  ─────────────────────────── */

/** What the gate says about the moment — every field optional, fail-open. */
export interface GateResult {
  /** 0..1 — an obvious next element exists right now. */
  ready: number;
  /** the most likely kind of that element. */
  kind?: SuggestionKind | "none";
  /** what the drawing is turning into. */
  diagram?: string;
}

/** One earlier suggestion and the user's verdict on it. */
export interface SuggestionFeedback {
  kind: SuggestionKind;
  text?: string;
  outcome: "accepted" | "dismissed";
}

export type SuggestionKind =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow";

export interface Suggestion {
  kind: SuggestionKind;
  text?: string;
  /** absolute scene coords; optional — the builder auto-places when omitted. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /**
   * For arrows: ids of the endpoints. Either an existing NodeInfo.id, or
   * "new:<index>" referencing another suggestion in the same batch.
   */
  from?: string;
  to?: string;
  /** short human-readable reason; may be surfaced on hover, never required. */
  rationale?: string;
  /** 0..1 — the model's estimate that the user wants exactly this next. */
  confidence?: number;
}

export type AiProvider = "local" | "openrouter";

/**
 * "full" is the deliberate Ctrl+Enter request (frontier model, richest prompt);
 * "fast" is the auto-suggest after each stroke (cheap model, tight prompt).
 */
export type SuggestTier = "fast" | "full";

/**
 * Which optional request headers to send. Found by probing the key: OpenRouter
 * has answered 401 "User not found" to requests that carried the app
 * attribution headers or the webview's Origin while accepting the bare key.
 */
export interface CloudTransport {
  /** send HTTP-Referer / X-Title (OpenRouter app attribution). */
  attribution: boolean;
  /** let the webview's Origin header through (false strips it). */
  origin: boolean;
}

export interface CloudConfig {
  /** OpenRouter API key; the request is refused client-side when empty. */
  apiKey: string;
  /** header variant that worked for this key; defaults to everything on. */
  transport?: CloudTransport;
  /** OpenRouter model id for the full tier, e.g. "anthropic/claude-sonnet-5". */
  model: string;
  /** OpenRouter model id for the fast tier, e.g. "anthropic/claude-haiku-4.5". */
  fastModel: string;
  /** OpenRouter image-output model id for Illustrate, e.g. "google/gemini-3.1-flash-image". */
  imageModel: string;
  /** only Zero Data Retention providers (default); false still forbids training on the data */
  zdr?: boolean;
}

/* ───────────────────────────  Illustrate  ─────────────────────────── */

/** Visual style of generated pictures; the prompt text lives in ai.ts. */
export type IllustrationStyle =
  | "house"
  | "precise"
  | "flat"
  | "sketch"
  | "doodle"
  | "isometric"
  | "photo";

/** Appearance: follow the system, or pin one. */
export type ThemeChoice = "system" | "light" | "dark";

export interface IllustrateOptions {
  intent?: string;
  style?: IllustrationStyle;
  /** the organisation, for the house style */
  house?: { name?: string; accent?: string };
  signal?: AbortSignal;
}

/**
 * What to draw: a typed label, a PNG data URL of the user's own ink
 * (handwriting or a rough sketch), or both. At least one must be present.
 */
export interface IllustrateSubject {
  label?: string;
  sketch?: string;
  /** an existing picture to change, and what to change about it */
  edit?: { image: string; instruction: string };
}

/** Result of probing a key against OpenRouter — auth lookup and a real inference. */
export interface KeyCheck {
  ok: boolean;
  /** the key's name on OpenRouter, when known. */
  label?: string;
  /** OpenRouter's reason when the key is rejected. */
  message?: string;
  /** the header variant that made inference work. */
  transport?: CloudTransport;
  /**
   * "management" — a Management / Provisioning key: valid for the account API
   * but, per OpenRouter's docs, never for inference. Needs a normal API key.
   */
  kind?: "management";
  /** one line per probe step, for the panel and for bug reports. */
  steps: string[];
}

/** A generated picture, ready for Excalidraw's addFiles(). */
export interface IllustrationResult {
  dataURL: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface AiConfig {
  /** Where suggestions are computed. "local" never leaves the machine. */
  provider: AiProvider;
  /** local sidecar, e.g. "http://127.0.0.1:8765" */
  baseUrl: string;
  /** model id the local server answers to, e.g. "Qwen/Qwen2.5-3B-Instruct-GGUF" */
  model: string;
  cloud: CloudConfig;
  /** propose ghosts automatically after every stroke (fast tier). */
  autoSuggest: boolean;
}

export interface SuggestOptions {
  tier?: SuggestTier;
  signal?: AbortSignal;
  /** drop suggestions the model is less sure about than this (0..1). */
  minConfidence?: number;
}

/** The concrete HTTP target for one model request. */
export interface RequestTarget {
  provider: AiProvider;
  url: string;
  headers: Record<string, string>;
  model: string;
  /** whether the endpoint accepts a JSON-schema response_format. */
  structured: boolean;
}

/* ───────────────────────────  Tauri AI sidecar bridge  ─────────────────────────── */

export interface AiStatus {
  /** sidecar process spawned & alive */
  running: boolean;
  /** server answering on /v1/models (model loaded) — filled in by the client probe */
  ready: boolean;
  port: number;
  model: string;
}

/* ───────────────────────────  Canvas imperative handle  ─────────────────────────── */

export interface SuggestResult {
  count: number;
  error?: string;
}

/* ───────────────────────────  Agent (board API / MCP)  ─────────────────────────── */

/** A node an agent asks for; edges refer to nodes by index in the same call. */
export interface AgentNode {
  text: string;
  kind?: "rectangle" | "ellipse" | "diamond" | "text";
}

export interface AgentEdge {
  /** index into this call's nodes, or the id of a node already on the board */
  from: number | string;
  to: number | string;
  label?: string;
}

/** What an agent reads back before it adds anything. */
export interface AgentBoard {
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  images: Array<{ id: string; subject: string; x: number; y: number; w: number; h: number }>;
  /** elements an agent proposed that nobody has accepted yet */
  proposed: number;
  /** the visible part of the board, in scene coordinates */
  viewport: { x: number; y: number; width: number; height: number };
}

export interface AgentResult {
  /** elements added to the board, as a proposal */
  count: number;
  /** pictures placed / attempted */
  images?: { placed: number; failed: number; errors: string[] };
  /** anything shortened or dropped to fit */
  notes?: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface AgentExport {
  /** what the proposal is called, for the file name */
  title: string;
  /** full-resolution PNG, base64 without the data: prefix */
  png: string;
  /** a copy small enough to look at, base64 */
  preview: string;
  width: number;
  height: number;
}

/** Imperative handle the App uses to drive the canvas. */
export interface WhiteboardHandle {
  /** the board as an agent sees it */
  agentBoard: () => AgentBoard;
  /** propose nodes and edges, placed by the flow-aware layout */
  agentAddNodes: (nodes: AgentNode[], edges: AgentEdge[]) => AgentResult;
  /** propose a finished masterplan infographic, pictures included */
  agentRenderMasterplan: (spec: unknown, opts?: { images?: boolean }) => Promise<AgentResult>;
  /** propose one picture, below the node it illustrates or in view */
  agentAddImage: (label: string, near?: string) => Promise<AgentResult>;
  /** render the board, or only the pending proposal, to PNG */
  agentExport: (scope: "proposal" | "board" | "all" | "map" | "plan") => Promise<AgentExport>;
  /** drop the agent's proposals, leave the user's own ghosts alone */
  agentDiscard: () => number;
  /**
   * Put a live company map of a wiki folder on the board — it redraws itself
   * whenever the wiki changes. `null` takes it off again.
   */
  companyMap: (root: string | null, restricted?: boolean) => Promise<AgentResult>;
  /**
   * Put the live masterplan board on the board — drawn from `wiki/plan/`, and
   * every edit made on it written back there. `null` takes it off again.
   */
  planBoard: (root: string | null, look?: "heist" | "clean") => Promise<AgentResult>;
  /** Run AI suggestion; renders ghost elements. Returns how many were added. */
  suggest: (intent?: string, tier?: SuggestTier) => Promise<SuggestResult>;
  /**
   * A picture of what is selected (or the word being typed) — run straight
   * away. Nothing selected means nothing is drawn; nothing is guessed.
   */
  illustrate: () => Promise<SuggestResult>;
  /** Solidify the pending ghost suggestions into real elements. */
  acceptSuggestions: () => void;
  /** Remove the pending ghost suggestions. */
  dismissSuggestions: () => void;
  /** Whether ghost suggestions are currently pending. */
  hasPendingSuggestions: () => boolean;
}

export type { ExcalidrawElementSkeleton };
