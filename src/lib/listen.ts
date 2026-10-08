/**
 * Client for the on-device speech server (sidecar/listen.py). Pure fetch
 * wrappers plus the one piece of logic the UI needs: turning the rolling
 * transcript into the recent-speech string the model gets.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_LISTEN_BASE_URL, SPOKEN_MAX_CHARS, SPOKEN_WINDOW_S } from "./config";
import type { AudioInput, ListenHealth, ListenSnapshot, TranscriptSegment } from "./types";

/**
 * Which inputs this PC offers. A call's audio shows up here as its own
 * device — Teams installs one, and a loopback driver provides one for anything
 * else — so listening to a meeting is a matter of picking the right entry.
 */
export async function listInputs(baseUrl = DEFAULT_LISTEN_BASE_URL): Promise<AudioInput[]> {
  try {
    const res = await tauriFetch(`${baseUrl}/health`);
    if (!res.ok) return [];
    return ((await res.json()) as ListenHealth).inputs ?? [];
  } catch {
    return [];
  }
}

/** Make sure the server process exists (idempotent), then start capturing. */
export async function startListening(
  device?: string,
  baseUrl = DEFAULT_LISTEN_BASE_URL,
): Promise<void> {
  await invoke("listen_start");
  // The server needs a moment to bind after a cold spawn.
  for (let i = 0; i < 20; i++) {
    try {
      const res = await tauriFetch(`${baseUrl}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: device ?? "" }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => window.setTimeout(r, 250));
  }
  throw new Error("Speech server did not come up");
}

export async function stopListening(baseUrl = DEFAULT_LISTEN_BASE_URL): Promise<void> {
  try {
    await tauriFetch(`${baseUrl}/stop`, { method: "POST" });
  } catch {
    // already gone — fine
  }
}

export async function fetchTranscript(baseUrl = DEFAULT_LISTEN_BASE_URL): Promise<ListenSnapshot> {
  const res = await tauriFetch(`${baseUrl}/transcript`);
  if (!res.ok) throw new Error(`transcript: ${res.status}`);
  return (await res.json()) as ListenSnapshot;
}

/**
 * The speech that still counts as "what I'm explaining right now": segments
 * from the last SPOKEN_WINDOW_S seconds, joined, trimmed to a tail of
 * SPOKEN_MAX_CHARS. Exported for tests.
 */
export function recentSpeech(
  segments: readonly TranscriptSegment[],
  nowSeconds = Date.now() / 1000,
  windowS = SPOKEN_WINDOW_S,
  maxChars = SPOKEN_MAX_CHARS,
): string {
  const text = segments
    .filter((s) => nowSeconds - s.t <= windowS)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  if (text.length <= maxChars) return text;
  const start = text.length - maxChars;
  const tail = text.slice(start);
  if (text[start - 1] === " ") return tail; // already on a word boundary
  const cut = tail.indexOf(" ");
  return cut > 0 ? tail.slice(cut + 1) : tail;
}

export type { AudioInput, ListenHealth };
