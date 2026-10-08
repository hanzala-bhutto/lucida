/**
 * Whiteboard — the full-window Excalidraw canvas.
 *
 * Four AI-enhanced behaviors live here:
 *   1. Beautify: a freehand stroke released with autoBeautify on is passed to
 *      the recognizer and, above threshold, replaced by a clean primitive.
 *   2. Ghost suggestions: the App asks for suggest()/accept()/dismiss() via the
 *      imperative handle; pending suggestions render as dashed, low-opacity
 *      "ghost" elements until accepted or dismissed.
 *   3. Auto-suggest: with autoSuggest on, every pen-up with a drawing tool
 *      schedules a debounced fast-tier request. Its ghosts replace earlier
 *      auto ghosts and never touch ghosts the user asked for by hand.
 *   4. Live stroke prediction: while the pen is down, the decision model is
 *      asked every STROKE_PREDICT_MS what the stroke is becoming; a confident
 *      answer is drawn as a faint shadow in an SVG overlay (never as scene
 *      elements — touching the scene mid-stroke would fight Excalidraw) and
 *      snapped to on pen-up, ahead of the pure-geometry recognizer.
 *   5. Illustrate: a picture for what the user selected — typed labels, or
 *      their own handwriting / sketch exported as PNG — placed beside it as a
 *      ghost image (cloud provider only).
 *
 * Ownership: this file only drives the canvas. Recognition lives in
 * ../lib/recognizer, the AI round-trips in ../lib/ai; we talk to both purely
 * through the shared contracts in ../lib/types.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  exportToBlob,
  serializeAsJSON,
  restore,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  NonDeletedExcalidrawElement,
  Ordered,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

import { recognizeStroke } from "../lib/recognizer";
import {
  summarizeScene,
  suggestNext,
  suggestionsToSkeletons,
  illustrate,
  gate,
  gateHint,
  strokeFeatures,
  predictStroke,
} from "../lib/ai";
import type { StrokeKind, StrokePrediction } from "../lib/ai";
import {
  GHOST_OPACITY,
  AUTO_SUGGEST_DEBOUNCE_MS,
  AUTO_SUGGEST_MIN_CONFIDENCE,
  GATE_MIN_READY,
  STROKE_PREDICT_MS,
  STROKE_MIN_PX,
  STROKE_MIN_CONFIDENCE,
  SHADOW_OPACITY,
  ILLUSTRATION_SIZE,
  ILLUSTRATION_MAX_SIZE,
  ILLUSTRATION_GAP,
  ILLUSTRATION_MAX_PER_CALL,
  AGENT_POSTER_OPACITY,
  MASTERPLAN_MAX_IMAGES,
} from "../lib/config";
import {
  normalizeSpec,
  layoutMasterplan,
  estimateWidth,
  slotSubject,
} from "../lib/masterplan";
import { readEntities, layoutCompanyMap, groupEntities, type WikiSnapshot } from "../lib/companyMap";
import {
  buildPlan,
  layoutPlan,
  diffPlanBoard,
  patchPlanFile,
  type Plan,
  type PlanLayout,
  type PlanPatch,
  type PlanTag,
} from "../lib/plan";
import { layoutHeist } from "../lib/heist";
import { strings, type Lang, type Strings } from "../lib/i18n";
import { DEFAULT_HOUSE, type House } from "../lib/house";
import PlanInspector, { type PlanInspectorHandle } from "./PlanInspector";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfig,
  AgentBoard,
  AgentEdge,
  AgentExport,
  AgentNode,
  AgentResult,
  WhiteboardHandle,
  SuggestResult,
  SuggestTier,
  Suggestion,
  SuggestionFeedback,
  IllustrateSubject,
  IllustrationStyle,
  Point,
} from "../lib/types";

export interface WhiteboardProps {
  aiConfig: AiConfig;
  /** the language of everything the board shows */
  lang?: Lang;
  /** the organisation's look and name, from the settings */
  house?: House;
  /** the organisation's logo as a data URL, for light and for dark surfaces */
  logo?: string;
  logoDark?: string;
  autoBeautify: boolean;
  /** free-text intent from the panel; read at request time. */
  intent: string;
  /** look of generated pictures; read at request time. */
  illustrationStyle: IllustrationStyle;
  /** what the user has been saying (Listen); a change schedules a prediction. */
  spoken: string;
  /** light or dark, already resolved from the user's choice. */
  theme: "light" | "dark";
  /** a brief about the project folder this board is open in. */
  projectBrief: string;
  /** the board saved in that folder, if there is one. */
  initialBoard?: string | null;
  /** called, debounced, with the board to write back into the folder. */
  onPersist?: (json: string) => void;
  /** a deliberate (Ctrl+Enter / button) request is running. */
  onBusyChange?: (busy: boolean) => void;
  /** an auto-suggest request is running — subtle indicator only. */
  onAutoThinkingChange?: (thinking: boolean) => void;
  /** ghosts appeared or went away, including from auto-suggest. */
  onPendingChange?: (pending: boolean) => void;
  /** how many pictures are waiting to be waved through. */
  /** a key is set and accepted — pictures can be made */
  cloud?: boolean;
  /** experiment: show the predicted shape while the pen is down */
  predictStrokes?: boolean;
  /** the folder holds a wiki (wiki/entities): the menu offers its live boards */
  isWiki?: boolean;
  /** a picture was asked for without a key */
  onNeedKey?: () => void;
  onOpenSettings?: () => void;
  onPickFolder?: () => void;
  onPlanBoard?: () => void;
  onCompanyMap?: () => void;
  /** something went wrong in a background step the user should hear about. */
  onError?: (message: string) => void;
}

/**
 * Where a batch of ghosts came from — auto ghosts yield to manual ones, and an
 * agent's proposal (board API) is its own batch that neither of them touches.
 */
type GhostSource = "auto" | "manual" | "agent";

/** Style carried over from the source freehand stroke onto the clean shape. */
interface StrokeStyle {
  strokeColor: string;
  strokeWidth: number;
  backgroundColor: string;
  roughness: number;
}

/** Tools whose pen-up means "the user added something to the drawing". */
const DRAWING_TOOLS = new Set([
  "freedraw",
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
]);

/**
 * Build a "line" skeleton with local points. Confines the single necessary
 * cast to one place: skeleton points are typed as branded LocalPoint, but the
 * public convert API accepts plain [number, number] tuples at runtime.
 */
function lineSkeleton(
  x: number,
  y: number,
  points: Point[],
  style: StrokeStyle,
): ExcalidrawElementSkeleton {
  return { type: "line", x, y, points, ...style } as ExcalidrawElementSkeleton;
}

function isGhost(e: { customData?: Record<string, unknown> }): boolean {
  return e.customData?.lucidaGhost === true;
}

/**
 * A placeholder standing in for a picture still being drawn. It is a real
 * scene element, so Excalidraw's own move and resize apply to it: drag it or
 * pull a corner while the model works, and the picture lands exactly there.
 * The animated overlay only follows it; it never handles the pointer.
 */
function pendingIndex(e: { customData?: Record<string, unknown> }): number | null {
  const v = e.customData?.lucidaPending;
  return typeof v === "number" ? v : null;
}

function isPending(e: { customData?: Record<string, unknown> }): boolean {
  return pendingIndex(e) !== null;
}

function ghostSource(e: { customData?: Record<string, unknown> }): GhostSource | null {
  if (!isGhost(e)) return null;
  const src = e.customData?.lucidaSource;
  return src === "auto" ? "auto" : src === "agent" ? "agent" : "manual";
}

/** The live company map an element belongs to: its wiki root, if any. */
interface LiveMap {
  root: string;
  restricted: boolean;
}
function mapOf(e: { customData?: Record<string, unknown> }): LiveMap | null {
  const m = e.customData?.lucidaMap as LiveMap | undefined;
  return m && typeof m.root === "string" ? m : null;
}

/** Which plan board an element belongs to, and what it is on it. */
function planOf(e: { customData?: Record<string, unknown> }): PlanTag | null {
  const t = e.customData?.lucidaPlan as PlanTag | undefined;
  return t && typeof t.root === "string" ? t : null;
}

/** The plan is edited by hand; a quicker check keeps the board a step behind at most. */
const PLAN_POLL_MS = 2000;

/** How often the wiki is checked for changes. Only a fingerprint crosses the bridge. */
const MAP_POLL_MS = 4000;

/** Which agent proposal an element belongs to, if any. */
function proposalOf(e: { customData?: Record<string, unknown> }): string | null {
  const v = e.customData?.lucidaProposal;
  return isGhost(e) && typeof v === "string" ? v : null;
}

/**
 * A ghost made real. A poster keeps its own opacity and stroke — it was
 * proposed at full strength — so only a suggestion is lifted to solid.
 */
function solidify<T extends ExcalidrawElement>(e: T): T {
  const orig = e.customData?.lucidaOrig as { opacity?: number; strokeStyle?: string } | undefined;
  const { lucidaOrig: _drop, ...rest } = e.customData ?? {};
  return {
    ...e,
    opacity: orig?.opacity ?? 100,
    strokeStyle: orig?.strokeStyle ?? "solid",
    customData: { ...rest, lucidaGhost: false },
  } as T;
}

/** A short, stable id for a data URL, so the same logo is one scene file. */
function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 4096))) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

/** Width/height of each logo, measured once in the browser. */
const logoAspect = new Map<string, number>();
function measureLogo(url: string): void {
  if (!url || logoAspect.has(url)) return;
  const img = new Image();
  img.onload = () => logoAspect.set(url, img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.6);
  img.src = url;
}

/** Base64 of a blob, without the data: prefix. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("could not read export"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Width of a line of text as the canvas will draw it. Excalidraw registers
 * Nunito lazily; until that face is really loaded a measurement would come
 * from a fallback, so the conservative estimate is used instead.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
const CSS_FAMILY: Record<number, string> = {
  2: "Helvetica, Arial, sans-serif",
  3: "Cascadia, monospace",
  5: "Excalifont, sans-serif",
  6: "Nunito, sans-serif",
};
function measureText(text: string, fontSize: number, fontFamily: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const family = CSS_FAMILY[fontFamily];
  if (!measureCtx || !family) return estimateWidth(text, fontSize);
  const font = `${fontSize}px ${family}`;
  // Excalidraw's own faces load lazily; until one is really there, estimate
  if (fontFamily !== 2 && !document.fonts.check(font)) {
    return fontFamily === 3 ? text.length * fontSize * 0.6 : estimateWidth(text, fontSize) * (fontFamily === 5 ? 1.12 : 1);
  }
  measureCtx.font = font;
  // a hair of slack so a line measured exactly at the limit never wraps late
  return measureCtx.measureText(text).width * 1.03;
}

/** Axis-aligned box in scene coords — where an illustration is anchored. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boundingBox(elements: readonly ExcalidrawElement[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const el of elements) {
    x0 = Math.min(x0, el.x);
    y0 = Math.min(y0, el.y);
    x1 = Math.max(x1, el.x + el.width);
    y1 = Math.max(y1, el.y + el.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Quiet period after the last change before the board is written to its folder. */
const PERSIST_DEBOUNCE_MS = 900;
/** Without a model, a stroke smaller than this on both axes is left as ink. */
const MIN_BEAUTIFY_PX = 36;
/** No letter is this big — above it, a "handwriting" verdict is ignored. */
const HANDWRITING_MAX_PX = 140;

