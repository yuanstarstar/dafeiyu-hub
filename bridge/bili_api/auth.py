# -*- coding: utf-8 -*-
"""登录态：从 cookie 文件 / 环境变量读 SESSDATA、bili_jct。

查找顺序（config.json 的 bili.cookie_file 非空时只认它）：
1. config.json → bili.cookie_file
2. 环境变量 BILI_COOKIE（整段 "k=v; k=v" 或 JSON）
3. data/bili_cookie.json（本目录）
4. %USERPROFILE%\\.dsh\\dafeiyu-login-live\\secrets\\bili_cookie.json（本包扫码登录落盘的位置）

文件格式三种都认：
- {"cookie": "SESSDATA=…; bili_jct=…"}
- {"SESSDATA": "…", "bili_jct": "…"}（扫码工具常见写法）
- 纯文本 "SESSDATA=…; bili_jct=…"
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from .client import BiliClient

SKIP_KEYS = {"updated", "uname", "mid", "vip", "isLogin", "cookie", "cookies",
             "checked_at", "saved_at", "user_agent", "note"}

DEFAULT_CANDIDATES = ()


def parse_cookie_text(text: str) -> dict[str, str]:
    """把各种 cookie 文本/JSON 统一解析成 k=v 字典。"""
    text = (text or "").strip()
    if not text:
        return {}
    pairs: dict[str, str] = {}
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            data = {}
        if isinstance(data, dict):
            raw = data.get("cookie") or data.get("cookies") or ""
            if isinstance(raw, dict):
                pairs = {str(k): str(v) for k, v in raw.items()}
                return {k: v for k, v in pairs.items() if k not in SKIP_KEYS}
            if raw:
                text = str(raw)
            else:
                return {str(k): str(v) for k, v in data.items()
                        if str(k) not in SKIP_KEYS and isinstance(v, (str, int))}
    for part in text.replace("\r", ";").replace("\n", ";").split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip() and v.strip():
                pairs[k.strip()] = v.strip()
    return {k: v for k, v in pairs.items() if k not in SKIP_KEYS}


def find_cookie_source(cfg: Optional[dict], data_dir: Path) -> tuple[Optional[str], str]:
    """返回 (cookie 文本, 来源说明)。找不到时 (None, 说明)。"""
    cfg = cfg or {}
    explicit = str(cfg.get("cookie_file") or "").strip()
    if explicit:
        p = Path(explicit).expanduser()
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace"), f"config: {p}"
        return None, f"config 指定的 cookie_file 不存在：{p}"
    env = os.environ.get("BILI_COOKIE", "").strip()
    if env:
        return env, "环境变量 BILI_COOKIE"
    local = Path(data_dir) / "bili_cookie.json"
    if local.exists():
        return local.read_text(encoding="utf-8", errors="replace"), str(local)
    for cand in DEFAULT_CANDIDATES:
        p = Path(cand)
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace"), str(p)
    return None, "没有找到 cookie 文件（也没有 BILI_COOKIE）"


def load_cookie(client: BiliClient, cfg: Optional[dict] = None) -> dict:
    """把 cookie 灌进 client，返回 {来源, 条数, has_sessdata, has_jct}。"""
    cfg = cfg or client.cfg
    data_dir = client.data_dir
    text, source = find_cookie_source(cfg, data_dir)
    if not text:
        return {"source": source, "count": 0, "has_sessdata": False, "has_jct": False}
    pairs = parse_cookie_text(text)
    n = client.add_cookie_pairs(pairs)
    return {
        "source": source,
        "count": n,
        "has_sessdata": "SESSDATA" in pairs,
        "has_jct": "bili_jct" in pairs,
    }
