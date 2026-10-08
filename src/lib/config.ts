/**
 * Shared runtime configuration. The Rust sidecar (src-tauri) MUST agree with
 * these values — the same port + model id are hard-defaults on both sides and
 * overridable via the LUCIDA_AI_PORT / LUCIDA_AI_MODEL env vars at launch.
 */
export const DEFAULT_AI_PORT = 8765;
export const DEFAULT_AI_MODEL = "Qwen/Qwen2.5-3B-Instruct-GGUF";
export const DEFAULT_AI_BASE_URL = `http://127.0.0.1:${DEFAULT_AI_PORT}`;

/** Visual treatment for not-yet-accepted AI suggestions ("ghost" elements). */
export const GHOST_OPACITY = 35;

/* ───────────────────────────  Board API (agents, MCP)  ─────────────────────────── */

/** The Rust side serves the board API here; LUCIDA_BOARD_PORT overrides it. */
export const DEFAULT_BOARD_PORT = 8767;
/**
 * A masterplan is judged by how it looks, and nobody can judge a poster at a
 * third of its opacity — so a finished infographic is proposed at full
 * strength and marked as a proposal by a frame around it instead. Loose nodes
 * an agent adds stay faint and dashed, exactly like a suggestion.
 */
export const AGENT_POSTER_OPACITY = 100;
/** Pictures on one poster; each is ~17 s and a few cents, generated in parallel. */
export const MASTERPLAN_MAX_IMAGES = 9;

/* ───────────────────────────  Optional cloud models (OpenRouter)  ─────────────────────────── */

/**
 * Opt-in only. When the provider is "openrouter" the scene summary leaves the
 * machine — the panel says so in plain words, and "local" stays the default.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Image models live on their own endpoint. The chat endpoint refuses them
 * outright ("cannot be used with the chat/completions endpoint"), so this is
 * the path Illustrate takes; the chat endpoint stays as a fallback for models
 * that only speak it.
 */
export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
/**
 * Both text tiers run on Gemini 3.7 Flash: a million tokens of context, JSON
 * schema constraint, and cheap enough that predicting after every stroke is
 * not something to ration.
 */
export const DEFAULT_CLOUD_MODEL = "google/gemini-3.7-flash";
export const DEFAULT_CLOUD_FAST_MODEL = "google/gemini-3.7-flash";
/**
 * Illustrate — must be a model OpenRouter serves on its images endpoint.
 *
 * Flare is the speed tier of GPT Image 2.5, the same family as Sunburst and so
 * the same quality ceiling, at roughly half the wait (median ~17 s against
 * ~31 s, Artificial Analysis, 2026-09). It is picked over the faster
 * MAI-Image-2.6-Flash (~12 s, Elo 1100, 11th of 156) for one reason that
 * decides it on a whiteboard: only the GPT Image family can return a
 * **transparent** background, and a picture in a white box next to a word
 * looks like a sticker, not a drawing.
 */
export const DEFAULT_CLOUD_IMAGE_MODEL = "openai/gpt-image-2.5-flare";
/**
 * These pictures are displayed 280–440 px wide. "high" spends seconds on
 * detail nobody sees at that size, so the wait, not the pixel count, is what
 * we optimise.
 */
export const ILLUSTRATION_QUALITY = "medium";
/**
 * A generated picture is the thing people look at; the word above it is only
 * its caption. So the picture is sized to dominate — never smaller than this,
 * and it grows with a wide anchor up to ILLUSTRATION_MAX_SIZE.
 */
export const ILLUSTRATION_SIZE = 280;
export const ILLUSTRATION_MAX_SIZE = 440;
/** Distance between the word and the picture below it, in scene px. */
export const ILLUSTRATION_GAP = 18;
/** Cap per Illustrate call so a broad selection cannot fan out into a bill. */
export const ILLUSTRATION_MAX_PER_CALL = 3;
/**
 * Provider routing on every OpenRouter call: only providers that neither store prompts nor
 * train on them (Zero Data Retention). A model with no ZDR endpoint falls back
 * to "no data collection" — never to a provider that keeps the data.
 */
export const PRIVACY_ZDR = { data_collection: "deny", zdr: true } as const;
export const PRIVACY_NO_TRAINING = { data_collection: "deny" } as const;
/** Sent as OpenRouter's app attribution headers — off by default, see DEFAULT_TRANSPORT. */
export const APP_ATTRIBUTION = {
  referer: "https://github.com/Lang-Julian/lucida",
  title: "Lucida",
};

/* ───────────────────────────  Auto-suggest  ─────────────────────────── */

/** Wait this long after pen-up before predicting, so a burst of strokes is one request. */
export const AUTO_SUGGEST_DEBOUNCE_MS = 900;
/** Below this confidence an auto suggestion is not worth interrupting the drawing. */
export const AUTO_SUGGEST_MIN_CONFIDENCE = 0.6;
/** Appearance: follow the system, or pin light or dark. */
export const THEME_STORAGE_KEY = "lucida.theme.v1";
/** Persisted panel settings (provider, models, key, auto-suggest). */
export const SETTINGS_STORAGE_KEY = "lucida.ai-settings.v1";
/** The folder the board was last open in. */
export const PROJECT_STORAGE_KEY = "lucida.project.v1";

/* ───────────────────────────  Listen (on-device speech context)  ─────────────────────────── */

export const DEFAULT_LISTEN_PORT = 8766;
export const DEFAULT_LISTEN_BASE_URL = `http://127.0.0.1:${DEFAULT_LISTEN_PORT}`;
/** How often the app pulls the rolling transcript while Listen is on. */
export const LISTEN_POLL_MS = 1500;
/** Only speech from the last N seconds is context — older talk is a different thought. */
export const SPOKEN_WINDOW_S = 90;
/** Characters of speech handed to the model at most (tail of the window). */
export const SPOKEN_MAX_CHARS = 700;

/* ───────────────────────────  Decision gate (TypeSafe Jev on OpenRouter)  ─────────────────────────── */

/** System One model: answers "is a next step obvious?" in ~100 ms for ~$0.00001. */
export const DEFAULT_GATE_MODEL = "typesafe/jev-1.13";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/v1/systemone";
/** Below this readiness the auto tier stays quiet and no text model is called. */
export const GATE_MIN_READY = 0.55;

/* ───────────────────────────  Live stroke prediction  ─────────────────────────── */

/** How often a stroke in flight is sent to the decision model, in ms. */
export const STROKE_PREDICT_MS = 200;
/** A stroke smaller than this on both axes is not worth predicting. */
export const STROKE_MIN_PX = 40;
/** Below this confidence the shadow stays hidden and geometry decides. */
export const STROKE_MIN_CONFIDENCE = 0.6;
/** Opacity of the predicted shape drawn under the user's hand. */
export const SHADOW_OPACITY = 20;