/** A predicted shape drawn under the user's hand, already in screen pixels. */
interface ShadowShape {
  kind: StrokeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

/** Set the shadow without re-rendering anything above it. */
interface ShadowHandle {
  set: (shape: ShadowShape | null) => void;
}

/**
 * The prediction, faintly, over the canvas. Two rules make this safe:
 *
 *  - It is an SVG overlay, not scene elements: writing to the scene while a
 *    stroke is in flight fights Excalidraw's own drawing state.
 *  - It holds its own state and is driven through a ref, so showing a shadow
 *    never re-renders the Whiteboard. A re-render mid-stroke remounts
 *    Excalidraw's props and chops the stroke into fragments — that is a bug,
 *    not a theory.
 */
const ShadowOverlay = forwardRef<ShadowHandle>(function ShadowOverlay(_props, ref) {
  const [shape, setShape] = useState<ShadowShape | null>(null);
  useImperativeHandle(ref, () => ({ set: setShape }), []);
  if (!shape) return null;
  const { kind, x, y, w, h, x1, y1, x2, y2 } = shape;
  // Confidence is visible: a guess fades in as the model becomes sure.
  const opacity = Math.min(0.55, SHADOW_OPACITY / 100 + shape.confidence * 0.35);
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg className="lucida-shadow" style={{ opacity }} aria-hidden="true">
      {kind === "rectangle" && <rect x={x} y={y} width={w} height={h} rx={8} {...common} />}
      {kind === "ellipse" && (
        <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
      )}
      {kind === "diamond" && (
        <polygon
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          {...common}
        />
      )}
      {(kind === "line" || kind === "arrow") && <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />}
      {kind === "arrow" &&
        (() => {
          const a = Math.atan2(y2 - y1, x2 - x1);
          const head = 12;
          const wing = Math.PI / 7;
          return (
            <polyline
              points={`${x2 - head * Math.cos(a - wing)},${y2 - head * Math.sin(a - wing)} ${x2},${y2} ${x2 - head * Math.cos(a + wing)},${y2 - head * Math.sin(a + wing)}`}
              {...common}
            />
          );
        })()}
    </svg>
  );
});

/** A place a picture is being drawn for, in screen pixels. */
interface PendingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PendingHandle {
  set: (boxes: PendingBox[] | null) => void;
}

/**
 * Where the picture will land, while it is being drawn. A frame appears at the
 * exact spot and size of the image to come, so the canvas answers "is it
 * working, and where" before the model has. Ref-driven like the shadow, so
 * waiting never re-renders the board.
 */
const PendingOverlay = forwardRef<PendingHandle>(function PendingOverlay(_props, ref) {
  const [boxes, setBoxes] = useState<PendingBox[] | null>(null);
  useImperativeHandle(ref, () => ({ set: setBoxes }), []);
  if (!boxes?.length) return null;
  return (
    <div className="lucida-pending-layer" aria-hidden="true">
      {boxes.map((b, i) => (
        <div
          key={i}
          className="lucida-pending"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
        >
          <span className="lucida-pending__dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
});

/** The chip under a selected word or sketch, in screen pixels. */
interface ChipSpot {
  x: number;
  y: number;
  /** "word" draws the text; "sketch" reads the ink */
  kind: "word" | "sketch";
  /** no key yet: the chip opens the settings instead */
  needsKey: boolean;
}

interface ChipHandle {
  set: (spot: ChipSpot | null) => void;
}

/**
 * One button where the eye already is: select a word (or a sketch) and a small
 * "Bild" chip sits right under it. Ctrl+I does the same. Ref-driven, so showing it
 * never re-renders the canvas.
 */
const ImageChip = forwardRef<ChipHandle, { onGo: () => void; T: Strings }>(function ImageChip({ onGo, T }, ref) {
  const [spot, setSpot] = useState<ChipSpot | null>(null);
  useImperativeHandle(ref, () => ({ set: setSpot }), []);
  if (!spot) return null;
  return (
    <button
      type="button"
      className={`lucida-chip${spot.needsKey ? " lucida-chip--key" : ""}`}
      style={{ left: spot.x, top: spot.y }}
      // pointerdown, not click: the canvas must not see this press as a deselect
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onGo();
      }}
      title={spot.needsKey ? T.chipNoKeyTitle : T.chipTitle}
    >
      <span aria-hidden="true">✦</span> {spot.needsKey ? T.chipNoKey : spot.kind === "sketch" ? T.chipSketch : T.chip}
      {!spot.needsKey && <kbd>Ctrl+I</kbd>}
    </button>
  );
});

/** Where an agent's proposal stands on screen, and what it is called. */
interface AgentFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

interface AgentFrameHandle {
  set: (frame: AgentFrame | null) => void;
}

/**
 * A poster proposed at full strength still has to read as a proposal. A cyan
 * frame around it with one line on top — keep or discard — says so without
 * touching a single element of it.
 */
const AgentFrameOverlay = forwardRef<AgentFrameHandle, { onKeep: () => void; onDiscard: () => void; T: Strings }>(
  function AgentFrameOverlay({ onKeep, onDiscard, T }, ref) {
    const [frame, setFrame] = useState<AgentFrame | null>(null);
    useImperativeHandle(ref, () => ({ set: setFrame }), []);
    if (!frame) return null;
    return (
      <div className="lucida-agent-frame" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
        <div className="lucida-agent-frame__tag" role="dialog" aria-label={`${T.proposal}: ${frame.title}`}>
          <span className="lucida-agent-frame__title">{T.proposal} · {frame.title}</span>
          <button type="button" className="lucida-agent-frame__btn lucida-agent-frame__btn--go" onClick={onKeep}>
            {T.keep} <kbd>Ctrl+Enter</kbd>
          </button>
          <button type="button" className="lucida-agent-frame__btn" onClick={onDiscard}>
            {T.discard} <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    );
  },
);

/** The bar under a clicked picture: say what should change, or roll it again. */
interface EditHandle {
  open: (at: { x: number; y: number; w: number; subject: string }) => void;
  close: () => void;
  isOpen: () => boolean;
}

/**
 * Click a picture: type what should be different and the model gets the
 * picture itself plus the change, so it edits *this* picture. ↻ draws the same
 * subject fresh. Either way the old picture is one Ctrl+Z away.
 */
const EditBar = forwardRef<EditHandle, { onSubmit: (instruction: string) => void; onReroll: () => void; T: Strings }>(
  function EditBar({ onSubmit, onReroll, T }, ref) {
    const [at, setAt] = useState<{ x: number; y: number; w: number; subject: string } | null>(null);
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        open: (next) => {
          setAt(next);
          setText("");
          window.setTimeout(() => inputRef.current?.focus(), 0);
        },
        close: () => setAt(null),
        isOpen: () => at !== null,
      }),
      [at],
    );

    if (!at) return null;
    const submit = () => {
      const t = text.trim();
      if (!t) return;
      setAt(null);
      onSubmit(t);
    };
    return (
      <div
        className="lucida-edit"
        style={{ left: at.x, top: at.y, width: Math.max(320, at.w) }}
        role="dialog"
        aria-label={T.editLabel}
      >
        <input
          ref={inputRef}
          className="lucida-edit__input"
          value={text}
          placeholder={T.editPlaceholder(at.subject)}
          aria-label={T.editLabel}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setAt(null);
          }}
        />
        <button type="button" className="lucida-edit__go" onClick={submit} disabled={!text.trim()}>
          {T.editGo}
        </button>
        <button
          type="button"
          className="lucida-edit__reroll"
          title={T.reroll}
          aria-label={T.reroll}
          onClick={() => {
            setAt(null);
            onReroll();
          }}
        >
          ↻
        </button>
      </div>
    );
  },
);

