import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import Whiteboard from "./components/Whiteboard";
import SettingsDialog, { type KeyState, type ModelOption } from "./components/SettingsDialog";
import WelcomeHint from "./components/WelcomeHint";
import { DEFAULT_AI_MODEL, DEFAULT_AI_PORT, DEFAULT_CLOUD_IMAGE_MODEL, OPENROUTER_BASE_URL, PROJECT_STORAGE_KEY, LISTEN_POLL_MS } from "./lib/config";
import { checkKey, cloudHeaders, DEFAULT_TRANSPORT } from "./lib/ai";
import { startListening, stopListening, fetchTranscript, recentSpeech, listInputs, type AudioInput } from "./lib/listen";
import { distillProject, type ProjectContext, type ProjectFiles } from "./lib/project";
import { connectBoardApi, type BoardContext } from "./lib/boardApi";
import { DEFAULT_PREFS, keyStoreArgs, loadSettings, saveSettings, type Prefs, type SettingsEnv } from "./lib/settings";
import { houseFrom } from "./lib/house";
import { resolveLang, strings } from "./lib/i18n";
import type { AiConfig, CloudTransport, ThemeChoice, WhiteboardHandle } from "./lib/types";
import "./App.css";

const KEY_NAME = "OPENROUTER_API_KEY";

