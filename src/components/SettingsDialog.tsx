/**
 * Settings (Ctrl+,) — everything that is not drawing. Values an administrator
 * locked (defaults.json) are shown, not editable.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ILLUSTRATION_STYLES } from "../lib/ai";
import { strings, type Lang } from "../lib/i18n";
import { STYLES, type PrefKey, type Prefs, type SettingsEnv } from "../lib/settings";
import { DEFAULT_ACCENT } from "../lib/house";
import type { AudioInput } from "../lib/listen";

/** What OpenRouter said about the key. */
export type KeyState =
  | { status: "none" }
  | { status: "checking" }
  | { status: "ok"; label?: string }
  | { status: "bad"; message: string }
  | { status: "unknown" };

export interface ModelOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  lang: Lang;
  prefs: Prefs;
  env: SettingsEnv;
  onPrefs: (patch: Partial<Prefs>) => void;
  keyTail: string | null;
  keyState: KeyState;
  onSaveKey: (key: string) => Promise<void>;
  onRemoveKey: () => Promise<void>;
  imageModels: ModelOption[];
  textModels: ModelOption[];
  defaults: { imageModel: string };
  folder: string | null;
  onPickFolder: () => void;
  onPickLogo: (which: "orgLogo" | "orgLogoDark") => void;
  onPickSidecar: () => void;
  inputs: AudioInput[];
}

