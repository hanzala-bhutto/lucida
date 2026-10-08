"""
Lucida Listen — on-device speech context for the whiteboard.

Captures the microphone, transcribes with Whisper (faster-whisper: CUDA when an
NVIDIA GPU is usable, else the CPU) and keeps a rolling transcript that the app
polls. Nothing here talks to the network; the model is fetched once from
Hugging Face on first use.

    GET  /health      {"ok": true, "model": "...", "ready": bool, "listening": bool}
    POST /start       start capturing
    POST /stop        stop capturing (transcript is kept)
    POST /clear       forget the transcript
    GET  /transcript  {"listening": bool, "ready": bool, "segments": [{"t": epoch, "text": "..."}]}

Segments are cut on pauses (energy-based) or every MAX_CHUNK_S seconds, so a
sentence lands a second or two after it was said.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

PORT = int(os.environ.get("LUCIDA_LISTEN_PORT", "8766"))
# Which input to listen to. Empty means the system default microphone.
# Set it to a loopback device such as "Stereo Mix" or VB-CABLE to hear a Teams
# or Meet call instead of the room.
DEVICE = os.environ.get("LUCIDA_LISTEN_DEVICE", "").strip()
# The chosen input can also be switched at runtime by POST /start {"device": …}.
CHOSEN = {"device": DEVICE}
MODEL = os.environ.get("LUCIDA_LISTEN_MODEL", "large-v3-turbo")
# "auto" uses CUDA when it works and falls back to the CPU; "cpu" or "cuda" pins it.
COMPUTE = os.environ.get("LUCIDA_LISTEN_COMPUTE", "auto")
SAMPLE_RATE = 16_000
BLOCK_S = 0.5           # capture granularity
MIN_CHUNK_S = 2.0       # never transcribe less speech than this
MAX_CHUNK_S = 12.0      # cut a long monologue here even without a pause
SILENCE_TAIL_S = 0.9    # a pause this long ends a segment
SILENCE_RMS = 0.008     # below this the block counts as silence
KEEP_SEGMENTS = 60

# Whisper's well-known phantom outputs on silence / noise.
PHANTOMS = (
    "untertitel", "subtitles", "thanks for watching", "thank you for watching",
    "amara.org", "copyright", "vielen dank", "bis zum nächsten mal",
)


class Listener:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.segments: list[dict] = []
        self.listening = False
        self.ready = False
        self.error: str | None = None
        self._stream = None
        self._model = None
        self._blocks: list[np.ndarray] = []
        self._silent_blocks = 0
        self._voiced = False
        self._worker = threading.Thread(target=self._warm, daemon=True)
        self._worker.start()

    # ---- model -----------------------------------------------------------
    def _warm(self) -> None:
        # A GPU without its CUDA libraries only fails on first use, so each
        # device is tried with a real (silent) transcription.
        devices = ["cuda", "cpu"] if COMPUTE == "auto" else [COMPUTE]
        for device in devices:
            try:
                from faster_whisper import WhisperModel  # import + first load downloads the model
                self._model = WhisperModel(MODEL, device=device, compute_type="auto")
                self._transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
                self.ready = True
                self.error = None
                print(f"[listen] model ready: {MODEL} on {device}", flush=True)
                return
            except Exception as e:  # pragma: no cover
                self._model = None
                self.error = str(e)
                print(f"[listen] model failed on {device}: {e}", flush=True)

    def _transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self._model.transcribe(audio, condition_on_previous_text=False)
        text = "".join(s.text for s in segments).strip()
        low = text.lower()
        if not text or any(p in low for p in PHANTOMS):
            return ""
        return text

    # ---- capture ---------------------------------------------------------
    def start(self, device: str | None = None) -> None:
        with self.lock:
            if self.listening:
                return
            if device is not None:
                CHOSEN["device"] = device.strip()
            import sounddevice as sd
            self._blocks, self._silent_blocks, self._voiced = [], 0, False
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                blocksize=int(SAMPLE_RATE * BLOCK_S), callback=self._on_block,
                device=(CHOSEN["device"] or None),
            )
            self._stream.start()
            self.listening = True
            print("[listen] capturing", flush=True)

    def stop(self) -> None:
        with self.lock:
            if not self.listening:
                return
            self.listening = False
            try:
                self._stream.stop(); self._stream.close()
            except Exception:
                pass
            self._stream = None
            tail = self._take()
        if tail is not None:
            self._flush(tail)
        print("[listen] stopped", flush=True)

    def clear(self) -> None:
        with self.lock:
            self.segments = []

    def _on_block(self, indata, frames, time_info, status) -> None:  # sounddevice callback thread
        block = indata[:, 0].copy()
        rms = float(np.sqrt(np.mean(block * block)))
        chunk = None
        with self.lock:
            if rms >= SILENCE_RMS:
                self._voiced = True
                self._silent_blocks = 0
            else:
                self._silent_blocks += 1
            self._blocks.append(block)
            have = len(self._blocks) * BLOCK_S
            paused = self._voiced and self._silent_blocks * BLOCK_S >= SILENCE_TAIL_S
            if (paused and have >= MIN_CHUNK_S) or have >= MAX_CHUNK_S:
                chunk = self._take()
            elif not self._voiced and have >= MAX_CHUNK_S / 2:
                self._blocks = []  # pure silence: drop, keep memory flat
        if chunk is not None:
            threading.Thread(target=self._flush, args=(chunk,), daemon=True).start()

    def _take(self) -> np.ndarray | None:
        if not self._blocks or not self._voiced:
            self._blocks, self._silent_blocks, self._voiced = [], 0, False
            return None
        audio = np.concatenate(self._blocks)
        self._blocks, self._silent_blocks, self._voiced = [], 0, False
        return audio

    def _flush(self, audio: np.ndarray) -> None:
        if not self.ready:
            return
        try:
            text = self._transcribe(audio)
        except Exception as e:
            print(f"[listen] transcribe failed: {e}", flush=True)
            return
        if not text:
            return
        with self.lock:
            self.segments.append({"t": time.time(), "text": text})
            self.segments = self.segments[-KEEP_SEGMENTS:]
        print(f"[listen] {text}", flush=True)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "listening": self.listening,
                "ready": self.ready,
                "error": self.error,
                "segments": list(self.segments),
            }


LISTENER = Listener()


def input_devices() -> list[dict]:
    """Every input the box could listen to, so the UI can offer a call's audio."""
    try:
        import sounddevice as sd
        return [
            {"name": d["name"], "channels": d["max_input_channels"]}
            for d in sd.query_devices()
            if d.get("max_input_channels", 0) > 0
        ]
    except Exception:
        return []


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "model": MODEL,
                "ready": LISTENER.ready,
                "listening": LISTENER.listening,
                "error": LISTENER.error,
                "device": CHOSEN["device"] or "system default",
                "inputs": input_devices(),
            })
        elif self.path == "/transcript":
            self._json(200, LISTENER.snapshot())
        else:
            self._json(404, {"error": "not found"})

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            return {}

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/start":
                LISTENER.start(self._body().get("device"))
            elif self.path == "/stop":
                LISTENER.stop()
            elif self.path == "/clear":
                LISTENER.clear()
            else:
                return self._json(404, {"error": "not found"})
            self._json(200, {"ok": True, "listening": LISTENER.listening})
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})

    def log_message(self, *_: object) -> None:  # quiet
        pass


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[listen] serving on 127.0.0.1:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        LISTENER.stop()


if __name__ == "__main__":
    sys.exit(main())