function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function App() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [env, setEnv] = useState<SettingsEnv>({ path: "", managedPath: "", managed: false, locked: [], version: "" });
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyState, setKeyState] = useState<KeyState>({ status: "none" });
  const [transport, setTransport] = useState<CloudTransport>(DEFAULT_TRANSPORT);
  const [imageModels, setImageModels] = useState<ModelOption[]>([]);
  const [textModels, setTextModels] = useState<ModelOption[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoThinking, setAutoThinking] = useState(false);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const [isWiki, setIsWiki] = useState(false);
  const [listening, setListening] = useState(false);
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [spoken, setSpoken] = useState("");
  const [pending, setPending] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => resolveTheme("system"));
  const [hintVisible, setHintVisible] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [localPort, setLocalPort] = useState(DEFAULT_AI_PORT);
  const [localModel, setLocalModel] = useState(DEFAULT_AI_MODEL);
  const ref = useRef<WhiteboardHandle | null>(null);

  const lang = resolveLang(prefs.language);
  const T = strings(lang);
  const house = useMemo(() => houseFrom(prefs.orgAccent, prefs.orgName), [prefs.orgAccent, prefs.orgName]);

  /* ── Settings: a file, with admin defaults and locked values ── */

  const verify = useCallback(async (key: string, l = lang) => {
    const t = strings(l);
    if (!key) {
      setKeyState({ status: "none" });
      return;
    }
    setKeyState({ status: "checking" });
    try {
      const r = await checkKey(key, prefs.fastModel || DEFAULT_PREFS.fastModel);
      if (r.transport) setTransport(r.transport);
      if (r.ok) setKeyState({ status: "ok", label: r.label });
      else setKeyState({ status: "bad", message: r.kind === "management" ? t.managementKey : t.keyRejected(r.message ?? "") });
    } catch {
      setKeyState({ status: "unknown" });
    }
  }, [lang, prefs.fastModel]);

  useEffect(() => {
    void (async () => {
      const s = await loadSettings();
      setPrefs(s.prefs);
      setEnv(s.env);
      setLoaded(true);
      const l = resolveLang(s.prefs.language);
      const t = strings(l);
      const where = keyStoreArgs(s.prefs);
      let key = "";
      try {
        key = (await invoke<string | null>("secret_get", { name: KEY_NAME, ...where })) ?? "";
      } catch {
        key = "";
      }
      // A key from an older version — the webview's storage, or the shared
      // key file — moves into the chosen store once. The file is not touched.
      let found = s.legacyKey;
      if (!key && !found && s.prefs.keyStore === "credentials") {
        found = (await invoke<string | null>("secret_get", { name: KEY_NAME, storage: "file", file: null }).catch(() => null)) ?? "";
      }
      if (!key && found) {
        try {
          await invoke("secret_set", { name: KEY_NAME, value: found, ...where });
          key = found;
          if (s.prefs.keyStore === "credentials") setToast(t.keyMoved);
        } catch (err) {
          setToast(t.keyMoveFailed(String(err)));
          key = found;
        }
      }
      setApiKey(key);
      await saveSettings(s.prefs, s.env).catch(() => {});
      await verify(key, l);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPrefs = useCallback(
    (patch: Partial<Prefs>) => {
      setPrefs((p) => {
        const next = { ...p, ...patch };
        for (const k of env.locked) (next as unknown as Record<string, unknown>)[k] = (p as unknown as Record<string, unknown>)[k];
        void saveSettings(next, env).catch((err) => setToast(String(err)));
        return next;
      });
    },
    [env],
  );

  // A changed key store takes the key along.
  const prevStore = useRef<string>("");
  useEffect(() => {
    if (!loaded) return;
    const sig = JSON.stringify(keyStoreArgs(prefs));
    if (!prevStore.current) {
      prevStore.current = sig;
      return;
    }
    if (sig === prevStore.current) return;
    prevStore.current = sig;
    if (apiKey) void invoke("secret_set", { name: KEY_NAME, value: apiKey, ...keyStoreArgs(prefs) }).catch((err) => setToast(String(err)));
  }, [loaded, prefs, apiKey]);

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(prefs.theme);
      setTheme(next);
      document.documentElement.dataset.theme = next;
    };
    apply();
    document.documentElement.lang = lang;
    if (prefs.theme !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", apply);
    return () => mq?.removeEventListener("change", apply);
  }, [prefs.theme, lang]);

  const onSaveKey = useCallback(
    async (key: string) => {
      try {
        await invoke("secret_set", { name: KEY_NAME, value: key, ...keyStoreArgs(prefs) });
        setApiKey(key);
        await verify(key);
      } catch (err) {
        setKeyState({ status: "bad", message: String(err) });
      }
    },
    [prefs, verify],
  );

  const onRemoveKey = useCallback(async () => {
    await invoke("secret_set", { name: KEY_NAME, value: "", ...keyStoreArgs(prefs) }).catch((err) => setToast(String(err)));
    setApiKey("");
    setKeyState({ status: "none" });
  }, [prefs]);

  const cloud = apiKey.length > 0 && keyState.status !== "bad";

  // What OpenRouter offers, for the pickers — read live, never listed by hand.
  useEffect(() => {
    if (!settingsOpen || !cloud || imageModels.length) return;
    void (async () => {
      try {
        const r = await tauriFetch(`${OPENROUTER_BASE_URL}/models`, { headers: cloudHeaders(apiKey, transport) });
        if (!r.ok) return;
        type M = { id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] } };
        const data = ((await r.json()) as { data?: M[] }).data ?? [];
        const opt = (m: M) => ({ id: m.id, name: m.name ?? m.id });
        const byName = (a: ModelOption, b: ModelOption) => a.name.localeCompare(b.name);
        setImageModels(data.filter((m) => m.architecture?.output_modalities?.includes("image")).map(opt).sort(byName));
        setTextModels(
          data
            .filter((m) => {
              const out = m.architecture?.output_modalities ?? ["text"];
              return out.includes("text") && !out.includes("image");
            })
            .map(opt)
            .sort(byName),
        );
      } catch {
        // the pickers fall back to the configured models
      }
    })();
  }, [settingsOpen, cloud, apiKey, transport, imageModels.length]);

  /* ── The local model: only when "Vorschläge" runs without a key ── */

  const wantsLocal = prefs.suggest && !cloud;
  useEffect(() => {
    if (!wantsLocal) {
      void invoke("ai_stop").catch(() => {});
      return;
    }
    void invoke("ai_start", { dir: prefs.sidecarDir || null }).catch((err) => setToast(String(err)));
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<{ running: boolean; port: number; model: string }>("ai_status");
        if (!cancelled) {
          setLocalPort(s.port);
          setLocalModel(s.model);
        }
      } catch {
        // not up yet
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wantsLocal, prefs.sidecarDir]);

  const aiConfig = useMemo<AiConfig>(
    () => ({
      provider: cloud ? "openrouter" : "local",
      baseUrl: `http://127.0.0.1:${localPort}`,
      model: localModel,
      cloud: {
        apiKey,
        transport,
        model: prefs.textModel || DEFAULT_PREFS.textModel,
        fastModel: prefs.fastModel || DEFAULT_PREFS.fastModel,
        imageModel: prefs.imageModel || DEFAULT_CLOUD_IMAGE_MODEL,
        zdr: prefs.zdr,
      },
      autoSuggest: prefs.suggest && cloud,
    }),
    [cloud, apiKey, transport, prefs.textModel, prefs.fastModel, prefs.imageModel, prefs.zdr, prefs.suggest, localPort, localModel],
  );

  /* ── The folder the board belongs to ── */

  const openProject = useCallback(async (path: string, rethrow = false) => {
    try {
      const files = await invoke<ProjectFiles>("project_open", { path });
      setProject(distillProject(files));
      setBoard(files.board ?? null);
      try {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, files.path);
      } catch {
        // the folder is just not remembered
      }
    } catch (err) {
      if (rethrow) throw err instanceof Error ? err : new Error(String(err));
      setToast(String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let path: string | null = null;
      try {
        path = await invoke<string | null>("launch_project");
      } catch {
        // no argument
      }
      if (!path) {
        try {
          path = window.localStorage.getItem(PROJECT_STORAGE_KEY);
        } catch {
          path = null;
        }
      }
      if (path && !cancelled) await openProject(path);
      if (!cancelled) setLaunched(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [openProject]);

  useEffect(() => {
    setIsWiki(false);
    if (!project) return;
    invoke<string>("wiki_stamp", { root: project.path })
      .then(() => setIsWiki(true))
      .catch(() => setIsWiki(false));
  }, [project]);

  const onPickProject = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false, title: T.pickFolder });
    if (typeof picked === "string") await openProject(picked);
  }, [openProject, T]);

  const onPickLogo = useCallback(
    async (which: "orgLogo" | "orgLogoDark") => {
      const picked = await open({ multiple: false, filters: [{ name: "Logo", extensions: ["svg", "png", "jpg", "jpeg", "webp"] }] });
      if (typeof picked !== "string") return;
      try {
        onPrefs({ [which]: await invoke<string>("image_data_url", { path: picked }) });
      } catch (err) {
        setToast(String(err));
      }
    },
    [onPrefs],
  );

  const onPickSidecar = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onPrefs({ sidecarDir: picked });
  }, [onPrefs]);

  const onPersist = useCallback(
    (json: string) => {
      if (!project) return;
      void invoke("board_save", { path: project.path, json }).catch(() => {
        // a failed write never interrupts drawing; the next one retries
      });
    },
    [project],
  );

  useEffect(() => {
    document.title = project ? `${project.name} — Lucida` : "Lucida";
  }, [project]);

  /* ── Live boards from a wiki folder ── */

  const onPlanBoard = useCallback(async () => {
    if (!project || !ref.current) return;
    try {
      const r = await ref.current.planBoard(project.path);
      setToast(T.planLive(r.count));
    } catch (err) {
      setToast(String(err));
    }
  }, [project, T]);

  const onCompanyMap = useCallback(async () => {
    if (!project || !ref.current) return;
    try {
      const r = await ref.current.companyMap(project.path);
      setToast(T.mapLive(r.count));
    } catch (err) {
      setToast(String(err));
    }
  }, [project, T]);

  /* ── Board API (agents, MCP) ── */

  const boardCtx = useRef<BoardContext | null>(null);
  boardCtx.current = {
    ready: launched && loaded,
    handle: ref.current,
    project,
    intent,
    cloud,
    setIntent,
    openFolder: async (path: string) => {
      await openProject(path, true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    onProposal: (title: string) => setToast(T.proposalToast(title)),
  };
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void connectBoardApi(() => ({ ...boardCtx.current!, handle: ref.current })).then((u) => {
      if (dead) u();
      else off = u;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  /* ── Listen (experiment) ── */

  const toggleListen = useCallback(async () => {
    if (listening) {
      setListening(false);
      await stopListening();
      return;
    }
    setListening(true);
    try {
      await invoke("listen_start", { dir: prefs.sidecarDir || null });
      await startListening(prefs.audioInput);
      setInputs(await listInputs());
    } catch (err) {
      setListening(false);
      setToast(String(err));
    }
  }, [listening, prefs.audioInput, prefs.sidecarDir]);

  useEffect(() => {
    if (!prefs.listen && listening) void toggleListen();
  }, [prefs.listen, listening, toggleListen]);

  useEffect(() => {
    if (!listening) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await fetchTranscript();
        if (cancelled) return;
        if (snap.error) setToast(T.speech(snap.error));
        const text = recentSpeech(snap.segments);
        setSpoken((prev) => (prev === text ? prev : text));
      } catch {
        // server between spawn and bind
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), LISTEN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [listening, T]);

  /* ── Actions ── */

  const onNeedKey = useCallback(() => {
    setToast(T.needKey);
    setSettingsOpen(true);
  }, [T]);

  const onIllustrate = useCallback(async () => {
    if (!ref.current || busy) return;
    if (!cloud) return onNeedKey();
    const r = await ref.current.illustrate();
    if (r.error) setToast(r.error);
  }, [busy, cloud, onNeedKey]);

  const onSuggest = useCallback(async () => {
    if (!ref.current || busy) return;
    const r = await ref.current.suggest(intent);
    setPending(ref.current.hasPendingSuggestions());
    if (r.error) setToast(r.error);
  }, [intent, busy]);

  const onAccept = useCallback(() => {
    ref.current?.acceptSuggestions();
    setPending(false);
  }, []);

  const onDismiss = useCallback(() => {
    ref.current?.dismissSuggestions();
    setPending(false);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Ctrl+Enter keep · Esc drop · Ctrl+I picture · Ctrl+, settings · Ctrl+L listen (experiment)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (settingsOpen) return;
      const mod = e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (pending) onAccept();
        else if (prefs.suggest) void onSuggest();
        return;
      }
      if (e.key === "Escape" && pending) {
        onDismiss();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === "INPUT" || target.tagName === "SELECT") && !target.closest(".excalidraw");
      if (inField) return;
      if (mod && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        void onIllustrate();
        return;
      }
      if (mod && (e.key === "l" || e.key === "L") && prefs.listen) {
        e.preventDefault();
        void toggleListen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, pending, prefs.suggest, prefs.listen, onAccept, onSuggest, onDismiss, onIllustrate, toggleListen]);

  const status = busy ? T.drawing : autoThinking ? T.thinking : null;

  return (
    <div className="app">
      <div className="app__canvas" onPointerDownCapture={() => setHintVisible(false)}>
        <Whiteboard
          key={project?.path ?? "no-project"}
          ref={ref}
          aiConfig={aiConfig}
          autoBeautify={prefs.beautify}
          predictStrokes={prefs.predictStrokes && cloud}
          intent={intent}
          illustrationStyle={prefs.style}
          spoken={spoken}
          theme={theme}
          lang={lang}
          house={house}
          logo={prefs.orgLogo}
          logoDark={prefs.orgLogoDark || prefs.orgLogo}
          projectBrief={project?.brief ?? ""}
          initialBoard={board}
          cloud={cloud}
          isWiki={isWiki}
          onPersist={onPersist}
          onBusyChange={setBusy}
          onAutoThinkingChange={setAutoThinking}
          onPendingChange={setPending}
          onError={setToast}
          onNeedKey={onNeedKey}
          onOpenSettings={() => setSettingsOpen(true)}
          onPickFolder={onPickProject}
          onPlanBoard={onPlanBoard}
          onCompanyMap={onCompanyMap}
        />
      </div>

      <WelcomeHint visible={hintVisible && !board} lang={lang} />

      {(status || listening) && (
        <div className="app__status" role="status">
          {listening && (
            <button type="button" className="app__status-listen" onClick={() => void toggleListen()} title={T.stopListening}>
              <i /> {T.listening}
            </button>
          )}
          {status && <span>{status}</span>}
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        lang={lang}
        prefs={prefs}
        env={env}
        onPrefs={onPrefs}
        keyTail={apiKey ? apiKey.slice(-4) : null}
        keyState={keyState}
        onSaveKey={onSaveKey}
        onRemoveKey={onRemoveKey}
        imageModels={imageModels}
        textModels={textModels}
        defaults={{ imageModel: DEFAULT_CLOUD_IMAGE_MODEL }}
        folder={project?.path ?? null}
        onPickFolder={() => void onPickProject()}
        onPickLogo={(w) => void onPickLogo(w)}
        onPickSidecar={() => void onPickSidecar()}
        inputs={inputs}
      />

      {toast && (
        <div className="app__toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
