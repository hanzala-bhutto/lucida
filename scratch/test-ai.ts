/**
 * Standalone test for the AI engine's pure parts (run: npx tsx scratch/test-ai.ts).
 * Exercises parseSuggestions against real model output shapes, then
 * summarizeScene + suggestionsToSkeletons. No Tauri runtime needed (we never
 * call suggestNext/illustrate, the only functions that hit the network).
 */
import {
  parseSuggestions,
  summarizeScene,
  suggestionsToSkeletons,
  resolveTarget,
  filterByConfidence,
  parseImageDataUrl,
  parseImagesResponse,
  buildIllustratePrompt,
  cloudHeaders,
  inferLayout,
  parseGate,
  gateHint,
  gateState,
  strokeFeatures,
  strokeState,
  parseStrokePrediction,
} from "../src/lib/ai";
import { recentSpeech } from "../src/lib/listen";
import type { AiConfig, SceneSummary } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

// 1. The ACTUAL bare-array output the running 3B sidecar returned (no wrapper).
const bareArray =
  '[{"kind":"ellipse","text":"Review","from":"a","rationale":"x"}, ' +
  '{"kind":"diamond","text":"Decision","from":"a","to":"new:2","rationale":"y"}, ' +
  '{"kind":"text","text":"Plan","from":"new:2","to":"new:3","rationale":"z"}]';
const a = parseSuggestions(bareArray);
check("bare array parses to 3 suggestions", a.length === 3, `got ${a.length}`);
check("bare array kinds correct", a.map((s) => s.kind).join(",") === "ellipse,diamond,text");

// 2. The wrapped object form (what the prompt asks for).
const wrapped = '{"suggestions":[{"kind":"rectangle","text":"Test"},{"kind":"arrow","from":"a","to":"new:0"}]}';
const b = parseSuggestions(wrapped);
check("wrapped object parses to 2", b.length === 2, `got ${b.length}`);

// 3. Fenced markdown form.
const fenced = '```json\n{"suggestions":[{"kind":"ellipse","text":"Cache"}]}\n```';
const c = parseSuggestions(fenced);
check("fenced form parses to 1", c.length === 1, `got ${c.length}`);

// 4. Garbage returns [] (never throws).
check("garbage -> []", parseSuggestions("sorry, I cannot do that").length === 0);
check("truncated json -> []", parseSuggestions('{"suggestions":[{"kind":').length === 0);

// 4b. Arrow index remap: an invalid item before the nodes must not desync
// "new:<i>" references (orig: invalid=0, Build=1, Deploy=2, arrow.to=new:2).
const desync =
  '[{"kind":"banana"},{"kind":"rectangle","text":"Build"},' +
  '{"kind":"rectangle","text":"Deploy"},{"kind":"arrow","from":"a","to":"new:2"}]';
const ds = parseSuggestions(desync);
const dsArrow = ds.find((s) => s.kind === "arrow");
check("remap: invalid dropped, 3 kept", ds.length === 3, `got ${ds.length}`);
check('remap: arrow.to rewritten "new:2" -> "new:1" (Deploy)', dsArrow?.to === "new:1", `got ${dsArrow?.to}`);

