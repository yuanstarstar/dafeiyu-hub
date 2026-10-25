# -*- coding: utf-8 -*-
"""纯 Python 视觉分析：ffmpeg 抽帧 + 多模态模型逐段描述。

为什么有这个模块：`dsh-video-understand` 插件在本机会话沙箱里跑不起来
（node 子进程写 args.json 一律 PermissionError），整条分析链降级成
「画面较平稳」这种无信息分段，讲稿自然与画面无关。这里绕开 node：
用 ffmpeg 抽帧（子进程只读视频、写 workspace 内的 jpg，没问题），
再把帧按 base64 直接喂给 mimo 视觉接口，得到逐段具体画面描述。

产物与 `Analyzer` 一致：`list[AnalysisSegment]` + cost + model 名，
可直接塞回 `Analyzer.analyze()` 的降级分支或独立跑 `tools/_run_vision.py`。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from .config import CFG, DATA
from .llm import LLMClient
from .models import AnalysisSegment

LOG = logging.getLogger("livehub.vision")

_HOME = Path(os.environ.get("USERPROFILE") or str(Path.home()))
FFMPEG_DEFAULT = (os.environ.get("LIVEHUB_FFMPEG") or shutil.which("ffmpeg")
                  or str(_HOME / ".dsh" / "tools" / "ffmpeg" / "bin" / "ffmpeg.exe"))
FRAME_DIR = DATA / "cache" / "frames"

SYSTEM = (
    "你在给一档游戏直播做画面拉片。只描述画面里真实存在的东西，不要臆造。"
    "《以撒的结合》里：主角是以撒（光头小孩，身上有眼泪），紫色/红色圆形是眼泪或敌方弹幕，"
    "左侧竖排图标是道具，左上/左侧数字是心（红心=血量）、金币、钥匙、炸弹，"
    "底部/角落常有怪物（苍蝇、蜘蛛、粪怪、妈妈类 boss 等），房间有门、石头、便便、血迹。"
    "如果画面看不清楚就写看不清，不要编造名字。"
)

PROMPT = """这是同一个游戏录像里 {range} 的 {n} 张截图（按时间顺序，翻转时间见每张前的标注）。
请输出 JSON（不要代码块、不要多余文字）：
{{
  "summary": "整段 60-120 字的连贯描述：以撒在哪个房间、正在做什么、面对什么威胁、血量/资源有没有明显变化。要具体到看得见的物品、怪物、文字。",
  "events": [{{"t": 绝对秒数(数字), "text": "这一瞬间发生的具体事件，20 字内"}}],
  "hazards": "这段时间玩家最可能出事的点（受伤、被围、读秒等），20 字内，没有就空字符串",
  "visible_text": "画面里出现的可读文字/数字，没有就空字符串"
}}
events 给 2-4 条，t 必须是第几张截图对应的绝对秒数。"""


def _ffmpeg() -> str:
    a = CFG.get("analyzer") or {}
    return str(a.get("ffmpeg") or FFMPEG_DEFAULT)


def _safe_id(s: str) -> str:
    s = re.sub(r"[^0-9A-Za-z_.-]+", "_", str(s or ""))
    return s.strip("._-") or "vid"


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


class VisionAnalyzer:
    """抽帧 + 多模态描述。失败抛异常，由调用方决定是否降级。"""

    def __init__(self, cfg=None, client: LLMClient | None = None,
                 frames_per_window: int = 8, width: int = 512, timeout: float = 150.0) -> None:
        self.cfg = cfg or CFG
        self.client = client or LLMClient(cfg=self.cfg)
        self.frames_per_window = max(2, int(frames_per_window))
        self.width = int(width)
        self.timeout = float(timeout)

    @property
    def available(self) -> bool:
        return bool(self.client and self.client.available)

    # ------------------------------------------------------------------ 抽帧
    def _frame(self, video: Path, t: float) -> Path:
        out = FRAME_DIR / f"{_safe_id(video.stem)}_{t:08.2f}.jpg"
        if out.exists() and out.stat().st_size > 800:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "error",
               "-ss", f"{max(0.0, t):.3f}", "-i", str(video),
               "-frames:v", "1", "-vf", f"scale={self.width}:-2",
               "-q:v", "4", "-y", str(out)]
        subprocess.run(cmd, check=True, timeout=90,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if not out.exists() or out.stat().st_size < 800:
            raise RuntimeError(f"抽帧失败 t={t:.1f}")
        return out

    def _times(self, t0: float, t1: float) -> list[float]:
        span = max(1.0, t1 - t0)
        n = self.frames_per_window
        step = span / n
        return [round(t0 + step * (i + 0.5), 2) for i in range(n)]

    # ------------------------------------------------------------------ 单段
    def describe_window(self, video: str | Path, t0: float, t1: float,
                        progress_cb=None) -> dict:
        video = Path(str(video))
        times = self._times(float(t0), float(t1))
        parts: list[dict] = [{
            "type": "text",
            "text": PROMPT.format(range=f"{t0:.0f}-{t1:.0f}s", n=len(times)),
        }]
        for t in times:
            f = self._frame(video, t)
            parts.append({"type": "text", "text": f"[第{t:.1f}秒截图]"})
            parts.append({"type": "image_url",
                          "image_url": {"url": f"data:image/jpeg;base64,{_b64(f)}"}})
        if progress_cb:
            progress_cb(f"视觉描述 {t0:.0f}-{t1:.0f}s")
        started = time.time()
        data = self.client.chat_json(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": parts}],
            temperature=0.35, max_tokens=1600, timeout=self.timeout)
        if not isinstance(data, dict):
            raise RuntimeError(f"视觉返回不是对象: {type(data).__name__}")
        summary = str(data.get("summary") or "").strip()
        if len(summary) < 12:
            raise RuntimeError("视觉 summary 过短")
        events: list[dict] = []
        seen: set[float] = set()
        for e in (data.get("events") or [])[:6]:
            if not isinstance(e, dict):
                continue
            try:
                et = float(e.get("t"))
            except (TypeError, ValueError):
                continue
            et = min(max(et, float(t0)), float(t1))
            key = round(et, 1)
            text = str(e.get("text") or "").strip()[:60]
            if text and key not in seen:
                seen.add(key)
                events.append({"t": round(et, 2), "text": text})
        events.sort(key=lambda x: x["t"])
        return {
            "t0": round(float(t0), 2),
            "t1": round(float(t1), 2),
            "summary": summary,
            "events": events,
            "hazards": str(data.get("hazards") or "").strip()[:80],
            "visible_text": str(data.get("visible_text") or "").strip()[:80],
            "elapsed_s": round(time.time() - started, 1),
        }

    @staticmethod
    def to_segment(desc: dict) -> AnalysisSegment:
        """把描述压成 AnalysisSegment：summary 里带时间点事件，writer 能引用。"""
        ev = desc.get("events") or []
        tail = "；".join(f"{float(e['t']):.0f}s {e['text']}" for e in ev[:4])
        notes: list[str] = []
        if desc.get("hazards"):
            notes.append(f"危险点：{desc['hazards']}")
        if desc.get("visible_text"):
            notes.append(f"画面文字：{desc['visible_text']}")
        summary = desc.get("summary") or ""
        if tail:
            summary = f"{summary}（{tail}）"
        return AnalysisSegment(t0=float(desc["t0"]), t1=float(desc["t1"]),
                               summary=summary, visual_notes="；".join(notes))

    # ------------------------------------------------------------------ 整片
    def analyze(self, video_path: str | Path, windows: list[tuple[float, float]],
                progress_cb=None) -> tuple[list[AnalysisSegment], float, str]:
        """逐窗口描述，返回 (segments, cost, model)。任何一段失败抛异常。"""
        segs: list[AnalysisSegment] = []
        total = max(1, len(windows))
        for i, (t0, t1) in enumerate(windows):
            if progress_cb:
                p0 = 0.05 + 0.9 * (i / total)
                progress_cb(p0, f"视觉分析 {t0:.0f}-{t1:.0f}s")
            desc = self.describe_window(video_path, t0, t1)
            segs.append(self.to_segment(desc))
            LOG.info("[vision] window %s-%s ok elapsed=%.1fs events=%d",
                     int(t0), int(t1), desc.get("elapsed_s", 0), len(desc.get("events") or []))
        cost = float((self.client.stats() or {}).get("cost_cny") or 0.0)
        return segs, round(cost, 5), "mimo-vlm"


def default_windows(duration: float, window: float = 60.0) -> list[tuple[float, float]]:
    duration = float(duration or 0.0)
    if duration <= 0:
        return []
    if duration <= window + 0.5:
        return [(0.0, duration)]
    out = []
    t = 0.0
    while t < duration - 0.5:
        out.append((t, min(t + window, duration)))
        t += window
    return out


def dump(descs: list[dict], path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(descs, ensure_ascii=False, indent=2), encoding="utf-8")
