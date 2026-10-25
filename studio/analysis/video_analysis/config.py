from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("VA_DATA") or (ROOT / "data"))
CFG_PATH = Path(os.environ.get("VA_CONFIG") or (ROOT / "config.yaml"))

DEFAULTS: dict[str, Any] = {
    "analyzer": {
        "enabled": True,
        "level": "l1",
        "budget_cny": 0.06,
        "max_parallel": 1,
        "window_s": 60.0,
        "segment_timeout_s": 240.0,
        "fallback_local": True,
        "prefer": "vision",
        "vision_frames": 8,
        "vision_width": 512,
        "llm_model": "mimo-v2.6-flash",
        "llm_api_url": "https://api.xiaomimimo.com/v1/chat/completions",
        "ffmpeg": "",
        "node": "",
        "script": "",
        "tmp_dir": "",
    },
    "llm": {"api_url": "", "model": "", "api_key": ""},
}


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load() -> dict:
    raw: dict = {}
    try:
        if CFG_PATH.exists():
            data = yaml.safe_load(CFG_PATH.read_text(encoding="utf-8", errors="replace"))
            if isinstance(data, dict):
                raw = data
    except Exception:  # noqa: BLE001
        raw = {}
    return _merge(DEFAULTS, raw)


CFG = load()

for _d in (DATA / "cache" / "frames", DATA / "cache" / "analyzer", DATA / "analysis"):
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
