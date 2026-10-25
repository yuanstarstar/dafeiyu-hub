# -*- coding: utf-8 -*-
"""统一文本 LLM 客户端（Lead 维护，writer.py / qa.py 共用）。

设计要点
- 走 OpenAI 兼容的 /chat/completions（默认小米 mimo-v2.6-flash，key 与 analyzer 同一套）。
- mimo 是**推理模型**：先吐 reasoning_content，再吐 content。max_tokens 给小了会导致
  content 为空（finish_reason=length）——这里自动加倍重试，避免上层拿到空字符串。
- key 解析顺序：显式传入 > DSH 凭据 XIAOMI_API_KEY > DEEPSEEK_API_KEY。
- 只做纯文本；视觉分析仍由 analyzer.py 调插件完成。
- 统计 calls / tokens / 耗时，供报告与自测使用（线程安全）。

用法：
    from livehub.llm import LLMClient
    c = LLMClient(cfg)
    if c.available:
        text = c.chat([{"role": "user", "content": "hi"}], max_tokens=800)
        obj = c.chat_json([...], max_tokens=2000)
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

import httpx

CRED_PATH = Path(os.path.expanduser("~/.dsh/.credentials.yaml"))
DEFAULT_API_URL = "https://api.xiaomimimo.com/v1/chat/completions"
DEFAULT_MODEL = "mimo-v2.6-flash"
KEY_ENVS = ("XIAOMI_API_KEY", "DEEPSEEK_API_KEY")

# 每 1K token 的估价（人民币，粗略；mimo-flash 官方低价，仅用于报告中的量级参考）
PRICE_IN_PER_1K = 0.0007
PRICE_OUT_PER_1K = 0.0014


def read_cred_key(name: str) -> str:
    """从 DSH 凭据文件读一个 key（兼容 "KEY: v" 和 "KEY = v" 两种写法）。"""
    try:
        if not CRED_PATH.exists():
            return ""
        text = CRED_PATH.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"(?m)^\s*" + re.escape(name) + r"\s*[:=]\s*([^\s#]+)", text)
        return m.group(1).strip() if m else ""
    except Exception:  # noqa: BLE001
        return ""


def resolve_key(explicit: str = "") -> str:
    if explicit:
        return explicit.strip()
    for env in KEY_ENVS:
        v = (os.environ.get(env) or "").strip()
        if v:
            return v
    for name in KEY_ENVS:
        v = read_cred_key(name)
        if v:
            return v
    return ""


def strip_fences(text: str) -> str:
    """去掉 ```json ... ``` 包裹。"""
    t = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        return m.group(1).strip()
    return t


def extract_json(text: str) -> Any:
    """从模型输出里尽量抠出一个 JSON 对象/数组（容忍前后废话、尾部逗号）。"""
    t = strip_fences(text)
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        pass
    # 找到第一个 { 或 [，再按括号配平截取
    for opener, closer in (("{", "}"), ("[", "]")):
        i = t.find(opener)
        if i < 0:
            continue
        depth = 0
        in_str = False
        esc = False
        for j in range(i, len(t)):
            ch = t[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    frag = t[i:j + 1]
                    frag = re.sub(r",\s*([}\]])", r"\1", frag)
                    try:
                        return json.loads(frag)
                    except Exception:  # noqa: BLE001
                        break
    raise ValueError(f"no json in output: {(text or '')[:200]!r}")


class LLMError(RuntimeError):
    pass


class LLMClient:
    def __init__(self, cfg: Optional[dict] = None, api_url: str = "", model: str = "",
                 key: str = "", timeout: float = 90.0):
        cfg = cfg or {}
        llm_cfg = dict(cfg.get("llm") or {}) if isinstance(cfg, dict) else {}
        a_cfg = dict(cfg.get("analyzer") or {}) if isinstance(cfg, dict) else {}
        self.api_url = (api_url or llm_cfg.get("api_url") or a_cfg.get("llm_api_url")
                        or DEFAULT_API_URL).strip()
        self.model = (model or llm_cfg.get("model") or a_cfg.get("llm_model")
                      or DEFAULT_MODEL).strip()
        self.key = resolve_key(key or str(llm_cfg.get("api_key") or ""))
        self.timeout = float(timeout or llm_cfg.get("timeout_s") or 90.0)
        self._lock = threading.Lock()
        self.calls = 0
        self.errors = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_seconds = 0.0
        self.last_latency = 0.0
        self.last_error = ""

    # ---------------------------------------------------------------- 基础
    @property
    def available(self) -> bool:
        return bool(self.api_url and self.model and self.key)

    def stats(self) -> dict:
        with self._lock:
            cost = (self.prompt_tokens / 1000.0 * PRICE_IN_PER_1K
                    + self.completion_tokens / 1000.0 * 1e-3 * PRICE_OUT_PER_1K * 1000)
            return {
                "available": self.available,
                "model": self.model,
                "calls": self.calls,
                "errors": self.errors,
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "cost_cny": round(cost, 5),
                "avg_latency_s": round(self.total_seconds / self.calls, 3) if self.calls else 0.0,
                "last_error": self.last_error,
            }

    # ---------------------------------------------------------------- 调用
    def chat(self, messages: list[dict], temperature: float = 0.75, max_tokens: int = 1200,
             timeout: Optional[float] = None, stop: Optional[list[str]] = None,
             retries: int = 1) -> str:
        if not self.available:
            raise LLMError("LLM 不可用：缺少 api_url/model/key")
        mt = max(64, int(max_tokens))
        last_err = ""
        for attempt in range(max(1, retries + 1)):
            t0 = time.time()
            body: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "temperature": float(temperature),
                "max_tokens": mt,
                "stream": False,
            }
            if stop:
                body["stop"] = stop
            try:
                with httpx.Client(timeout=timeout or self.timeout) as cli:
                    r = cli.post(self.api_url,
                                 headers={"Authorization": f"Bearer {self.key}",
                                          "Content-Type": "application/json"},
                                 json=body)
                dt = time.time() - t0
                if r.status_code != 200:
                    raise LLMError(f"HTTP {r.status_code}: {r.text[:300]}")
                data = r.json()
                usage = data.get("usage") or {}
                with self._lock:
                    self.calls += 1
                    self.total_seconds += dt
                    self.last_latency = dt
                    self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
                    self.completion_tokens += int(usage.get("completion_tokens") or 0)
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                content = (msg.get("content") or "").strip()
                finish = choice.get("finish_reason") or ""
                if content:
                    return content
                # reasoning 模型：content 空 = token 预算被思维链吃光，加倍再试
                last_err = (f"empty content (finish={finish}, "
                            f"completion_tokens={usage.get('completion_tokens')})")
                if attempt < retries:
                    mt = min(mt * 3, 8000)
                    continue
                raise LLMError(last_err)
            except LLMError as e:
                last_err = str(e)
            except Exception as e:  # noqa: BLE001
                last_err = f"{type(e).__name__}: {e}"
            with self._lock:
                self.errors += 1
                self.last_error = last_err[:300]
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
        raise LLMError(last_err or "LLM 调用失败")

    def chat_json(self, messages: list[dict], temperature: float = 0.6,
                  max_tokens: int = 2400, timeout: Optional[float] = None,
                  retries: int = 1) -> Any:
        text = self.chat(messages, temperature=temperature, max_tokens=max_tokens,
                         timeout=timeout, retries=retries)
        return extract_json(text)


# ---------------------------------------------------------------- 主备通道
BACKUP_API_URL = "https://api.deepseek.com/v1/chat/completions"
BACKUP_MODEL = "deepseek-chat"
_DEAD_MARKS = ("402", "insufficient", "balance", "quota", "401", "unauthorized")


class FallbackClient:
    """主通道余额/鉴权类错误时永久切到备用通道的包装器。

    只对**文本**调用有效（DeepSeek 不支持图像输入）；视觉请求请直接用 LLMClient。
    """

    def __init__(self, primary: LLMClient, backup: Optional[LLMClient] = None) -> None:
        self.primary = primary
        self.backup = backup if (backup is not None and backup.available) else None
        self.primary_dead = False
        self.switches = 0
        self.last_error = ""

    @property
    def available(self) -> bool:
        return bool((self.primary and self.primary.available and not self.primary_dead)
                    or self.backup)

    @property
    def model(self) -> str:
        if self.primary_dead and self.backup:
            return self.backup.model
        return self.primary.model if self.primary else BACKUP_MODEL

    @property
    def api_url(self) -> str:
        if self.primary_dead and self.backup:
            return self.backup.api_url
        return self.primary.api_url if self.primary else BACKUP_API_URL

    def stats(self) -> dict:
        out = {"model": self.model, "primary_dead": self.primary_dead,
               "switches": self.switches, "last_error": self.last_error,
               "backup": bool(self.backup)}
        try:
            out["primary"] = self.primary.stats()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.backup:
                out["backup_stats"] = self.backup.stats()
        except Exception:  # noqa: BLE001
            pass
        return out

    def chat(self, messages: list[dict], **kw: Any) -> str:
        if not self.primary_dead and self.primary and self.primary.available:
            try:
                return self.primary.chat(messages, **kw)
            except LLMError as e:
                self.last_error = str(e)[:200]
                if not any(m in str(e).lower() for m in _DEAD_MARKS):
                    if not self.backup:
                        raise
                self.primary_dead = True
                self.switches += 1
        if not self.backup:
            raise LLMError(self.last_error or "LLM 不可用")
        try:
            return self.backup.chat(messages, **kw)
        except LLMError as e:
            self.last_error = str(e)[:200]
            raise

    def chat_json(self, messages: list[dict], **kw: Any) -> Any:
        return extract_json(self.chat(messages, **kw))


def resilient_client(cfg: Optional[dict] = None) -> FallbackClient:
    """文本 LLM：mimo 主 + DeepSeek 备（余额耗尽自动切）。"""
    primary = LLMClient(cfg)
    dk = read_cred_key("DEEPSEEK_API_KEY")
    backup = None
    if dk:
        try:
            backup = LLMClient(cfg, api_url=BACKUP_API_URL, model=BACKUP_MODEL, key=dk)
        except Exception:  # noqa: BLE001
            backup = None
    return FallbackClient(primary, backup)