/** Point on the boundary of `b` along the line from `from` to its centre. */
function edgePoint(b: Box, from: Point): Point {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = cx - from[0];
  const dy = cy - from[1];
  if (!dx && !dy) return [cx, cy];
  const sx = dx ? b.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.max(0, 1 - Math.min(sx, sy));
  return [from[0] + dx * t, from[1] + dy * t];
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(
  (
    {
      aiConfig,
      autoBeautify,
      intent,
      illustrationStyle,
      lang = "de",
      house = DEFAULT_HOUSE,
      logo = "",
      logoDark = "",
      spoken,
      theme,
      projectBrief,
      initialBoard,
      onPersist,
      onBusyChange,
      onAutoThinkingChange,
      onPendingChange,
      cloud,
      predictStrokes,
      isWiki,
      onNeedKey,
      onOpenSettings,
      onPickFolder,
      onPlanBoard,
      onCompanyMap,
      onError,
    },
    ref,
  ) => {
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    // A folder switch remounts the board; a picture still being drawn for the
    // old one must not land anywhere.
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    // Mirror props into refs so the stable Excalidraw callbacks read the latest
    // values rather than the ones captured at first render.
    const autoBeautifyRef = useRef(autoBeautify);
    useEffect(() => {
      autoBeautifyRef.current = autoBeautify;
    }, [autoBeautify]);

    const aiConfigRef = useRef(aiConfig);
    useEffect(() => {
      aiConfigRef.current = aiConfig;
    }, [aiConfig]);

    const intentRef = useRef(intent);
    useEffect(() => {
      intentRef.current = intent;
    }, [intent]);

    const T = strings(lang);
    const langRef = useRef(lang);
    langRef.current = lang;
    const houseRef = useRef(house);
    houseRef.current = house;
    const logoRef = useRef({ light: logo, dark: logoDark });
    logoRef.current = { light: logo, dark: logoDark };
    measureLogo(logo);
    measureLogo(logoDark);
    const styleRef = useRef(illustrationStyle);
    useEffect(() => {
      styleRef.current = illustrationStyle;
    }, [illustrationStyle]);

    const spokenRef = useRef(spoken);

    const projectRef = useRef(projectBrief);
    useEffect(() => {
      projectRef.current = projectBrief;
    }, [projectBrief]);

    // Autosave: the board belongs to its folder, so every change eventually
    // reaches disk. Debounced, and ghosts and placeholders are never written —
    // only what the user actually accepted.
    const persistTimer = useRef<number | null>(null);
    useEffect(
      () => () => {
        if (persistTimer.current) window.clearTimeout(persistTimer.current);
      },
      [],
    );

    // In-flight guard so a second manual request can't race the first. Pending
    // ghost suggestions are marked on the elements themselves
    // (customData.lucidaGhost) rather than a separate id set, so undo/redo can
    // never desync the two.
    const inFlight = useRef(false);

    // Auto-suggest: one debounce timer, one abortable request at a time.
    const autoTimer = useRef<number | null>(null);
    const autoAbort = useRef<AbortController | null>(null);

    // What the model proposed last and how the user answered — fed back into
    // the next prompt so it stops repeating dismissed ideas.
    const lastBatch = useRef<Suggestion[]>([]);
    const history = useRef<SuggestionFeedback[]>([]);
    // Signature of the auto ghosts on screen, so an identical prediction does
    // not flicker them off and on again.
    const lastAutoSig = useRef<string>("");

    // Live stroke prediction: one request at a time, throttled, its answer kept
    // until pen-up decides what to do with it. The shadow is set through a ref
    // so that nothing here re-renders while the pen is down.
    const shadowRef = useRef<ShadowHandle | null>(null);
    const setShadow = (shape: ShadowShape | null) => shadowRef.current?.set(shape);
    const pendingRef = useRef<PendingHandle | null>(null);
    const chipRef = useRef<ChipHandle | null>(null);
    // The pen is down: nothing redraws under it, and the chip stays hidden.
    const pointerDown = useRef(false);
    const cloudRef = useRef(!!cloud);
    useEffect(() => {
      cloudRef.current = !!cloud;
    }, [cloud]);
    const predictRef = useRef(!!predictStrokes);
    useEffect(() => {
      predictRef.current = !!predictStrokes;
    }, [predictStrokes]);
    const editRef = useRef<EditHandle | null>(null);
    const agentFrameRef = useRef<AgentFrameHandle | null>(null);
    // Title of the agent proposal on the board, for its frame.
    const agentTitle = useRef<string>("");
    // The picture currently being edited, if any.
    const editTarget = useRef<{ elementId: string; fileId: string; subject: string } | null>(null);
    // Last known scene geometry per placeholder index, so a picture still has
    // somewhere to land if its frame was deleted mid-flight.
    const pendingSpots = useRef(new Map<number, Box>());
    const strokeBusy = useRef(false);
    const strokeAt = useRef(0);
    const strokeGuess = useRef<StrokePrediction | null>(null);

    useEffect(
      () => () => {
        if (autoTimer.current) window.clearTimeout(autoTimer.current);
        autoAbort.current?.abort();
      },
      [],
    );

    const notifyPending = () => {
      const api = apiRef.current;
      onPendingChange?.(api ? api.getSceneElements().some(isGhost) : false);
    };

    const recordFeedback = (outcome: SuggestionFeedback["outcome"]) => {
      if (!lastBatch.current.length) return;
      const entries = lastBatch.current
        .filter((s) => s.kind !== "arrow")
        .map((s): SuggestionFeedback => ({ kind: s.kind, text: s.text, outcome }));
      history.current = [...entries, ...history.current].slice(0, 8);
      lastBatch.current = [];
    };

    /** Solid elements: the scene the model reasons about — no ghosts, no placeholders. */
    const realElements = (api: ExcalidrawImperativeAPI): NonDeletedExcalidrawElement[] =>
      api.getSceneElements().filter((e) => !isGhost(e) && !isPending(e));

    /**
     * Dress skeletons in the user's own style: stroke, fill, roughness and
     * font are copied from the most recently drawn element of the same family,
     * so a ghost looks like something the user could have drawn.
     */
    const matchStyle = (
      api: ExcalidrawImperativeAPI,
      skeletons: ExcalidrawElementSkeleton[],
    ): ExcalidrawElementSkeleton[] => {
      const real = realElements(api);
      const newest = (pred: (e: ExcalidrawElement) => boolean) => {
        let best: ExcalidrawElement | null = null;
        for (const e of real) if (pred(e) && (!best || e.updated > best.updated)) best = e;
        return best;
      };
      const shapeT = newest((e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond");
      const textT = newest((e) => e.type === "text");
      const arrowT = newest((e) => e.type === "arrow");
      if (!shapeT && !textT && !arrowT) return skeletons;

      const stroke = (t: ExcalidrawElement | null) =>
        t ? { strokeColor: t.strokeColor, strokeWidth: t.strokeWidth, roughness: t.roughness } : {};
      const font =
        textT && textT.type === "text"
          ? { fontFamily: textT.fontFamily, fontSize: textT.fontSize }
          : {};

      return skeletons.map((sk) => {
        if (sk.type === "rectangle" || sk.type === "ellipse" || sk.type === "diamond") {
          const t = shapeT;
          return {
            ...sk,
            ...stroke(t ?? arrowT),
            ...(t ? { backgroundColor: t.backgroundColor, fillStyle: t.fillStyle, roundness: t.roundness } : {}),
            ...(sk.label ? { label: { ...sk.label, ...font } } : {}),
          } as ExcalidrawElementSkeleton;
        }
        if (sk.type === "text") {
          return { ...sk, ...font, ...(textT ? { strokeColor: textT.strokeColor } : stroke(shapeT)) } as ExcalidrawElementSkeleton;
        }
        if (sk.type === "arrow") {
          return {
            ...sk,
            ...stroke(arrowT ?? shapeT),
            ...(sk.label ? { label: { ...sk.label, ...font } } : {}),
          } as ExcalidrawElementSkeleton;
        }
        return sk;
      });
    };

    /** True when none of the boxes is inside the visible part of the canvas. */
    const allOffscreen = (api: ExcalidrawImperativeAPI, boxes: readonly Box[]): boolean => {
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      const z = zoom?.value ?? 1;
      const view: Box = { x: -scrollX, y: -scrollY, width: width / z, height: height / z };
      return !boxes.some(
        (b) =>
          b.x < view.x + view.width &&
          b.x + b.width > view.x &&
          b.y < view.y + view.height &&
          b.y + b.height > view.y,
      );
    };

    /** Insert skeletons as ghosts; drop existing ghosts of the given sources first. */
    const placeGhosts = (
      api: ExcalidrawImperativeAPI,
      skeletons: ExcalidrawElementSkeleton[],
      source: GhostSource,
      replace: readonly GhostSource[],
    ): number => {
      const created = convertToExcalidrawElements(matchStyle(api, skeletons), {
        regenerateIds: true,
      });
      const ghosts = created.map((e) => ({
        ...e,
        opacity: GHOST_OPACITY,
        strokeStyle: "dashed",
        customData: { ...(e.customData ?? {}), lucidaGhost: true, lucidaSource: source },
      }));
      const kept = api.getSceneElements().filter((e) => {
        const src = ghostSource(e);
        return src === null || !replace.includes(src);
      });
      api.updateScene({
        elements: [...kept, ...ghosts] as any,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      // Never yank the camera. Only when every ghost landed outside the view
      // (a deliberate request that grew the diagram off-screen) pan gently.
      if (source === "manual" && allOffscreen(api, ghosts)) {
        try {
          api.scrollToContent(ghosts as any, { animate: true, duration: 350 });
        } catch {
          // scrollToContent is best-effort cosmetic; ignore failures.
        }
      }
      notifyPending();
      return ghosts.length;
    };

    /** Add finished elements to the board outright — no ghost, no second yes. */
    const placeSolid = (
      api: ExcalidrawImperativeAPI,
      skeletons: ExcalidrawElementSkeleton[],
    ): number => {
      const created = convertToExcalidrawElements(skeletons, { regenerateIds: true });
      api.updateScene({
        elements: [...api.getSceneElements(), ...created] as any,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return created.length;
    };

    /**
     * Accept a subset of ghosts: the given ids plus their bound labels and the
     * arrows attached to them. The rest stay pending. Feedback is recorded for
     * the suggestions whose text now stands solid.
     */
    const acceptGhosts = (api: ExcalidrawImperativeAPI, ids: ReadonlySet<string>): void => {
      const scene = api.getSceneElements();
      const take = new Set(ids);
      // Touching any part of an agent's proposal takes the whole of it — a
      // poster with one card missing is not something anyone wants.
      const proposals = new Set(scene.filter((e) => ids.has(e.id)).map(proposalOf).filter(Boolean));
      for (const e of scene) {
        if (!isGhost(e)) continue;
        if (e.type === "text" && e.containerId && ids.has(e.id)) take.add(e.containerId);
        const pid = proposalOf(e);
        if (pid && proposals.has(pid)) take.add(e.id);
      }
      for (const e of scene) {
        if (!isGhost(e)) continue;
        if (e.type === "text" && e.containerId && take.has(e.containerId)) take.add(e.id);
        if (
          e.type === "arrow" &&
          ((e.startBinding && take.has(e.startBinding.elementId)) ||
            (e.endBinding && take.has(e.endBinding.elementId)))
        ) {
          take.add(e.id);
        }
      }
      if (!take.size) return;
      const next = scene.map((e) => (isGhost(e) && take.has(e.id) ? solidify(e) : e));
      api.updateScene({ elements: next as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });

      const texts = new Set(
        scene
          .filter((e) => take.has(e.id) && e.type === "text")
          .map((e) => (e.type === "text" ? e.text.trim() : "")),
      );
      const accepted = lastBatch.current.filter((s) => s.kind !== "arrow" && s.text && texts.has(s.text.trim()));
      if (accepted.length) {
        history.current = [
          ...accepted.map((s): SuggestionFeedback => ({ kind: s.kind, text: s.text, outcome: "accepted" })),
          ...history.current,
        ].slice(0, 8);
        lastBatch.current = lastBatch.current.filter((s) => !accepted.includes(s));
      }
      if (!next.some(isGhost)) lastBatch.current = [];
      lastAutoSig.current = "";
      notifyPending();
    };

    const clearAutoGhosts = (api: ExcalidrawImperativeAPI) => {
      const all = api.getSceneElements();
      const kept = all.filter((e) => ghostSource(e) !== "auto");
      if (kept.length !== all.length) {
        api.updateScene({ elements: kept as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        notifyPending();
      }
    };

    /** Where a first node should land on an empty board: the middle of what the user sees. */
    const viewCentre = (api: ExcalidrawImperativeAPI, summary: { nodes: unknown[] }) => {
      if (summary.nodes.length) return undefined;
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      const z = zoom?.value ?? 1;
      return { x: -scrollX + width / z / 2 - 80, y: -scrollY + height / z / 2 - 40 };
    };

    /** One suggestion round-trip; shared by the manual handle and auto-suggest. */
    const runSuggest = async (
      api: ExcalidrawImperativeAPI,
      tier: SuggestTier,
      source: GhostSource,
      signal?: AbortSignal,
    ): Promise<number> => {
      const summary = summarizeScene(
        realElements(api),
        intentRef.current,
        history.current,
        spokenRef.current,
        projectRef.current,
      );
      summary.origin = viewCentre(api, summary);

      // Auto tier: a ~100 ms decision first. Quiet moment → no text model call,
      // no ghost. Otherwise its verdict steers the prompt.
      if (source === "auto") {
        const g = await gate(summary, aiConfigRef.current, signal);
        if (signal?.aborted) return 0;
        if (g) {
          if (g.ready < GATE_MIN_READY || g.kind === "none") {
            clearAutoGhosts(api);
            return 0;
          }
          summary.hint = gateHint(g);
        }
      }

      const suggestions = await suggestNext(summary, aiConfigRef.current, {
        tier,
        signal,
        minConfidence: source === "auto" ? AUTO_SUGGEST_MIN_CONFIDENCE : undefined,
      });
      if (signal?.aborted) return 0;
      if (suggestions.length === 0) {
        // Nothing confident to show — also clear a stale auto batch, so an
        // old guess does not linger next to a drawing that moved on.
        if (source === "auto") clearAutoGhosts(api);
        return 0;
      }
      if (source === "auto") {
        const sig = JSON.stringify(suggestions.map((s) => [s.kind, s.text, s.from, s.to]));
        const stillShown = api.getSceneElements().some((e) => ghostSource(e) === "auto");
        if (sig === lastAutoSig.current && stillShown) return 0;
        lastAutoSig.current = sig;
      }
      lastBatch.current = suggestions;
      const skeletons = suggestionsToSkeletons(suggestions, summary);
      // Either source supersedes stale auto ghosts; manual ghosts stay put.
      return placeGhosts(api, skeletons, source, ["auto"]);
    };

    // Speech is a stroke too: new words schedule a prediction, so talking over
    // an empty board makes the first nodes appear.
    useEffect(() => {
      const changed = spoken !== spokenRef.current;
      spokenRef.current = spoken;
      if (changed && spoken.trim()) scheduleAutoSuggest();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spoken]);

    /**
     * Ask the decision model what the stroke in flight is becoming, at most
     * every STROKE_PREDICT_MS and never twice at once. Cheap enough to run on
     * every stroke; silent when there is no cloud key.
     */
    const predictLiveStroke = () => {
      const api = apiRef.current;
      if (!api || !autoBeautifyRef.current || !predictRef.current) return;
      if (aiConfigRef.current.provider !== "openrouter") return;
      if (strokeBusy.current) return;
      const now = Date.now();
      if (now - strokeAt.current < STROKE_PREDICT_MS) return;

      const state = api.getAppState();
      const live = state.newElement;
      if (!live || live.type !== "freedraw") return;
      const pts: Point[] = live.points.map((p): Point => [live.x + p[0], live.y + p[1]]);
      const last = pts[pts.length - 1];
      if (Math.max(live.width, live.height) < STROKE_MIN_PX) return;

      const summary = summarizeScene(
        realElements(api),
        intentRef.current,
        history.current,
        spokenRef.current,
        projectRef.current,
      );
      const f = strokeFeatures(pts, summary);
      if (!f) return;

      strokeAt.current = now;
      strokeBusy.current = true;
      void predictStroke(f, summary, aiConfigRef.current)
        .then((p) => {
          if (!p || p.confidence < STROKE_MIN_CONFIDENCE || p.kind === "none" || p.kind === "text") {
            strokeGuess.current = p && p.kind === "text" ? p : strokeGuess.current;
            if (p?.kind === "text") setShadow(null);
            return;
          }
          strokeGuess.current = p;
          // Screen space: the canvas does not scroll while a stroke is down,
          // so one conversion at prediction time is enough.
          const z = state.zoom?.value ?? 1;
          const toScreen = (sx: number, sy: number): Point => [(sx + state.scrollX) * z, (sy + state.scrollY) * z];
          const [px, py] = toScreen(f.x, f.y);
          const [sx1, sy1] = toScreen(pts[0][0], pts[0][1]);
          let endScene: Point = last;
          if (p.kind === "arrow" && p.targetId) {
            const t = summary.nodes.find((n) => n.id === p.targetId);
            if (t) endScene = edgePoint({ x: t.x, y: t.y, width: t.w, height: t.h }, pts[0]);
          }
          const [sx2, sy2] = toScreen(endScene[0], endScene[1]);
          setShadow({
            kind: p.kind,
            x: px,
            y: py,
            w: f.w * z,
            h: f.h * z,
            x1: sx1,
            y1: sy1,
            x2: sx2,
            y2: sy2,
            confidence: p.confidence,
          });
        })
        .finally(() => {
          strokeBusy.current = false;
        });
    };

    /**
     * One selected generated picture means "change this". Anything else —
     * nothing selected, several things, a shape — closes the bar.
     */
    const openEditFor = (api: ExcalidrawImperativeAPI, selectedIds: string[]) => {
      if (selectedIds.length !== 1) {
        editTarget.current = null;
        editRef.current?.close();
        return;
      }
      const el = api.getSceneElements().find((e) => e.id === selectedIds[0]);
      const fileId = (el as { fileId?: string } | undefined)?.fileId;
      if (!el || el.type !== "image" || !fileId || isGhost(el) || isPending(el)) {
        editTarget.current = null;
        editRef.current?.close();
        return;
      }
      const subject =
        typeof el.customData?.lucidaSubject === "string" && el.customData.lucidaSubject
          ? el.customData.lucidaSubject
          : T.thisPicture;
      editTarget.current = { elementId: el.id, fileId, subject };
      const { scrollX, scrollY, zoom } = api.getAppState();
      const z = zoom?.value ?? 1;
      editRef.current?.open({
        x: (el.x + scrollX) * z,
        y: (el.y + el.height + 10 + scrollY) * z,
        w: el.width * z,
        subject,
      });
    };

    /**
     * Redraw the clicked picture in place — with one change, or as a fresh
     * take on the same subject. Place, size and group are kept; the old
     * picture is replaced as one undo step, so Ctrl+Z brings it back.
     */
    const redrawPicture = async (change: { instruction: string } | "reroll") => {
      const api = apiRef.current;
      const target = editTarget.current;
      if (!api || !target || inFlight.current) return;
      if (!cloudRef.current) {
        onNeedKey?.();
        return;
      }
      const el = api.getSceneElements().find((e) => e.id === target.elementId);
      if (!el) return;
      const current = api.getFiles()[target.fileId]?.dataURL;
      if (!current) return;
      const box: Box = { x: el.x, y: el.y, width: el.width, height: el.height };
      const known = target.subject && target.subject !== strings("de").thisPicture && target.subject !== strings("en").thisPicture;

      inFlight.current = true;
      onBusyChange?.(true);
      chipRef.current?.set(null);
      // the waiting frame is a scene element on top of the old picture, so it
      // follows scrolling and zoom like any frame Ctrl+I places
      const index = 3000;
      pendingSpots.current.set(index, box);
      const frame = convertToExcalidrawElements(
        [{ type: "rectangle", x: box.x, y: box.y, width: box.width, height: box.height, strokeColor: "transparent", backgroundColor: "#c7d2fe", fillStyle: "solid" } as ExcalidrawElementSkeleton],
        { regenerateIds: true },
      ).map((e) => ({ ...e, opacity: 15, customData: { lucidaPending: index } }));
      api.updateScene({ elements: [...api.getSceneElements(), ...frame] as any, captureUpdate: CaptureUpdateAction.NEVER });
      syncPending();
      try {
        const subject: IllustrateSubject =
          change === "reroll"
            ? known
              ? { label: target.subject }
              : { label: target.subject, edit: { image: String(current), instruction: "Draw a new take on the same subject: different composition, same style." } }
            : { label: known ? target.subject : undefined, edit: { image: String(current), instruction: change.instruction } };
        const next = await illustrate(subject, aiConfigRef.current, { intent: intentRef.current, style: styleRef.current, house: { name: houseRef.current.name, accent: houseRef.current.accent } });
        if (!mounted.current) return;
        const fileId = `lucida-img-${Date.now().toString(36)}`;
        api.addFiles([{ id: fileId, dataURL: next.dataURL, mimeType: next.mimeType, created: Date.now() } as any]);
        const live = api.getSceneElements().find((e) => pendingIndex(e) === index);
        const spot = live ? { x: live.x, y: live.y, width: live.width, height: live.height } : box;
        const created = convertToExcalidrawElements(
          [
            {
              type: "image",
              fileId,
              ...spot,
              groupIds: el.groupIds,
              customData: { ...(el.customData ?? {}), lucidaSubject: target.subject },
            } as unknown as ExcalidrawElementSkeleton,
          ],
          { regenerateIds: true },
        );
        api.updateScene({
          elements: [...api.getSceneElements().filter((e) => e.id !== target.elementId && pendingIndex(e) !== index), ...created] as any,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        editTarget.current = null;
      } catch (err) {
        onError?.(`${T.picture}: ${String(err)}`);
      } finally {
        const a2 = apiRef.current;
        if (a2) {
          const rest = a2.getSceneElements().filter((e) => pendingIndex(e) !== index);
          if (rest.length !== a2.getSceneElements().length) a2.updateScene({ elements: rest as any, captureUpdate: CaptureUpdateAction.NEVER });
        }
        pendingSpots.current.delete(index);
        pendingRef.current?.set(null);
        inFlight.current = false;
        onBusyChange?.(false);
      }
    };
    const submitEdit = (instruction: string) => redrawPicture({ instruction });
    const rerollEdit = () => redrawPicture("reroll");

    /** Stop any prediction in flight — the user is drawing again. */
    const cancelAuto = () => {
      if (autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      if (autoAbort.current) {
        autoAbort.current.abort();
        autoAbort.current = null;
        onAutoThinkingChange?.(false);
      }
    };

    /** Debounced fast-tier prediction after a drawing pen-up. */
    const scheduleAutoSuggest = () => {
      if (!aiConfigRef.current.autoSuggest) return;
      if (autoTimer.current) window.clearTimeout(autoTimer.current);
      autoTimer.current = window.setTimeout(() => {
        autoTimer.current = null;
        const api = apiRef.current;
        if (!api || inFlight.current) return;
        // A manual batch or an agent's proposal is the user's decision to
        // make — do not stomp it.
        if (api.getSceneElements().some((e) => (ghostSource(e) ?? "auto") !== "auto")) return;
        if (realElements(api).length === 0 && !spokenRef.current.trim()) return;

        autoAbort.current?.abort();
        const ctrl = new AbortController();
        autoAbort.current = ctrl;
        onAutoThinkingChange?.(true);
        void runSuggest(api, "fast", "auto", ctrl.signal)
          .catch((err) => {
            if (!isAbort(err) && import.meta.env.DEV) console.warn("auto-suggest failed:", err);
          })
          .finally(() => {
            if (autoAbort.current === ctrl) {
              autoAbort.current = null;
              onAutoThinkingChange?.(false);
            }
          });
      }, AUTO_SUGGEST_DEBOUNCE_MS);
    };

    /**
     * Replace a just-drawn freehand stroke with a clean primitive. A confident
     * prediction wins; "text" means the stroke is handwriting and is left as
     * ink; anything else falls back to the pure-geometry recognizer.
     */
    const beautifyLastStroke = (guess: StrokePrediction | null) => {
      const api = apiRef.current;
      if (!api) return;

      const freedraws = api
        .getSceneElements()
        .filter(
          (e): e is Ordered<ExcalidrawFreeDrawElement> => e.type === "freedraw",
        );
      if (freedraws.length === 0) return;

      // Freshest stroke wins — that's the one the user just finished.
      let el = freedraws[0];
      for (const f of freedraws) if (f.updated > el.updated) el = f;

      // Handwriting is small; a shape is not. Both the model's "this is a word"
      // verdict and the no-model fallback only ever hold back a *small* stroke,
      // so a misread can never stop a real shape from snapping.
      const small = Math.max(el.width, el.height) < HANDWRITING_MAX_PX;
      if (guess?.kind === "text" && small) return;
      if (!guess && Math.max(el.width, el.height) < MIN_BEAUTIFY_PX) return;

      const absPts: Point[] = el.points.map(
        (p): Point => [el.x + p[0], el.y + p[1]],
      );
      const style = {
        strokeColor: el.strokeColor,
        strokeWidth: el.strokeWidth,
        backgroundColor: el.backgroundColor,
        roughness: el.roughness,
      };

      const replaceWith = (sk: ExcalidrawElementSkeleton) => {
        const created = convertToExcalidrawElements([sk], { regenerateIds: true });
        const next = api
          .getSceneElements()
          .filter((e) => e.id !== el.id)
          .concat(created);
        api.updateScene({
          elements: next as any,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      };

      // 1. A confident prediction: build exactly what it named.
      if (guess && guess.kind !== "none") {
        const first = absPts[0];
        const lastPt = absPts[absPts.length - 1];
        if (guess.kind === "rectangle" || guess.kind === "ellipse" || guess.kind === "diamond") {
          replaceWith({
            type: guess.kind,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            ...style,
          });
          return;
        }
        if (guess.kind === "arrow" || guess.kind === "line") {
          let end = lastPt;
          if (guess.kind === "arrow" && guess.targetId) {
            const t = realElements(api).find((e) => e.id === guess.targetId);
            if (t) end = edgePoint({ x: t.x, y: t.y, width: t.width, height: t.height }, first);
          }
          replaceWith({
            type: guess.kind,
            x: first[0],
            y: first[1],
            points: [
              [0, 0],
              [end[0] - first[0], end[1] - first[1]],
            ],
            ...style,
          } as ExcalidrawElementSkeleton);
          return;
        }
      }

      // 2. No usable prediction — pure geometry decides, as it always has.
      const shape = recognizeStroke(absPts, { minConfidence: 0.55 });
      if (!shape) return;

      let skeleton: ExcalidrawElementSkeleton;
      switch (shape.type) {
        case "rectangle":
        case "ellipse":
        case "diamond":
          skeleton = {
            type: shape.type,
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
            ...style,
          };
          break;
        case "line": {
          const pts = shape.points;
          if (!pts || pts.length < 2) return;
          const [p0, p1] = pts;
          const localPoints: Point[] = [
            [0, 0],
            [p1[0] - p0[0], p1[1] - p0[1]],
          ];
          skeleton = lineSkeleton(p0[0], p0[1], localPoints, style);
          break;
        }
        case "triangle": {
          const pts = shape.points;
          if (!pts || pts.length < 3) return;
          const [v0, v1, v2] = pts;
          const localPoints: Point[] = [
            [0, 0],
            [v1[0] - v0[0], v1[1] - v0[1]],
            [v2[0] - v0[0], v2[1] - v0[1]],
            [0, 0],
          ];
          skeleton = lineSkeleton(v0[0], v0[1], localPoints, style);
          break;
        }
        default:
          // "arrow" is not produced from a single beautify stroke.
          return;
      }

      replaceWith(skeleton);
    };

    /**
     * Keep the animated overlay on top of the placeholder frames as they are
     * moved, resized, scrolled or zoomed. Cheap no-op when nothing is pending,
     * which is almost always.
     */
    const syncPending = () => {
      const api = apiRef.current;
      if (!api) return;
      const frames = api.getSceneElements().filter(isPending);
      if (!frames.length) {
        if (pendingSpots.current.size === 0) return;
        pendingRef.current?.set(null);
        return;
      }
      const { scrollX, scrollY, zoom } = api.getAppState();
      const z = zoom?.value ?? 1;
      const boxes: PendingBox[] = [];
      for (const f of frames) {
        const i = pendingIndex(f);
        if (i === null) continue;
        pendingSpots.current.set(i, { x: f.x, y: f.y, width: f.width, height: f.height });
        boxes.push({
          x: (f.x + scrollX) * z,
          y: (f.y + scrollY) * z,
          w: f.width * z,
          h: f.height * z,
        });
      }
      pendingRef.current?.set(boxes);
    };

    const schedulePersist = () => {
      if (!onPersist) return;
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null;
        const api = apiRef.current;
        if (!api) return;
        try {
          onPersist(
            serializeAsJSON(
              realElements(api),
              api.getAppState(),
              api.getFiles(),
              "local",
            ),
          );
        } catch {
          // a board that cannot be serialised must not break the canvas
        }
      }, PERSIST_DEBOUNCE_MS);
    };

    /** Keep the proposal frame around the agent's elements as the view moves. */
    const syncAgentFrame = () => {
      const api = apiRef.current;
      if (!api) return;
      const mine = api.getSceneElements().filter((e) => ghostSource(e) === "agent");
      if (!mine.length) {
        if (agentTitle.current) {
          agentTitle.current = "";
          agentFrameRef.current?.set(null);
        }
        return;
      }
      if (!agentTitle.current) return;
      const b = boundingBox(mine);
      const { scrollX, scrollY, zoom } = api.getAppState();
      const z = zoom?.value ?? 1;
      const pad = 10;
      agentFrameRef.current?.set({
        x: (b.x + scrollX) * z - pad,
        y: (b.y + scrollY) * z - pad,
        w: b.width * z + pad * 2,
        h: b.height * z + pad * 2,
        title: agentTitle.current,
      });
    };

    const handleChange = () => {
      if (pendingSpots.current.size) syncPending();
      const capi = apiRef.current;
      if (capi) syncChip(capi);
      if (agentTitle.current) syncAgentFrame();
      if (planRoot.current) {
        const api = apiRef.current;
        if (api) refreshInspector(api);
        // typing, deleting and arrow-drawing settle here; drags on pointer-up
        schedulePlanSync(700);
      }
      schedulePersist();
    };

    const handlePointerDown = (activeTool: { type: string }) => {
      pointerDown.current = true;
      // A new stroke makes the prediction in flight stale — never let it pop
      // in mid-drawing.
      if (DRAWING_TOOLS.has(activeTool.type)) cancelAuto();
      strokeGuess.current = null;
      strokeAt.current = 0;
      setShadow(null);
    };

    const handlePointerUpdate = ({ button }: { button: "down" | "up" }) => {
      if (button === "down") predictLiveStroke();
    };

    const handlePointerUp = (
      activeTool: { type: string },
      _pointerDownState: unknown,
    ) => {
      pointerDown.current = false;
      if (planRoot.current) schedulePlanSync(60);
      const guess = strokeGuess.current;
      strokeGuess.current = null;
      setShadow(null);
      if (activeTool.type === "freedraw" && autoBeautifyRef.current) {
        beautifyLastStroke(guess && guess.confidence >= STROKE_MIN_CONFIDENCE ? guess : null);
      }
      if (DRAWING_TOOLS.has(activeTool.type)) {
        scheduleAutoSuggest();
        return;
      }
      // Touching a ghost with the selection tool means "I'll take this one".
      // Not an agent's proposal: a poster fills the view, so the click that
      // focuses the window or starts a drag would take it by accident. That
      // one is kept only on purpose — Ctrl+Enter, or Keep on its frame.
      if (activeTool.type === "selection") {
        const api = apiRef.current;
        if (!api) return;
        const selected = api.getAppState().selectedElementIds;
        const ghostIds = new Set(
          api
            .getSceneElements()
            .filter((e) => isGhost(e) && ghostSource(e) !== "agent" && selected[e.id])
            .map((e) => e.id),
        );
        if (ghostIds.size) {
          acceptGhosts(api, ghostIds);
          return;
        }
        openEditFor(api, Object.keys(selected));
      }
    };

    /** Render the user's own ink to a small PNG the image model can look at. */
    const inkToDataUrl = async (
      api: ExcalidrawImperativeAPI,
      elements: readonly ExcalidrawElement[],
    ): Promise<string> => {
      const blob = await exportToBlob({
        elements: elements as any,
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 16,
        maxWidthOrHeight: 512,
        appState: {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          exportWithDarkMode: false,
        },
      });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("could not read sketch"));
        reader.readAsDataURL(blob);
      });
    };

    type Target = { subject: IllustrateSubject; anchor: Box };

    /**
     * What a picture is drawn of: the word being typed right now, else the
     * selection — its words, or, with none, the ink itself as a sketch.
     * Nothing is guessed: nothing selected means nothing is drawn.
     */
    const pickTargets = async (api: ExcalidrawImperativeAPI): Promise<Target[]> => {
      const elements = realElements(api);
      const appState = api.getAppState();
      const byId = new Map(elements.map((e) => [e.id, e]));
      const containerOf = (el: ExcalidrawElement): ExcalidrawElement =>
        (el.type === "text" && el.containerId && byId.get(el.containerId)) || el;
      const out: Target[] = [];
      const seen = new Set<string>();
      const pushLabel = (text: string, anchor: ExcalidrawElement) => {
        const t = text.trim();
        if (!t || seen.has(anchor.id)) return;
        seen.add(anchor.id);
        out.push({ subject: { label: t }, anchor });
      };

      const editing = appState.editingTextElement;
      if (editing && editing.type === "text" && editing.text.trim()) {
        pushLabel(editing.text, containerOf(editing));
        return out;
      }

      const selected = elements.filter((el) => appState.selectedElementIds[el.id] && !planOf(el) && !mapOf(el));
      if (!selected.length || selected.every((e) => e.type === "image")) return out;
      for (const el of selected) {
        if (el.type === "text") pushLabel(el.text, containerOf(el));
        else {
          const label = elements.find((t) => t.type === "text" && t.containerId === el.id);
          if (label && label.type === "text") pushLabel(label.text, el);
        }
      }
      if (out.length) return out.slice(0, ILLUSTRATION_MAX_PER_CALL);

      const ids = new Set(selected.filter((e) => e.type !== "image").map((e) => e.id));
      const ink = elements.filter((e) => ids.has(e.id) || (e.type === "text" && e.containerId && ids.has(e.containerId)));
      return [{ subject: { sketch: await inkToDataUrl(api, ink) }, anchor: boundingBox(ink) }];
    };

    /** Where the chip goes: under the selection, if a picture can be made of it. */
    const syncChip = (api: ExcalidrawImperativeAPI) => {
      const st = api.getAppState();
      if (pointerDown.current || inFlight.current || editRef.current?.isOpen() || st.editingTextElement) {
        chipRef.current?.set(null);
        return;
      }
      const all = realElements(api);
      const sel = all.filter((e) => st.selectedElementIds[e.id] && !planOf(e) && !mapOf(e) && !e.locked);
      const drawable = sel.filter((e) => e.type !== "image" && e.type !== "arrow" && e.type !== "line");
      if (!drawable.length || sel.some((e) => e.type === "image")) {
        chipRef.current?.set(null);
        return;
      }
      const hasWord =
        drawable.some((e) => e.type === "text" && e.text.trim()) ||
        drawable.some((e) => all.some((t) => t.type === "text" && t.containerId === e.id));
      const b = boundingBox(sel);
      const z = st.zoom?.value ?? 1;
      chipRef.current?.set({
        x: (b.x + st.scrollX) * z,
        y: (b.y + b.height + st.scrollY) * z + 10,
        kind: hasWord ? "word" : "sketch",
        needsKey: !cloudRef.current,
      });
    };

    /**
     * Do the work: place a frame for each picture, ask for them in parallel,
     * and drop each result into whatever geometry its frame has by then.
     */
    const runIllustrate = async (
      api: ExcalidrawImperativeAPI,
      targets: Target[],
    ): Promise<SuggestResult> => {
      if (inFlight.current) return { count: 0 };
      inFlight.current = true;
      onBusyChange?.(true);
      try {
            // Decide where each picture goes before asking for it, so the
            // waiting frame stands exactly where the image will.
            const spots = targets.map(({ anchor }) => {
              const size = Math.min(
                ILLUSTRATION_MAX_SIZE,
                Math.max(ILLUSTRATION_SIZE, anchor.width * 1.8),
              );
              return {
                x: anchor.x + anchor.width / 2 - size / 2,
                y: anchor.y + anchor.height + ILLUSTRATION_GAP,
                size,
              };
            });
            // The frames go into the scene, so they can be dragged and resized
            // with the normal tools while the model draws.
            const frameSkeletons = spots.map(
              (spot, i) =>
                ({
                  type: "rectangle",
                  x: spot.x,
                  y: spot.y,
                  width: spot.size,
                  height: spot.size,
                  // No stroke: the dashed frame is drawn by the overlay above.
                  // A faint fill is what makes the whole area grabbable —
                  // Excalidraw only hit-tests the outline of a shape whose
                  // background is transparent, so an invisible frame could
                  // only be caught exactly on its edge.
                  strokeColor: "transparent",
                  backgroundColor: "#c7d2fe",
                  fillStyle: "solid",
                  opacity: 15,
                  customData: { lucidaPending: i },
                }) as ExcalidrawElementSkeleton,
            );
            const frames = convertToExcalidrawElements(frameSkeletons, {
              regenerateIds: true,
            }).map((e, i) => ({ ...e, opacity: 15, customData: { lucidaPending: i } }));
            pendingSpots.current = new Map(
              spots.map((s, i) => [i, { x: s.x, y: s.y, width: s.size, height: s.size }]),
            );
            api.updateScene({
              elements: [...api.getSceneElements(), ...frames] as any,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            syncPending();

            const results = await Promise.allSettled(
              targets.map((t) =>
                illustrate(t.subject, aiConfigRef.current, {
                  intent: intentRef.current,
                  style: styleRef.current,
                  house: { name: houseRef.current.name, accent: houseRef.current.accent },
                }),
              ),
            );
            const skeletons: ExcalidrawElementSkeleton[] = [];
            let firstError: string | undefined;
            results.forEach((r, i) => {
              if (r.status === "rejected") {
                firstError ??= String(r.reason);
                return;
              }
              const fileId = `lucida-img-${Date.now().toString(36)}-${i}`;
              api.addFiles([
                {
                  id: fileId,
                  dataURL: r.value.dataURL,
                  mimeType: r.value.mimeType,
                  created: Date.now(),
                } as any,
              ]);
              // Wherever the frame ended up is where the picture goes — the
              // user may have dragged or resized it while the model worked.
              const live = api.getSceneElements().find((e) => pendingIndex(e) === i);
              const spot = spots[i];
              const box: Box = live
                ? { x: live.x, y: live.y, width: live.width, height: live.height }
                : (pendingSpots.current.get(i) ?? {
                    x: spot.x,
                    y: spot.y,
                    width: spot.size,
                    height: spot.size,
                  });
              skeletons.push({
                type: "image",
                fileId,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                // The subject rides along so the picture can be edited later
                // by clicking it — and so an edit knows what it is changing.
                customData: { lucidaSubject: targets[i].subject.label ?? "" },
              } as unknown as ExcalidrawElementSkeleton);
            });
            // A picture was already waved through before it was asked for, and
            // it cost real time and money. Making the user accept it a second
            // time would be friction, not control — so it lands solid.
            const count = skeletons.length ? placeSolid(api, skeletons) : 0;
            return firstError && count === 0 ? { count, error: firstError } : { count };
      } catch (err) {
        if (import.meta.env.DEV) console.warn("illustrate failed:", err);
        return { count: 0, error: String(err) };
      } finally {
        // The frames have served their purpose, whatever the outcome.
        const api2 = apiRef.current;
        if (api2) {
          const rest = api2.getSceneElements().filter((e) => !isPending(e));
          if (rest.length !== api2.getSceneElements().length) {
            api2.updateScene({
              elements: rest as any,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        }
        pendingSpots.current.clear();
        pendingRef.current?.set(null);
        inFlight.current = false;
        onBusyChange?.(false);
      }
    };

    /** The chip and Ctrl+I: draw what is selected, or say how to get a picture. */
    const illustrateSelection = async (): Promise<SuggestResult> => {
      const api = apiRef.current;
      if (!api) return { count: 0, error: "canvas not ready" };
      if (inFlight.current) return { count: 0 };
      if (!cloudRef.current) {
        onNeedKey?.();
        return { count: 0 };
      }
      const targets = await pickTargets(api);
      if (!targets.length) return { count: 0, error: strings(langRef.current).nothingSelected };
      chipRef.current?.set(null);
      return runIllustrate(api, targets);
    };

    /* ── Agent (board API) ── */

    /** Mark elements as one agent proposal. */
    const asAgentGhosts = (
      elements: readonly ExcalidrawElement[],
      pid: string,
      look: "poster" | "ghost",
    ): ExcalidrawElement[] =>
      elements.map(
        (e) =>
          ({
            ...e,
            opacity: look === "poster" ? Math.min(e.opacity, AGENT_POSTER_OPACITY) : GHOST_OPACITY,
            strokeStyle: look === "poster" ? e.strokeStyle : "dashed",
            customData: {
              ...(e.customData ?? {}),
              lucidaGhost: true,
              lucidaSource: "agent",
              lucidaProposal: pid,
              ...(look === "poster" ? { lucidaOrig: { opacity: e.opacity, strokeStyle: e.strokeStyle } } : {}),
            },
          }) as ExcalidrawElement,
      );

    /** Somewhere free: right of everything on the board, else the top-left of the view. */
    const freeOrigin = (api: ExcalidrawImperativeAPI): { x: number; y: number } => {
      const solid = realElements(api).concat(api.getSceneElements().filter(isGhost));
      if (solid.length) {
        const b = boundingBox(solid);
        return { x: Math.round(b.x + b.width + 240), y: Math.round(b.y) };
      }
      const { scrollX, scrollY, zoom } = api.getAppState();
      const z = zoom?.value ?? 1;
      return { x: Math.round(-scrollX + 80 / z), y: Math.round(-scrollY + 80 / z) };
    };

    const newProposalId = () => `agent-${Date.now().toString(36)}`;

    /**
     * The organisation's logo as a scene file — the light-surface one or the
     * dark-surface one — with its aspect ratio. Nothing without a logo.
     */
    const ensureLogo = (api: ExcalidrawImperativeAPI, dark = false): { fileId: string; aspect: number } | undefined => {
      const url = dark ? logoRef.current.dark || logoRef.current.light : logoRef.current.light;
      if (!url) return undefined;
      const fileId = `lucida-logo-${hashString(url)}`;
      if (!api.getFiles()[fileId]) {
        const mime = /^data:([^;]+);/.exec(url)?.[1] ?? "image/png";
        api.addFiles([{ id: fileId, dataURL: url, mimeType: mime, created: Date.now() } as any]);
      }
      return { fileId, aspect: logoAspect.get(url) ?? 1.6 };
    };

    const agentBoard = (): AgentBoard => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      const real = realElements(api);
      const summary = summarizeScene(real, intentRef.current, undefined, spokenRef.current);
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      const z = zoom?.value ?? 1;
      return {
        nodes: summary.nodes,
        edges: summary.edges,
        images: real
          .filter((e) => e.type === "image")
          .map((e) => ({
            id: e.id,
            subject: typeof e.customData?.lucidaSubject === "string" ? e.customData.lucidaSubject : "",
            x: Math.round(e.x),
            y: Math.round(e.y),
            w: Math.round(e.width),
            h: Math.round(e.height),
          })),
        proposed: api.getSceneElements().filter((e) => ghostSource(e) === "agent").length,
        viewport: { x: Math.round(-scrollX), y: Math.round(-scrollY), width: Math.round(width / z), height: Math.round(height / z) },
      };
    };

    const agentAddNodes = (nodes: AgentNode[], edges: AgentEdge[]): AgentResult => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      if (!nodes.length && !edges.length) return { count: 0 };
      const ref = (v: number | string) => (typeof v === "number" ? `new:${v}` : v);
      const suggestions: Suggestion[] = [
        ...nodes.map((n): Suggestion => ({ kind: n.kind ?? "rectangle", text: n.text })),
        ...edges.map((e): Suggestion => ({ kind: "arrow", from: ref(e.from), to: ref(e.to), text: e.label })),
      ];
      const summary = summarizeScene(realElements(api), intentRef.current);
      summary.origin = viewCentre(api, summary);
      const created = convertToExcalidrawElements(matchStyle(api, suggestionsToSkeletons(suggestions, summary)), {
        regenerateIds: true,
      });
      const ghosts = asAgentGhosts(created, newProposalId(), "ghost");
      api.updateScene({ elements: [...api.getSceneElements(), ...ghosts] as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      notifyPending();
      return { count: ghosts.length, bounds: boundingBox(ghosts) };
    };

    /** Put one finished picture into a proposal, where its frame stands now. */
    const landPicture = (
      api: ExcalidrawImperativeAPI,
      index: number,
      fallback: Box,
      dataURL: string,
      mimeType: string,
      subject: string,
      pid: string,
      groupIds: string[],
    ) => {
      // The user may have answered while the picture was being drawn: kept
      // the poster (the picture joins it solid) or discarded it (it is dropped).
      const scene = api.getSceneElements();
      const members = scene.filter((e) => e.customData?.lucidaProposal === pid);
      if (groupIds.length && !members.length) {
        api.updateScene({ elements: scene.filter((e) => pendingIndex(e) !== index) as any, captureUpdate: CaptureUpdateAction.NEVER });
        pendingSpots.current.delete(index);
        syncPending();
        return;
      }
      const accepted = members.length > 0 && !members.some(isGhost);
      const fileId = `lucida-img-${Date.now().toString(36)}-${index}`;
      api.addFiles([{ id: fileId, dataURL, mimeType, created: Date.now() } as any]);
      const live = scene.find((e) => pendingIndex(e) === index);
      const box: Box = live ? { x: live.x, y: live.y, width: live.width, height: live.height } : fallback;
      const created = convertToExcalidrawElements(
        [
          {
            type: "image",
            fileId,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            groupIds,
            customData: { lucidaSubject: subject },
          } as unknown as ExcalidrawElementSkeleton,
        ],
        { regenerateIds: true },
      );
      api.updateScene({
        elements: [
          ...api.getSceneElements().filter((e) => pendingIndex(e) !== index),
          ...(accepted ? created : asAgentGhosts(created, pid, "poster")),
        ] as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      pendingSpots.current.delete(index);
      syncPending();
    };

    const agentRenderMasterplan = async (raw: unknown, opts: { images?: boolean } = {}): Promise<AgentResult> => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      if (inFlight.current) throw new Error("the board is busy with another request — try again in a moment");
      const { spec, notes } = normalizeSpec(raw);
      const cloudOn = aiConfigRef.current.provider === "openrouter";
      const wantImages = opts.images !== false;
      if (wantImages && !cloudOn) notes.push("no OpenRouter key in Lucida — laid out without pictures");

      // Nunito is registered lazily; ask for it so measurements use the real face.
      try {
        await Promise.race([document.fonts.load("20px Nunito"), new Promise((r) => window.setTimeout(r, 1200))]);
      } catch {
        // measuring falls back to the estimate
      }

      const pid = newProposalId();
      const layout = layoutMasterplan(spec, {
        origin: freeOrigin(api),
        images: wantImages && cloudOn,
        measure: measureText,
        id: pid,
        house: houseRef.current,
        logo: ensureLogo(api),
      });
      notes.push(...layout.notes);
      let slots = layout.slots;
      if (slots.length > MASTERPLAN_MAX_IMAGES) {
        notes.push(`drew ${MASTERPLAN_MAX_IMAGES} of ${slots.length} pictures`);
        slots = slots.slice(0, MASTERPLAN_MAX_IMAGES);
      }

      const created = convertToExcalidrawElements(layout.skeletons, { regenerateIds: true });
      const poster = asAgentGhosts(created, pid, "poster");
      // Only one agent proposal at a time: a new poster replaces an old one.
      const kept = api.getSceneElements().filter((e) => ghostSource(e) !== "agent");
      api.updateScene({ elements: [...kept, ...poster] as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      agentTitle.current = spec.title;
      try {
        api.scrollToContent(poster as any, { fitToViewport: true, viewportZoomFactor: 0.92, animate: true, duration: 450 });
      } catch {
        // cosmetic
      }
      notifyPending();

      const images = { placed: 0, failed: 0, errors: [] as string[] };
      if (slots.length) {
        inFlight.current = true;
        onBusyChange?.(true);
        const base = 1000; // placeholder indices of their own, clear of Ctrl+I's
        try {
          const frames = convertToExcalidrawElements(
            slots.map(
              (sl) =>
                ({
                  type: "rectangle",
                  x: sl.x,
                  y: sl.y,
                  width: sl.size,
                  height: sl.size,
                  strokeColor: "transparent",
                  backgroundColor: "#99d5f4",
                  fillStyle: "solid",
                }) as ExcalidrawElementSkeleton,
            ),
            { regenerateIds: true },
          ).map((e, i) => ({ ...e, opacity: 15, customData: { lucidaPending: base + i } }));
          slots.forEach((sl, i) => pendingSpots.current.set(base + i, { x: sl.x, y: sl.y, width: sl.size, height: sl.size }));
          api.updateScene({ elements: [...api.getSceneElements(), ...frames] as any, captureUpdate: CaptureUpdateAction.NEVER });
          syncPending();

          // In parallel, and each lands the moment it is ready — the poster
          // fills in while the agent waits, rather than all at once at the end.
          await Promise.all(
            slots.map(async (sl, i) => {
              try {
                const img = await illustrate({ label: slotSubject(sl, spec) }, aiConfigRef.current, {
                  intent: spec.title,
                  style: "house",
                  house: { name: houseRef.current.name, accent: houseRef.current.accent },
                });
                const a = apiRef.current;
                if (!a || !mounted.current) return;
                landPicture(a, base + i, { x: sl.x, y: sl.y, width: sl.size, height: sl.size }, img.dataURL, img.mimeType, sl.subject, pid, sl.groupIds);
                images.placed++;
              } catch (err) {
                images.failed++;
                if (images.errors.length < 3) images.errors.push(`${sl.subject}: ${String(err)}`);
              }
            }),
          );
        } finally {
          const a = apiRef.current;
          if (a) {
            const rest = a.getSceneElements().filter((e) => (pendingIndex(e) ?? 0) < base || (pendingIndex(e) ?? 0) >= base + 1000);
            if (rest.length !== a.getSceneElements().length) {
              a.updateScene({ elements: rest as any, captureUpdate: CaptureUpdateAction.NEVER });
            }
          }
          for (const k of [...pendingSpots.current.keys()]) if (k >= base && k < base + 1000) pendingSpots.current.delete(k);
          pendingRef.current?.set(null);
          inFlight.current = false;
          onBusyChange?.(false);
        }
      }
      syncAgentFrame();
      return { count: poster.length + images.placed, images, notes, bounds: layout.bounds };
    };

    const agentAddImage = async (label: string, near?: string): Promise<AgentResult> => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      if (aiConfigRef.current.provider !== "openrouter") throw new Error("pictures need an OpenRouter key (Lucida → Einstellungen)");
      if (inFlight.current) throw new Error("the board is busy with another request — try again in a moment");
      const subject = label.trim();
      if (!subject) throw new Error("nothing to draw");
      const anchorEl = near ? realElements(api).find((e) => e.id === near) : undefined;
      const origin = freeOrigin(api);
      const size = ILLUSTRATION_SIZE;
      const box: Box = anchorEl
        ? { x: anchorEl.x + anchorEl.width / 2 - size / 2, y: anchorEl.y + anchorEl.height + ILLUSTRATION_GAP, width: size, height: size }
        : { x: origin.x, y: origin.y, width: size, height: size };
      const pid = newProposalId();
      const index = 2000;
      inFlight.current = true;
      onBusyChange?.(true);
      pendingSpots.current.set(index, box);
      const frame = convertToExcalidrawElements(
        [{ type: "rectangle", x: box.x, y: box.y, width: size, height: size, strokeColor: "transparent", backgroundColor: "#99d5f4", fillStyle: "solid" } as ExcalidrawElementSkeleton],
        { regenerateIds: true },
      ).map((e) => ({ ...e, opacity: 15, customData: { lucidaPending: index } }));
      api.updateScene({ elements: [...api.getSceneElements(), ...frame] as any, captureUpdate: CaptureUpdateAction.NEVER });
      syncPending();
      try {
        const img = await illustrate({ label: subject }, aiConfigRef.current, { intent: intentRef.current, style: styleRef.current, house: { name: houseRef.current.name, accent: houseRef.current.accent } });
        if (!mounted.current) throw new Error("the board changed folder while the picture was drawn");
        landPicture(api, index, box, img.dataURL, img.mimeType, subject, pid, []);
        agentTitle.current ||= subject;
        syncAgentFrame();
        notifyPending();
        return { count: 1, bounds: box };
      } finally {
        const rest = api.getSceneElements().filter((e) => pendingIndex(e) !== index);
        if (rest.length !== api.getSceneElements().length) api.updateScene({ elements: rest as any, captureUpdate: CaptureUpdateAction.NEVER });
        pendingSpots.current.delete(index);
        pendingRef.current?.set(null);
        inFlight.current = false;
        onBusyChange?.(false);
      }
    };

    const agentExport = async (scope: "proposal" | "board" | "all" | "map" | "plan"): Promise<AgentExport> => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      const agent = api.getSceneElements().filter((e) => ghostSource(e) === "agent").map(solidify);
      const real = realElements(api);
      const elements =
        scope === "proposal"
          ? agent
          : scope === "board"
            ? real
            : scope === "map"
              ? real.filter((e) => mapOf(e))
              : scope === "plan"
                ? real.filter((e) => planOf(e))
                : [...real, ...agent];
      if (!elements.length) {
        throw new Error(
          scope === "proposal"
            ? "there is no pending proposal to export"
            : scope === "map"
              ? "there is no company map on this board"
              : scope === "plan"
                ? "there is no masterplan on this board"
                : "the board is empty",
        );
      }
      const appState = { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false };
      const b = boundingBox(elements);
      // 2× for print and slides, capped so a huge board stays a sane file.
      const scale = Math.max(1, Math.min(2, 8000 / Math.max(b.width, b.height)));
      const full = await exportToBlob({
        elements: elements as any,
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 24,
        appState,
        getDimensions: (w: number, h: number) => ({ width: w * scale, height: h * scale, scale }),
      });
      const preview = await exportToBlob({
        elements: elements as any,
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 24,
        maxWidthOrHeight: 1568,
        appState,
      });
      return {
        title: scope === "map" ? "company-map" : scope === "plan" ? "masterplan" : scope === "board" ? "" : agentTitle.current,
        png: await blobToBase64(full),
        preview: await blobToBase64(preview),
        width: Math.round((b.width + 48) * scale),
        height: Math.round((b.height + 48) * scale),
      };
    };

    /** Keep the agent's proposal — the frame's button; Ctrl+Enter goes through the App. */
    const agentKeep = () => {
      const api = apiRef.current;
      if (!api) return;
      const ids = new Set(api.getSceneElements().filter((e) => ghostSource(e) === "agent").map((e) => e.id));
      if (ids.size) acceptGhosts(api, ids);
    };

    /* ── Live company map ── */

    // The map on this board, and the fingerprint of the wiki it was drawn from.
    const liveMap = useRef<LiveMap | null>(null);
    const mapStamp = useRef("");
    const mapDay = useRef("");
    const mapBusy = useRef(false);
    // Where a replaced map stood, so its successor lands in the same place.
    const mapOrigin = useRef<{ x: number; y: number } | null>(null);

    /**
     * Draw (or redraw) the map from a wiki snapshot, where the old one stood —
     * the user may have moved it. Unchanged content is not redrawn, so a
     * touched-but-identical page never makes the board flicker.
     */
    const drawCompanyMap = (api: ExcalidrawImperativeAPI, snap: WikiSnapshot, map: LiveMap): { count: number; changed: boolean } => {
      const scene = api.getSceneElements();
      const old = scene.filter((e) => mapOf(e)?.root === map.root);
      const oldPoster = old.find((e) => e.customData?.lucidaMapPoster === true);
      const today = new Date().toISOString().slice(0, 10);
      const layout = layoutCompanyMap(readEntities(snap), {
        restricted: map.restricted,
        today,
        measure: measureText,
        origin: oldPoster ? { x: oldPoster.x, y: oldPoster.y } : (mapOrigin.current ?? freeOrigin(api)),
        id: `map-${Date.now().toString(36)}`,
        house: houseRef.current,
        lang: langRef.current,
        logo: ensureLogo(api),
        sourceLabel: map.root.replace(/^\/Users\/[^/]+/, "~"),
      });
      // the look is part of what is shown: a new name, colour, logo or language redraws
      const sig = `${layout.signature}|${JSON.stringify([houseRef.current, langRef.current, logoRef.current.light.length])}`;
      if (oldPoster?.customData?.lucidaMapSig === sig) return { count: old.length, changed: false };
      const created = convertToExcalidrawElements(layout.skeletons, { regenerateIds: true }).map((e, i) => ({
        ...e,
        // Locked: it is a view of the wiki, redrawn from it — an edit made here
        // would be gone on the next change. Edit the wiki instead.
        locked: true,
        customData: {
          ...(e.customData ?? {}),
          lucidaMap: map,
          ...(i === 0 ? { lucidaMapPoster: true, lucidaMapSig: sig } : {}),
        },
      }));
      const ids = new Set(old.map((e) => e.id));
      api.updateScene({
        elements: [...scene.filter((e) => !ids.has(e.id)), ...created] as any,
        // Not an undo step: undoing a refresh would bring back a stale map.
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      schedulePersist();
      return { count: created.length, changed: true };
    };

    const refreshMap = async (force = false): Promise<{ count: number; changed: boolean }> => {
      const api = apiRef.current;
      const map = liveMap.current;
      if (!api || !map || mapBusy.current) return { count: 0, changed: false };
      mapBusy.current = true;
      try {
        const stamp = await invoke<string>("wiki_stamp", { root: map.root });
        const day = new Date().toISOString().slice(0, 10);
        if (!force && stamp === mapStamp.current && day === mapDay.current) return { count: 0, changed: false };
        const snap = await invoke<WikiSnapshot>("wiki_read", { root: map.root });
        if (!mounted.current || liveMap.current !== map) return { count: 0, changed: false };
        const r = drawCompanyMap(api, snap, map);
        mapStamp.current = stamp;
        mapDay.current = day;
        return r;
      } finally {
        mapBusy.current = false;
      }
    };

    // Poll while a map is on the board. A board opened with a map on it picks
    // the live link straight back up — the map is always current.
    useEffect(() => {
      const id = window.setInterval(() => {
        const api = apiRef.current;
        if (!api) return;
        if (!liveMap.current) {
          const found = api.getSceneElements().map(mapOf).find(Boolean);
          if (!found) return;
          liveMap.current = found;
        }
        void refreshMap().catch((err) => {
          if (import.meta.env.DEV) console.warn("company map refresh failed:", err);
        });
      }, MAP_POLL_MS);
      return () => window.clearInterval(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const companyMap = async (root: string | null, restricted = false): Promise<AgentResult> => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      if (!root) {
        const all = api.getSceneElements();
        const kept = all.filter((e) => !mapOf(e));
        liveMap.current = null;
        mapStamp.current = "";
        api.updateScene({ elements: kept as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        schedulePersist();
        return { count: all.length - kept.length };
      }
      // A map of another wiki replaces this one, in the same place.
      const current = api.getSceneElements().map(mapOf).find(Boolean);
      if (current && current.root !== root) {
        const oldPoster = api.getSceneElements().find((e) => mapOf(e) && e.customData?.lucidaMapPoster);
        mapOrigin.current = oldPoster ? { x: oldPoster.x, y: oldPoster.y } : null;
        api.updateScene({ elements: api.getSceneElements().filter((e) => !mapOf(e)) as any, captureUpdate: CaptureUpdateAction.NEVER });
      }
      liveMap.current = { root, restricted };
      mapStamp.current = "";
      const r = await refreshMap(true);
      const mine = api.getSceneElements().filter((e) => mapOf(e)?.root === root);
      const poster = mine.find((e) => e.customData?.lucidaMapPoster);
      if (poster) {
        try {
          api.scrollToContent(mine as any, { fitToViewport: true, viewportZoomFactor: 0.92, animate: true, duration: 450 });
        } catch {
          // cosmetic
        }
      }
      return { count: r.count, bounds: poster ? { x: poster.x, y: poster.y, width: poster.width, height: poster.height } : undefined };
    };

    /* ── Live plan (wiki/plan — the SSOT) ── */

    const planRoot = useRef<string | null>(null);
    const planLook = useRef<"heist" | "clean">("heist");
    const planModel = useRef<Plan | null>(null);
    const planLayoutRef = useRef<PlanLayout | null>(null);
    const planFiles = useRef(new Map<string, string>());
    const planStampRef = useRef("");
    const planDay = useRef("");
    const planPeople = useRef(new Map<string, string>());
    const planBusy = useRef(false);
    const planSyncTimer = useRef<number | null>(null);
    const inspectorRef = useRef<PlanInspectorHandle | null>(null);
    const inspected = useRef<string | null>(null);

    const todayIso = () => new Date().toISOString().slice(0, 10);
    const planPath = (slug: string) => `${planRoot.current}/wiki/plan/${slug}.md`;

    /** Redraw the whole plan from the model, in place. Ids are stable, so a selection survives. */
    const drawPlan = (api: ExcalidrawImperativeAPI, extraRemove: ReadonlySet<string> = new Set()) => {
      const root = planRoot.current;
      const plan = planModel.current;
      if (!root || !plan) return;
      const scene = api.getSceneElements();
      const poster = scene.find((e) => e.id === "plan-poster" && planOf(e)?.root === root);
      const layout = (planLook.current === "clean" ? layoutPlan : layoutHeist)(plan, {
        root,
        today: todayIso(),
        origin: poster ? { x: poster.x, y: poster.y } : freeOrigin(api),
        people: planPeople.current,
        measure: measureText,
        // the clean look has a dark score band and needs the light mark;
        // the heist dossier is manila and takes the dark one
        house: houseRef.current,
        lang: langRef.current,
        // the clean look has a dark score band; the cork wall's dossier is light
        logo: ensureLogo(api, planLook.current === "clean"),
      });
      const created = convertToExcalidrawElements(layout.skeletons, { regenerateIds: false });
      api.updateScene({
        elements: [...scene.filter((e) => planOf(e)?.root !== root && !extraRemove.has(e.id)), ...created] as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      planLayoutRef.current = layout;
      schedulePersist();
      refreshInspector(api);
    };

    /** Read the plan folder (and the crew from the wiki) and redraw when it changed. */
    const reloadPlan = async (force = false): Promise<number> => {
      const api = apiRef.current;
      const root = planRoot.current;
      if (!api || !root || planBusy.current) return 0;
      planBusy.current = true;
      try {
        const stamp = await invoke<string>("plan_stamp", { root });
        const day = todayIso();
        if (!force && stamp === planStampRef.current && day === planDay.current) return 0;
        const [files, snap] = await Promise.all([
          invoke<Array<{ slug: string; text: string }>>("plan_read", { root }),
          invoke<WikiSnapshot>("wiki_read", { root }).catch(() => null),
        ]);
        if (!mounted.current || planRoot.current !== root) return 0;
        planFiles.current = new Map(files.map((f) => [f.slug, f.text]));
        planModel.current = buildPlan(files);
        if (snap) {
          const team = groupEntities(readEntities(snap)).groups.find((g) => g.key === "team")?.items ?? [];
          planPeople.current = new Map(team.map((e) => [e.slug, e.title]));
        }
        planStampRef.current = stamp;
        planDay.current = day;
        // never pull the board out from under a drag or a text edit
        if (!pointerDown.current && !api.getAppState().editingTextElement) drawPlan(api);
        return files.length;
      } finally {
        planBusy.current = false;
      }
    };

    /** Write patches to their files, then redraw from what is on disk now. */
    const writePlan = async (
      patches: Map<string, PlanPatch>,
      creates: Array<{ slug: string; text: string }> = [],
      remove: ReadonlySet<string> = new Set(),
    ) => {
      const root = planRoot.current;
      if (!root || (!patches.size && !creates.length)) return;
      const today = todayIso();
      try {
        for (const [slug, patch] of patches) {
          const raw = planFiles.current.get(slug);
          if (raw === undefined) continue;
          await invoke("plan_write", { root, slug, text: patchPlanFile(raw, patch, today) });
        }
        for (const c of creates) await invoke("plan_write", { root, slug: c.slug, text: c.text });
      } catch (err) {
        onError?.(`Plan: ${String(err)}`);
      }
      planStampRef.current = "";
      await reloadPlan(true);
      const api = apiRef.current;
      if (api && remove.size) drawPlan(api, remove);
    };

    const patchOne = (slug: string, patch: PlanPatch) => void writePlan(new Map([[slug, patch]]));

    /** What the user did on the board, written back to the files (see diffPlanBoard). */
    const syncPlanFromBoard = () => {
      const api = apiRef.current;
      const plan = planModel.current;
      const layout = planLayoutRef.current;
      if (!api || !planRoot.current || !plan || !layout) return;
      if (pointerDown.current || api.getAppState().editingTextElement) return;
      const { patches, creates, remove, drifted } = diffPlanBoard(api.getSceneElements() as any, plan, layout, {
        today: todayIso(),
        exists: (slug) => planFiles.current.has(slug),
      });
      if (patches.size || creates.length) void writePlan(patches, creates, remove);
      else if (remove.size) drawPlan(api, remove);
      // nothing understood: put anything that was dragged back where it belongs
      else if (drifted) drawPlan(api);
    };

    const schedulePlanSync = (ms: number) => {
      if (!planRoot.current) return;
      if (planSyncTimer.current) window.clearTimeout(planSyncTimer.current);
      planSyncTimer.current = window.setTimeout(() => {
        planSyncTimer.current = null;
        syncPlanFromBoard();
      }, ms);
    };

    /** Open the inspector on the one plan item selected, close it otherwise. */
    const refreshInspector = (api: ExcalidrawImperativeAPI) => {
      const plan = planModel.current;
      if (!plan || !planRoot.current) {
        if (inspected.current) inspectorRef.current?.set(null);
        inspected.current = null;
        return;
      }
      const sel = api.getAppState().selectedElementIds;
      const slugs = new Set(
        api
          .getSceneElements()
          .filter((e) => sel[e.id])
          .map((e) => planOf(e))
          .filter((t): t is PlanTag => !!t?.slug && t.role !== "crew")
          .map((t) => t.slug!),
      );
      const slug = slugs.size === 1 ? [...slugs][0] : null;
      const item = slug ? plan.bySlug.get(slug) : undefined;
      if (!item) {
        if (inspected.current) inspectorRef.current?.set(null);
        inspected.current = null;
        return;
      }
      inspected.current = item.slug;
      inspectorRef.current?.set({
        item,
        crew: [...planPeople.current.entries()].sort((a, b) => a[1].localeCompare(b[1])),
        waits: (item.kind === "risk" ? item.affects : item.depends_on).map((d) => {
          const w = plan.bySlug.get(d);
          return { slug: d, title: w?.title ?? d, done: w?.status === "done" };
        }),
        path: planPath(item.slug),
      });
    };

    // Poll while a plan is on the board; pick it back up when the board is reopened.
    useEffect(() => {
      const id = window.setInterval(() => {
        const api = apiRef.current;
        if (!api) return;
        if (!planRoot.current) {
          const found = api.getSceneElements().map(planOf).find(Boolean);
          if (!found) return;
          planRoot.current = found.root;
        }
        void reloadPlan().catch((err) => {
          if (import.meta.env.DEV) console.warn("plan refresh failed:", err);
        });
      }, PLAN_POLL_MS);
      return () => {
        window.clearInterval(id);
        if (planSyncTimer.current) window.clearTimeout(planSyncTimer.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const planBoard = async (root: string | null, look?: "heist" | "clean"): Promise<AgentResult> => {
      const api = apiRef.current;
      if (!api) throw new Error("canvas not ready");
      if (look) planLook.current = look;
      // the wall is hand-written and typewritten; measure with the real faces
      try {
        await Promise.race([
          Promise.all([document.fonts.load("20px Excalifont"), document.fonts.load("14px Cascadia")]),
          new Promise((r) => window.setTimeout(r, 1500)),
        ]);
      } catch {
        // estimates are conservative
      }
      if (!root) {
        const all = api.getSceneElements();
        const kept = all.filter((e) => !planOf(e));
        planRoot.current = null;
        planModel.current = null;
        planLayoutRef.current = null;
        api.updateScene({ elements: kept as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        schedulePersist();
        return { count: all.length - kept.length };
      }
      planRoot.current = root;
      planStampRef.current = "";
      const files = await reloadPlan(true);
      if (!files) throw new Error(`no plan files in ${root}/wiki/plan — create plan/goal.md first`);
      const els = api.getSceneElements().filter((e) => planOf(e)?.root === root);
      try {
        api.scrollToContent(els as any, { fitToViewport: true, viewportZoomFactor: 0.92, animate: true, duration: 450 });
      } catch {
        // cosmetic
      }
      return { count: els.length, bounds: planLayoutRef.current?.bounds };
    };

    // The organisation's look or the language changed in the settings: the
    // live boards on this board redraw in it right away.
    const lookSig = JSON.stringify([house, lang, logo.length, logoDark.length]);
    const lastLook = useRef(lookSig);
    useEffect(() => {
      if (lastLook.current === lookSig) return;
      lastLook.current = lookSig;
      const api = apiRef.current;
      if (!api) return;
      if (planRoot.current && planModel.current) drawPlan(api);
      if (liveMap.current) void refreshMap(true).catch(() => {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lookSig]);

    const agentDiscard = (): number => {
      const api = apiRef.current;
      if (!api) return 0;
      const all = api.getSceneElements();
      const kept = all.filter((e) => ghostSource(e) !== "agent");
      if (kept.length !== all.length) {
        api.updateScene({ elements: kept as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        agentTitle.current = "";
        agentFrameRef.current?.set(null);
        notifyPending();
      }
      return all.length - kept.length;
    };

    useImperativeHandle(
      ref,
      (): WhiteboardHandle => ({
        agentBoard,
        agentAddNodes,
        agentRenderMasterplan,
        agentAddImage,
        agentExport,
        agentDiscard,
        companyMap,
        planBoard,
        async suggest(_intent?: string, tier: SuggestTier = "full"): Promise<SuggestResult> {
          const api = apiRef.current;
          if (!api) return { count: 0, error: "canvas not ready" };
          if (inFlight.current) return { count: 0 };

          // A deliberate request supersedes any auto prediction in progress.
          cancelAuto();

          inFlight.current = true;
          onBusyChange?.(true);
          try {
            const count = await runSuggest(api, tier, "manual");
            return { count };
          } catch (err) {
            if (import.meta.env.DEV) console.warn("suggest failed:", err);
            return { count: 0, error: String(err) };
          } finally {
            inFlight.current = false;
            onBusyChange?.(false);
          }
        },

        illustrate(): Promise<SuggestResult> {
          return illustrateSelection();
        },

        acceptSuggestions(): void {
          const api = apiRef.current;
          if (!api) return;
          const next = api.getSceneElements().map((e) => (isGhost(e) ? solidify(e) : e));
          api.updateScene({
            elements: next as any,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          recordFeedback("accepted");
          lastAutoSig.current = "";
          notifyPending();
        },

        dismissSuggestions(): void {
          const api = apiRef.current;
          if (!api) return;
          cancelAuto();
          lastAutoSig.current = "";
          const next = api.getSceneElements().filter((e) => !isGhost(e));
          api.updateScene({
            elements: next as any,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          recordFeedback("dismissed");
          notifyPending();
        },

        hasPendingSuggestions(): boolean {
          const api = apiRef.current;
          return api ? api.getSceneElements().some(isGhost) : false;
        },
      }),
      [aiConfig, onBusyChange, onAutoThinkingChange, onPendingChange],
    );

    // Excalidraw keeps these props across its own renders; handing it a fresh
    // closure on every render is what makes an in-flight stroke break, so each
    // handler is captured once and reads the live values through refs.
    const handlers = useRef({
      handlePointerDown,
      handlePointerUpdate,
      handlePointerUp,
      handleChange,
      illustrateSelection,
      submitEdit,
      rerollEdit,
      agentKeep,
      agentDiscard,
      patchOne,
    });
    handlers.current = {
      handlePointerDown,
      handlePointerUpdate,
      handlePointerUp,
      handleChange,
      illustrateSelection,
      submitEdit,
      rerollEdit,
      agentKeep,
      agentDiscard,
      patchOne,
    };

    const bindApi = useCallback((api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
    }, []);

    // Parsed once per mount; the App remounts this component when the folder
    // changes, so a board never bleeds from one project into another.
    const initialScene = useRef(
      (() => {
        if (!initialBoard) return null;
        try {
          const parsed = JSON.parse(initialBoard) as Record<string, unknown>;
          return restore(parsed as any, null, null, { repairBindings: true });
        } catch {
          return null;
        }
      })(),
    ).current;
    const onPointerDownStable = useCallback(
      (activeTool: { type: string }) => handlers.current.handlePointerDown(activeTool),
      [],
    );
    const onPointerUpdateStable = useCallback(
      (payload: { button: "down" | "up" }) => handlers.current.handlePointerUpdate(payload),
      [],
    );
    const onPointerUpStable = useCallback(
      (activeTool: { type: string }, pds: unknown) =>
        handlers.current.handlePointerUp(activeTool, pds),
      [],
    );
    const onChangeStable = useCallback(() => handlers.current.handleChange(), []);
    const onChip = useCallback(() => {
      void handlers.current.illustrateSelection().then((r) => r.error && onError?.(r.error));
    }, [onError]);
    const onReroll = useCallback(() => {
      void handlers.current.rerollEdit();
    }, []);
    const onAgentKeep = useCallback(() => handlers.current.agentKeep(), []);
    const onPlanPatch = useCallback((slug: string, patch: PlanPatch) => handlers.current.patchOne(slug, patch), []);
    const onPlanReveal = useCallback((path: string) => {
      void revealItemInDir(path).catch((err) => onError?.(String(err)));
    }, [onError]);
    const onPlanObsidian = useCallback((path: string) => {
      void openUrl(`obsidian://open?path=${encodeURIComponent(path)}`).catch((err) => onError?.(String(err)));
    }, [onError]);
    const onAgentDiscard = useCallback(() => {
      handlers.current.agentDiscard();
    }, []);
    const onSubmitEdit = useCallback((instruction: string) => {
      void handlers.current.submitEdit(instruction);
    }, []);

    return (
      <div style={{ width: "100%", height: "100%", position: "relative" }}>
        <Excalidraw
          initialData={initialScene}
          theme={theme}
          excalidrawAPI={bindApi}
          onChange={onChangeStable}
          onPointerDown={onPointerDownStable}
          onPointerUpdate={onPointerUpdateStable}
          onPointerUp={onPointerUpStable}
          // The canvas is Lucida's, not a third party's: no foreign branding,
          // no links out, no scene import that would replace the board its
          // folder owns. Only the actions that belong to a board stay.
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              toggleTheme: false,
              saveAsImage: true,
              changeViewBackgroundColor: true,
              clearCanvas: true,
            },
          }}
        >
          <MainMenu>
            <MainMenu.Item onSelect={() => onPickFolder?.()}>{T.menuFolder}</MainMenu.Item>
            {isWiki && <MainMenu.Item onSelect={() => onPlanBoard?.()}>{T.menuPlan}</MainMenu.Item>}
            {isWiki && <MainMenu.Item onSelect={() => onCompanyMap?.()}>{T.menuMap}</MainMenu.Item>}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => onOpenSettings?.()} shortcut="Ctrl+,">
              {T.menuSettings}
            </MainMenu.Item>
            <MainMenu.DefaultItems.ClearCanvas />
          </MainMenu>
        </Excalidraw>
        <ShadowOverlay ref={shadowRef} />
        <AgentFrameOverlay ref={agentFrameRef} onKeep={onAgentKeep} onDiscard={onAgentDiscard} T={T} />
        <PlanInspector ref={inspectorRef} lang={lang} onPatch={onPlanPatch} onReveal={onPlanReveal} onObsidian={onPlanObsidian} />
        <PendingOverlay ref={pendingRef} />
        <EditBar ref={editRef} onSubmit={onSubmitEdit} onReroll={onReroll} T={T} />
        <ImageChip ref={chipRef} onGo={onChip} T={T} />
      </div>
    );
  },
);

Whiteboard.displayName = "Whiteboard";

export default Whiteboard;
