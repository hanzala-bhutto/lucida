/**
 * Settings — one flat object, kept in a file by the Rust side
 * (`%APPDATA%\Lucida\settings.json`), never in the webview. An
 * administrator can ship `%ProgramData%\Lucida\defaults.json` with
 * `{ "defaults": {…}, "locked": ["key", …] }`: defaults fill what the user
 * has not chosen, locked keys are fixed for everyone.
 *
 * Nothing about an organisation is built in: name, colour and logo are empty
 * until someone sets them.
 */
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_ACCENT, isHexColour } from "./house";
import type { LangPref } from "./i18n";
import type { IllustrationStyle, ThemeChoice } from "./types";
import { DEFAULT_CLOUD_FAST_MODEL, DEFAULT_CLOUD_IMAGE_MODEL, DEFAULT_CLOUD_MODEL } from "./config";

export interface Prefs {
  language: LangPref;
  theme: ThemeChoice;
  /** freehand shapes snap to clean ones */
  beautify: boolean;

  /** the organisation — empty means neutral */
  orgName: string;
  orgAccent: string;
  /** logo as a data URL, for light surfaces */
  orgLogo: string;
  /** logo as a data URL, for dark surfaces; the light one is used if empty */
  orgLogoDark: string;

  imageModel: string;
  style: IllustrationStyle;
  textModel: string;
  fastModel: string;
  /** only Zero Data Retention providers */
  zdr: boolean;

  /** where the OpenRouter key lives */
  keyStore: "credentials" | "file";
  keyFile: string;

  suggest: boolean;
  predictStrokes: boolean;
  listen: boolean;
  audioInput: string;
  /** folder holding serve.ps1 / listen.ps1 and their .venv; "" = the default */
  sidecarDir: string;
}

export type PrefKey = keyof Prefs;

export const STYLES: readonly IllustrationStyle[] = ["house", "precise", "flat", "sketch", "doodle", "isometric", "photo"];

export const DEFAULT_PREFS: Prefs = {
  language: "system",
  theme: "system",
  beautify: true,
  orgName: "",
  orgAccent: DEFAULT_ACCENT,
  orgLogo: "",
  orgLogoDark: "",
  imageModel: DEFAULT_CLOUD_IMAGE_MODEL,
  style: "precise",
  textModel: DEFAULT_CLOUD_MODEL,
  fastModel: DEFAULT_CLOUD_FAST_MODEL,
  zdr: true,
  keyStore: "credentials",
  keyFile: "",
  suggest: false,
  predictStrokes: false,
  listen: false,
  audioInput: "",
  sidecarDir: "",
};

/** What the Rust side reports about where settings come from. */
export interface SettingsEnv {
  path: string;
  managedPath: string;
  managed: boolean;
  locked: PrefKey[];
  version: string;
}

/** Keep only well-formed values; anything else falls back to the default. */
export function sanitize(raw: unknown): Partial<Prefs> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  const str = (k: PrefKey, max = 4096) => {
    if (typeof r[k] === "string" && (r[k] as string).length <= max) (out as Record<string, unknown>)[k] = r[k];
  };
  const bool = (k: PrefKey) => {
    if (typeof r[k] === "boolean") (out as Record<string, unknown>)[k] = r[k];
  };
  if (r.language === "system" || r.language === "de" || r.language === "en") out.language = r.language;
  if (r.theme === "system" || r.theme === "light" || r.theme === "dark") out.theme = r.theme;
  if (r.keyStore === "credentials" || r.keyStore === "file") out.keyStore = r.keyStore;
  // older versions called the house style "aiz"
  const style = r.style === "aiz" ? "house" : r.style;
  if (STYLES.includes(style as IllustrationStyle)) out.style = style as IllustrationStyle;
  if (typeof r.orgAccent === "string" && isHexColour(r.orgAccent)) out.orgAccent = r.orgAccent;
  for (const k of ["orgName", "imageModel", "textModel", "fastModel", "keyFile", "audioInput", "sidecarDir"] as const) str(k, 512);
  for (const k of ["orgLogo", "orgLogoDark"] as const) {
    if (typeof r[k] === "string" && (r[k] === "" || /^data:image\/(svg\+xml|png|jpeg|webp);base64,/.test(r[k] as string))) {
      str(k, 3_000_000);
    }
  }
  for (const k of ["beautify", "zdr", "suggest", "predictStrokes", "listen"] as const) bool(k);
  return out;
}

/** Settings from 0.1/0.2-pre, which lived in the webview's localStorage. */
function legacy(): { prefs: Partial<Prefs>; key: string } {
  try {
    const raw = JSON.parse(window.localStorage.getItem("lucida.ai-settings.v1") ?? "{}") as Record<string, unknown>;
    const theme = window.localStorage.getItem("lucida.theme.v1");
    const prefs = sanitize({
      ...raw,
      style: raw.style ?? raw.illustrationStyle,
      theme: theme ?? raw.theme,
    });
    return { prefs, key: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "" };
  } catch {
    return { prefs: {}, key: "" };
  }
}

function clearLegacy(): void {
  try {
    window.localStorage.removeItem("lucida.ai-settings.v1");
    window.localStorage.removeItem("lucida.theme.v1");
  } catch {
    // nothing to clear
  }
}

export interface Loaded {
  prefs: Prefs;
  env: SettingsEnv;
  /** a key found in the old webview storage, to be moved to the key store once */
  legacyKey: string;
}

/** Defaults ← admin defaults ← the user's file (← old storage, once). Locked keys always win. */
export async function loadSettings(): Promise<Loaded> {
  let raw: { user?: unknown; defaults?: unknown; locked?: unknown; path?: string; managedPath?: string; managed?: boolean; version?: string } = {};
  try {
    raw = await invoke("settings_read");
  } catch {
    raw = {};
  }
  const admin = sanitize(raw.defaults);
  const locked = (Array.isArray(raw.locked) ? raw.locked : []).filter((k): k is PrefKey => typeof k === "string" && k in DEFAULT_PREFS);
  const user = sanitize(raw.user);
  const old = raw.user ? { prefs: {}, key: legacy().key } : legacy();
  const prefs: Prefs = { ...DEFAULT_PREFS, ...admin, ...old.prefs, ...user };
  for (const k of locked) (prefs as unknown as Record<string, unknown>)[k] = (admin as Record<string, unknown>)[k] ?? DEFAULT_PREFS[k];
  return {
    prefs,
    env: {
      path: raw.path ?? "",
      managedPath: raw.managedPath ?? "",
      managed: !!raw.managed,
      locked,
      version: raw.version ?? "",
    },
    legacyKey: old.key,
  };
}

/** Write what the user chose — locked keys are not theirs to store. */
export async function saveSettings(prefs: Prefs, env: SettingsEnv): Promise<void> {
  const out: Record<string, unknown> = { ...prefs };
  for (const k of env.locked) delete out[k];
  await invoke("settings_write", { settings: out });
  clearLegacy();
}

/** Where the key store is, in the shape the Rust commands take. */
export function keyStoreArgs(p: Prefs): { storage: string; file: string | null } {
  return { storage: p.keyStore, file: p.keyStore === "file" ? p.keyFile || null : null };
}