export default function SettingsDialog(p: Props) {
  const S = strings(p.lang).s;
  const [draft, setDraft] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement | null>(null);
  const locked = (k: PrefKey) => p.env.locked.includes(k);

  useEffect(() => {
    if (!p.open) return;
    setDraft("");
    setEditingKey(!p.keyTail);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        p.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.setTimeout(() => dialog.current?.querySelector<HTMLElement>("input, button, select")?.focus(), 0);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open]);

  if (!p.open) return null;

  const save = async () => {
    const k = draft.trim();
    if (!k) return;
    setSaving(true);
    try {
      await p.onSaveKey(k);
      setDraft("");
      setEditingKey(false);
    } finally {
      setSaving(false);
    }
  };

  /** A labelled field; a locked one says so and is not editable. */
  const field = (label: string, children: ReactNode, opts: { k?: PrefKey; note?: ReactNode } = {}) => (
    <div className={`settings__field${opts.k && locked(opts.k) ? " is-locked" : ""}`}>
      <span className="settings__label">
        {label}
        {opts.k && locked(opts.k) && <em className="settings__lock">{S.locked}</em>}
      </span>
      <fieldset disabled={!!opts.k && locked(opts.k)}>{children}</fieldset>
      {opts.note && <span className="settings__note">{opts.note}</span>}
    </div>
  );

  const toggle = (k: "beautify" | "zdr" | "suggest" | "predictStrokes" | "listen", label: string, note: string) => (
    <label className={`settings__toggle${locked(k) ? " is-locked" : ""}`}>
      <span>
        <strong>
          {label}
          {locked(k) && <em className="settings__lock">{S.locked}</em>}
        </strong>
        <em>{note}</em>
      </span>
      <input type="checkbox" role="switch" checked={p.prefs[k]} disabled={locked(k)} onChange={(e) => p.onPrefs({ [k]: e.currentTarget.checked })} />
    </label>
  );

  const chips = (k: PrefKey, value: string, options: Array<[string, string, string?]>) => (
    <div className="settings__chips" role="radiogroup">
      {options.map(([v, label, title]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className="settings__chip"
          title={title}
          disabled={locked(k)}
          onClick={() => p.onPrefs({ [k]: v } as Partial<Prefs>)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const modelSelect = (k: "imageModel" | "textModel" | "fastModel", options: ModelOption[], fallback: string) => {
    const current = p.prefs[k] || fallback;
    const list = options.length ? options : [{ id: current, name: current }];
    return (
      <select value={current} disabled={locked(k)} onChange={(e) => p.onPrefs({ [k]: e.currentTarget.value })}>
        {!list.some((m) => m.id === current) && <option value={current}>{current}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  };

  const keyLine = (() => {
    switch (p.keyState.status) {
      case "checking":
        return S.keyChecking;
      case "ok":
        return <span className="settings__note--ok">{S.keyOk(p.keyState.label)}</span>;
      case "bad":
        return <span className="settings__note--bad">{p.keyState.message}</span>;
      case "unknown":
        return S.keyUnknown;
      default:
        return S.keyNone;
    }
  })();

  const image = p.prefs.imageModel || p.defaults.imageModel;
  const imageNote = image === p.defaults.imageModel ? S.imageModelDefault : image.startsWith("openai/gpt-image") ? S.imageModelGpt : S.imageModelOther;

  const logo = (k: "orgLogo" | "orgLogoDark", label: string) =>
    field(
      label,
      <div className="settings__row">
        <span className={`settings__logo${k === "orgLogoDark" ? " settings__logo--dark" : ""}`}>
          {p.prefs[k] ? <img src={p.prefs[k]} alt="" /> : <em>{S.logoNone}</em>}
        </span>
        <button type="button" className="settings__btn" onClick={() => p.onPickLogo(k)}>
          {S.logoPick}
        </button>
        {p.prefs[k] && (
          <button type="button" className="settings__btn settings__btn--quiet" onClick={() => p.onPrefs({ [k]: "" })}>
            {S.logoRemove}
          </button>
        )}
      </div>,
      { k },
    );

  const home = (path: string) => path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");

  return (
    <div className="settings-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label={S.title} ref={dialog} onKeyDown={(e) => e.stopPropagation()}>
        <header className="settings__head">
          <h2>{S.title}</h2>
          <button type="button" className="settings__close" onClick={p.onClose} aria-label={S.close}>
            ×
          </button>
        </header>
        {p.env.managed && <p className="settings__managed">{S.managed}</p>}

        <section className="settings__section">
          <h3>{S.general}</h3>
          {field(S.language, chips("language", p.prefs.language, [["system", S.langSystem], ["de", "Deutsch"], ["en", "English"]]), { k: "language" })}
          {field(S.appearance, chips("theme", p.prefs.theme, [["system", S.themeSystem], ["light", S.themeLight], ["dark", S.themeDark]]), { k: "theme" })}
          {field(
            S.folder,
            <div className="settings__row">
              <code className="settings__path">{p.folder ? home(p.folder) : S.noFolder}</code>
              <button type="button" className="settings__btn" onClick={p.onPickFolder}>
                {S.change}
              </button>
            </div>,
          )}
          {toggle("beautify", S.beautify, S.beautifyNote)}
        </section>

        <section className="settings__section">
          <h3>{S.org}</h3>
          <p className="settings__note">{S.orgNote}</p>
          {field(
            S.orgName,
            <input type="text" value={p.prefs.orgName} placeholder={S.orgNamePh} onChange={(e) => p.onPrefs({ orgName: e.currentTarget.value })} />,
            { k: "orgName" },
          )}
          {field(
            S.accent,
            <div className="settings__row">
              <input type="color" className="settings__swatch" value={p.prefs.orgAccent || DEFAULT_ACCENT} onChange={(e) => p.onPrefs({ orgAccent: e.currentTarget.value })} />
              <code className="settings__path">{p.prefs.orgAccent}</code>
            </div>,
            { k: "orgAccent" },
          )}
          {logo("orgLogo", S.logo)}
          {logo("orgLogoDark", S.logoDark)}
        </section>

        <section className="settings__section">
          <h3>{S.pictures}</h3>
          {field(
            S.key,
            editingKey ? (
              <div className="settings__row">
                <input
                  type="password"
                  value={draft}
                  placeholder="sk-or-v1-…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                />
                <button type="button" className="settings__btn settings__btn--go" disabled={!draft.trim() || saving} onClick={() => void save()}>
                  {S.save}
                </button>
                {p.keyTail && (
                  <button type="button" className="settings__btn" onClick={() => setEditingKey(false)}>
                    {S.cancel}
                  </button>
                )}
              </div>
            ) : (
              <div className="settings__row">
                <code className="settings__key">•••• {p.keyTail}</code>
                <button type="button" className="settings__btn" onClick={() => setEditingKey(true)}>
                  {S.replace}
                </button>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={() => void p.onRemoveKey()}>
                  {S.remove}
                </button>
              </div>
            ),
            { note: keyLine },
          )}
          {field(
            S.keyStore,
            <>
              {chips("keyStore", p.prefs.keyStore, [["credentials", S.credentials], ["file", S.keyFile]])}
              {p.prefs.keyStore === "file" && (
                <input type="text" value={p.prefs.keyFile} placeholder={S.keyFilePh} disabled={locked("keyFile")} onChange={(e) => p.onPrefs({ keyFile: e.currentTarget.value })} />
              )}
            </>,
            { k: "keyStore", note: p.prefs.keyStore === "file" ? S.keyFileNote : undefined },
          )}
          {field(S.imageModel, modelSelect("imageModel", p.imageModels, p.defaults.imageModel), { k: "imageModel", note: imageNote })}
          {field(
            S.style,
            chips(
              "style",
              p.prefs.style,
              STYLES.map((k) => [k, k === "house" ? p.prefs.orgName || ILLUSTRATION_STYLES[k].label : ILLUSTRATION_STYLES[k].label, ILLUSTRATION_STYLES[k].prompt]),
            ),
            { k: "style" },
          )}
        </section>

        <section className="settings__section">
          <h3>{S.privacy}</h3>
          {toggle("zdr", S.zdr, S.zdrNote)}
        </section>

        <section className="settings__section">
          <h3>{S.experiments}</h3>
          <p className="settings__note">{S.experimentsNote}</p>
          {toggle("suggest", S.suggest, S.suggestNote)}
          {toggle("predictStrokes", S.predict, S.predictNote)}
          {toggle("listen", S.listen, S.listenNote)}
          {p.prefs.listen &&
            field(
              S.input,
              <select value={p.prefs.audioInput} onChange={(e) => p.onPrefs({ audioInput: e.currentTarget.value })}>
                <option value="">{S.inputDefault}</option>
                {p.inputs.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                  </option>
                ))}
              </select>,
              { k: "audioInput" },
            )}
          {(p.prefs.suggest || p.prefs.predictStrokes) &&
            field(
              S.models,
              <>
                <span className="settings__sublabel">{S.textModel}</span>
                {modelSelect("textModel", p.textModels, p.prefs.textModel)}
                <span className="settings__sublabel">{S.fastModel}</span>
                {modelSelect("fastModel", p.textModels, p.prefs.fastModel)}
              </>,
              { note: S.modelsNote },
            )}
          {(p.prefs.suggest || p.prefs.listen) &&
            field(
              S.sidecar,
              <div className="settings__row">
                <code className="settings__path">{p.prefs.sidecarDir ? home(p.prefs.sidecarDir) : "%LOCALAPPDATA%\\Lucida\\sidecar"}</code>
                <button type="button" className="settings__btn" onClick={p.onPickSidecar}>
                  {S.change}
                </button>
              </div>,
              { k: "sidecarDir", note: S.sidecarNote },
            )}
        </section>

        <footer className="settings__foot">
          <span>{S.version(p.env.version)}</span>
          <span>
            {S.settingsFile} <code>{home(p.env.path)}</code>
          </span>
          <span>{S.foot}</span>
        </footer>
      </div>
    </div>
  );
}