// 5. summarizeScene: a labeled rectangle + a standalone text + a bound arrow.
const mockElements = [
  { id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
  { id: "t1", type: "text", x: 10, y: 30, width: 60, height: 20, text: "Build", containerId: "a" },
  { id: "b", type: "ellipse", x: 300, y: 0, width: 160, height: 80 },
  { id: "note", type: "text", x: 0, y: 200, width: 80, height: 20, text: "Note", containerId: null },
  { id: "arr", type: "arrow", x: 0, y: 0, width: 1, height: 1, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
  { id: "ink", type: "freedraw", x: 0, y: 0, width: 1, height: 1 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;
const summary = summarizeScene(mockElements, "a CI pipeline");
check("summarize: 3 nodes (rect+ellipse+standalone text, skips freedraw)", summary.nodes.length === 3, JSON.stringify(summary.nodes.map((n) => n.id)));
check("summarize: rect borrowed its bound label 'Build'", summary.nodes.find((n) => n.id === "a")?.text === "Build");
check("summarize: 1 edge a->b", summary.edges.length === 1 && summary.edges[0].from === "a" && summary.edges[0].to === "b");
check("summarize: intent carried", summary.intent === "a CI pipeline");

// 6. suggestionsToSkeletons: rectangle + arrow binding to it (new:0) + arrow from existing 'a'.
const scene: SceneSummary = { nodes: [{ id: "a", type: "rectangle", text: "Build", x: 0, y: 0, w: 160, h: 80 }], edges: [] };
const skels = suggestionsToSkeletons(
  [
    { kind: "rectangle", text: "Test" },
    { kind: "arrow", from: "a", to: "new:0", text: "then" },
  ],
  scene,
);
const rectSkel = skels.find((s) => s.type === "rectangle") as any;
const arrowSkel = skels.find((s) => s.type === "arrow") as any;
check("skeletons: rectangle emitted with id + label", !!rectSkel && rectSkel.id === "sugg-0" && rectSkel.label?.text === "Test");
check("skeletons: arrow emitted", !!arrowSkel);
check("skeletons: arrow has 2 points", Array.isArray(arrowSkel?.points) && arrowSkel.points.length === 2);
check("skeletons: arrow END binds to batch node sugg-0", arrowSkel?.end?.id === "sugg-0");
check("skeletons: arrow START not bound (existing scene node = geometric)", arrowSkel?.start === undefined);
check("skeletons: node emitted before arrow", skels.findIndex((s) => s.type === "rectangle") < skels.findIndex((s) => s.type === "arrow"));


// 7. Cloud vs local routing (pure — no network).
const localCfg: AiConfig = {
  provider: "local",
  baseUrl: "http://127.0.0.1:8765",
  model: "Qwen/Qwen2.5-3B-Instruct-GGUF",
  cloud: { apiKey: "", model: "", fastModel: "", imageModel: "" },
  autoSuggest: false,
};
const cloudCfg: AiConfig = {
  ...localCfg,
  provider: "openrouter",
  cloud: { apiKey: " sk-or-test ", model: "anthropic/claude-sonnet-5", fastModel: "anthropic/claude-haiku-4.5", imageModel: "" },
};
const lt = resolveTarget(localCfg);
check("target: local hits the sidecar, unstructured, no auth", lt.url === "http://127.0.0.1:8765/v1/chat/completions" && !lt.structured && !("authorization" in lt.headers));
const ct = resolveTarget(cloudCfg, "full");
check("target: cloud hits OpenRouter with bearer + structured", ct.url === "https://openrouter.ai/api/v1/chat/completions" && ct.structured && ct.headers.authorization === "Bearer sk-or-test");
check("target: full tier uses the big model", ct.model === "anthropic/claude-sonnet-5");
check("target: fast tier uses the fast model", resolveTarget(cloudCfg, "fast").model === "anthropic/claude-haiku-4.5");
check("target: empty fast model falls back to a default", resolveTarget({ ...cloudCfg, cloud: { ...cloudCfg.cloud, fastModel: "" } }, "fast").model.length > 0);
const hFull = cloudHeaders("k", { attribution: true, origin: true });
check("headers: full variant carries attribution, no Origin override", "HTTP-Referer" in hFull && !("origin" in hFull));
const hBare = cloudHeaders("k", { attribution: false, origin: false });
check("headers: bare variant drops attribution and blanks Origin", !("HTTP-Referer" in hBare) && hBare.origin === "" && hBare.authorization === "Bearer k");
check("target: transport from config reaches the headers", !("X-Title" in resolveTarget({ ...cloudCfg, cloud: { ...cloudCfg.cloud, transport: { attribution: false, origin: true } } }).headers));
let threw = false;
try {
  resolveTarget({ ...cloudCfg, cloud: { ...cloudCfg.cloud, apiKey: "  " } });
} catch {
  threw = true;
}
check("target: cloud without key throws", threw);

// 8. Confidence gating keeps arrow refs pointing at the surviving nodes.
const rated = parseSuggestions(
  '{"suggestions":[{"kind":"rectangle","text":"weak","confidence":0.3},' +
    '{"kind":"rectangle","text":"strong","confidence":0.9},' +
    '{"kind":"arrow","from":"a","to":"new:1","confidence":0.9},' +
    '{"kind":"text","text":"unrated"}]}',
  10,
);
check("confidence: parsed + clamped onto the suggestion", rated[1].confidence === 0.9);
const gated = filterByConfidence(rated, 0.6);
check("confidence: weak + unrated dropped, 2 kept", gated.length === 2, `got ${gated.length}`);
check('confidence: arrow re-pointed "new:1" -> "new:0"', gated.find((s) => s.kind === "arrow")?.to === "new:0");
check("confidence: null fields from strict schema tolerated", parseSuggestions('{"suggestions":[{"kind":"ellipse","text":null,"x":null,"from":null,"confidence":0.7}]}')[0]?.kind === "ellipse");
check("parse: cap honoured", parseSuggestions('[{"kind":"text"},{"kind":"text"},{"kind":"text"}]', 2).length === 2);

// 9. Recent + history ride along in the summary.
const stamped = [
  { id: "old", type: "rectangle", x: 0, y: 0, width: 10, height: 10, updated: 1 },
  { id: "new", type: "rectangle", x: 0, y: 0, width: 10, height: 10, updated: 5 },
  { id: "mid", type: "ellipse", x: 0, y: 0, width: 10, height: 10, updated: 3 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;
const s9 = summarizeScene(stamped, undefined, [{ kind: "rectangle", text: "Deploy", outcome: "dismissed" }]);
check("summary: recent ordered newest first by `updated`", s9.recent?.join(",") === "new,mid,old", s9.recent?.join(","));
check("summary: history carried", s9.history?.[0]?.outcome === "dismissed");
check("summary: no stamps -> array order, newest last first", summarizeScene(mockElements).recent?.[0] === "note");

// 10. Illustrate: response parsing + prompt.
const png = "data:image/png;base64,iVBORw0KGgo=";
check("image: OpenRouter images[] shape", parseImageDataUrl({ choices: [{ message: { images: [{ type: "image_url", image_url: { url: png } }] } }] })?.mimeType === "image/png");
check("image: inline data URL in content", parseImageDataUrl({ choices: [{ message: { content: `here ![x](${png.replace("png", "webp")}) done` } }] })?.mimeType === "image/webp");
check("image: text-only response -> null", parseImageDataUrl({ choices: [{ message: { content: "I cannot draw." } }] }) === null);
const imgRes = parseImagesResponse({ created: 1, data: [{ b64_json: "iVBORw0KGgo=", media_type: "image/png" }], usage: { cost: 0.03 } });
check("images endpoint: b64_json + media_type become a data URL", imgRes?.mimeType === "image/png" && imgRes.dataURL.startsWith("data:image/png;base64,iVBOR"), JSON.stringify(imgRes)?.slice(0, 80));
check("images endpoint: unknown media type falls back to png", parseImagesResponse({ data: [{ b64_json: "AAAA", media_type: "image/svg+xml" }] })?.mimeType === "image/png");
check("images endpoint: webp kept", parseImagesResponse({ data: [{ b64_json: "AAAA", media_type: "image/webp" }] })?.mimeType === "image/webp");
check("images endpoint: empty or wrong shape -> null", parseImagesResponse({ data: [] }) === null && parseImagesResponse({ choices: [] }) === null);
check("images endpoint: first usable row wins", parseImagesResponse({ data: [{ media_type: "image/png" }, { b64_json: "BBBB", media_type: "image/png" }] })?.dataURL.endsWith("BBBB") === true);
check("prompt: style changes the look line", /pencil sketch/.test(buildIllustratePrompt({ label: "Haus" }, undefined, "sketch")) && /Photorealistic/.test(buildIllustratePrompt({ label: "Haus" }, undefined, "photo")));
check("prompt: every style keeps the no-text guard", (["flat","sketch","doodle","isometric","photo"] as const).every((st) => /No text/.test(buildIllustratePrompt({ label: "x" }, undefined, st))));

// 11. Placement follows the drawing.
const flowScene: SceneSummary = {
  nodes: [
    { id: "a", type: "rectangle", text: "A", x: 0, y: 0, w: 120, h: 60 },
    { id: "b", type: "rectangle", text: "B", x: 200, y: 0, w: 120, h: 60 },
  ],
  edges: [{ from: "a", to: "b" }],
  recent: ["b", "a"],
};
const lay = inferLayout(flowScene);
check("layout: rightward flow, user's size, measured gap", lay.dir[0] === 1 && lay.w === 120 && lay.h === 60 && lay.gap === 80, JSON.stringify(lay));
const grown = suggestionsToSkeletons(
  [{ kind: "rectangle", text: "C" }, { kind: "arrow", from: "b", to: "new:0" }],
  flowScene,
) as any[];
const cNode = grown.find((k) => k.type === "rectangle");
check("placement: arrow target sits one gap right of its source, same size", cNode.x === 400 && cNode.y === 0 && cNode.width === 120 && cNode.height === 60, JSON.stringify({ x: cNode.x, y: cNode.y, w: cNode.width }));
const downScene: SceneSummary = {
  nodes: [
    { id: "a", type: "ellipse", text: "A", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", type: "ellipse", text: "B", x: 0, y: 160, w: 100, h: 100 },
  ],
  edges: [{ from: "a", to: "b" }],
  recent: ["b", "a"],
};
const down = suggestionsToSkeletons([{ kind: "ellipse", text: "C" }], downScene) as any[];
check("placement: downward flow → free node below the last one", down[0].y === 320 && down[0].x === 0, JSON.stringify({ x: down[0].x, y: down[0].y }));
const two = suggestionsToSkeletons([{ kind: "rectangle", text: "C" }, { kind: "rectangle", text: "D" }], flowScene) as any[];
check("placement: two free nodes never overlap", !(two[0].x === two[1].x && two[0].y === two[1].y));
const crowded: SceneSummary = { ...flowScene, nodes: [...flowScene.nodes, { id: "z", type: "rectangle", text: "Z", x: 400, y: 0, w: 120, h: 60 }] };
const dodged = suggestionsToSkeletons([{ kind: "rectangle", text: "C" }, { kind: "arrow", from: "b", to: "new:0" }], crowded) as any[];
const cd = dodged.find((k) => k.type === "rectangle");
check("placement: occupied spot → nudged sideways, not stacked on Z", !(cd.x === 400 && cd.y === 0), JSON.stringify({ x: cd.x, y: cd.y }));

// 12. Listen: recent speech window + tail.
const now = 1_000_000;
const segs = [
  { t: now - 200, text: "old thought about lunch" },
  { t: now - 30, text: "first we build the image" },
  { t: now - 5, text: "then we test it" },
];
check("speech: outside the window is dropped, rest joined in order", recentSpeech(segs, now) === "first we build the image then we test it");
check("speech: long text keeps a whole-word tail", recentSpeech([{ t: now, text: "alpha beta gamma delta" }], now, 90, 11) === "gamma delta");
check("summary: spoken carried", summarizeScene(mockElements, undefined, undefined, " hello ").spoken === "hello");

// 13. Gate: answer parsing, hint, state.
const g = parseGate({ answers: { ready: { type: "noul", noul: 0.83 }, kind: { type: "choice", choice: "diamond", probabilities: {} }, diagram: { type: "choice", choice: "flowchart" } } });
check("gate: ready + kind + diagram parsed", g?.ready === 0.83 && g?.kind === "diamond" && g?.diagram === "flowchart", JSON.stringify(g));
check("gate: unknown choice ignored, ready kept", parseGate({ answers: { ready: { noul: 0.4 }, kind: { choice: "banana" } } })?.kind === undefined);
check("gate: garbage -> null", parseGate({ error: "x" }) === null && parseGate(null) === null);
check("gate: hint names the kind", /diamond/.test(gateHint({ ready: 0.9, kind: "diamond" }) ?? ""));
check("gate: 'none' gives no hint", gateHint({ ready: 0.9, kind: "none" }) === undefined);
const gs = gateState({ ...flowScene, spoken: "and then deploy" });
check("gate: state has labels, last drawn, speech, no coordinates", /A \| B/.test(gs) && /Last drawn: rectangle "B"/.test(gs) && /deploy/.test(gs) && !/"x":/.test(gs), gs);

// 14. Live stroke prediction: features, state, answer parsing.
const emptyScene: SceneSummary = { nodes: [], edges: [] };
const square: [number, number][] = [
  [0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100],
  [0, 100], [0, 50], [2, 4],
];
const sf = strokeFeatures(square, emptyScene)!;
check("stroke: closed box → closed, 4-ish corners, low straightness", sf.closed && sf.corners >= 3 && sf.straightness < 0.2, JSON.stringify({ closed: sf.closed, corners: sf.corners, s: +sf.straightness.toFixed(2) }));
check("stroke: bbox measured", sf.x === 0 && sf.y === 0 && sf.w === 100 && sf.h === 100);
const lineF = strokeFeatures([[0, 0], [30, 1], [60, 0], [90, 1]], emptyScene)!;
check("stroke: straight line → open, straightness ~1, heading right", !lineF.closed && lineF.straightness > 0.95 && Math.abs(lineF.heading) < 5, JSON.stringify({ s: +lineF.straightness.toFixed(2), h: +lineF.heading.toFixed(1) }));
check("stroke: too few points → null", strokeFeatures([[0, 0], [1, 1]], emptyScene) === null);
const linked = strokeFeatures([[10, 10], [80, 15], [150, 12], [205, 14]], flowScene)!;
check("stroke: start node and target node recognised", linked.startNodeId === "a" && linked.endNodeId === "b", JSON.stringify({ from: linked.startNodeId, to: linked.endNodeId }));
const st = strokeState(linked, { ...flowScene, spoken: "and this leads to B" });
check("stroke: state names both nodes, direction and speech, no raw coords", /started on rectangle "A"/.test(st) && /ends on rectangle "B"/.test(st) && /rightwards/.test(st) && /leads to B/.test(st) && !/"x":/.test(st), st);

const sp = parseStrokePrediction({ answers: { shape: { type: "choice", choice: "arrow", confidence: 0.91 }, target: { type: "choice", choice: "b" } } });
check("stroke: arrow + target parsed with confidence", sp?.kind === "arrow" && sp?.confidence === 0.91 && sp?.targetId === "b", JSON.stringify(sp));
check("stroke: target ignored when the shape is not an arrow", parseStrokePrediction({ answers: { shape: { choice: "ellipse", confidence: 0.7 }, target: { choice: "b" } } })?.targetId === undefined);
check("stroke: 'none' target dropped", parseStrokePrediction({ answers: { shape: { choice: "arrow", confidence: 0.7 }, target: { choice: "none" } } })?.targetId === undefined);
check("stroke: unknown shape → null", parseStrokePrediction({ answers: { shape: { choice: "banana", confidence: 1 } } }) === null);
check("stroke: handwriting verdict survives parsing", parseStrokePrediction({ answers: { shape: { choice: "text", confidence: 0.8 } } })?.kind === "text");
// The handwriting noul is its own dimension and outranks the shape class.
const hwWins = parseStrokePrediction({ answers: { shape: { choice: "rectangle", confidence: 0.55 }, handwriting: { type: "noul", noul: 0.93 } } });
check("stroke: a sure handwriting answer overrides the shape choice", hwWins?.kind === "text" && hwWins.confidence === 0.93, JSON.stringify(hwWins));
const hwLow = parseStrokePrediction({ answers: { shape: { choice: "rectangle", confidence: 0.88 }, handwriting: { noul: 0.2 } } });
check("stroke: a low handwriting answer leaves the shape alone", hwLow?.kind === "rectangle" && hwLow.handwriting === 0.2);
check("stroke: a target is only kept for an arrow", parseStrokePrediction({ answers: { shape: { choice: "line", confidence: 0.9 }, target: { choice: "b" } } })?.targetId === undefined);

const prompt = buildIllustratePrompt({ label: " Haus " }, "Immobilien-Mindmap");
check("prompt: label + intent + no-text rule", prompt.includes('"Haus"') && prompt.includes("Immobilien-Mindmap") && /no text/i.test(prompt));
const sketchPrompt = buildIllustratePrompt({ sketch: "data:image/png;base64,AAAA" });
check("prompt: sketch asks to draw the thing, not the handwriting", /handwriting/.test(sketchPrompt) && /not the handwriting itself/.test(sketchPrompt));
check("prompt: sketch + label names the label", buildIllustratePrompt({ sketch: "data:image/png;base64,AAAA", label: "Baum" }).includes('"Baum"'));
const editPrompt = buildIllustratePrompt({ label: "Haus", edit: { image: "data:image/png;base64,AAAA", instruction: " make the roof red " } }, undefined, "doodle");
check("prompt: an edit names the change and pins everything else", /Change exactly this: make the roof red/.test(editPrompt) && /Keep everything else identical/.test(editPrompt), editPrompt.slice(0, 120));
check("prompt: an edit still carries the style and the guards", /whiteboard-marker doodle/.test(editPrompt) && /No text/.test(editPrompt));
check("prompt: an edit mentions the subject it is changing", editPrompt.includes('It shows "Haus"'));

console.log(failures === 0 ? "\nALL AI CASES PASSED" : `\n${failures} AI CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
