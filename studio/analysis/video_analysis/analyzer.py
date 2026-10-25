# -*- coding: utf-8 -*-
"""视频理解分析模块（live-media 维护）。

对外接口（见 CONTRACT.md §6）：

    analyzer = Analyzer(cfg)
    analysis = analyzer.analyze(video_path, video_id, progress_cb=None) -> Analysis
    analyzer.selftest() -> {"ok":bool,"mode":"plugin|local|failed","error":str}

主路径：ffprobe 取时长 → 调 dsh-video-understand 插件（node + test-plugin.mjs）：
  * ≤ window 秒（默认 180）的视频：一次 level=l1 调用，2 个自定义问题；
  * 更长的视频：按 3 分钟 window 分段调用（level=l2 + window 参数），每段 2 问，合并结果；
  * 无音轨视频：插件 pipeline 会在 extract_audio 阶段 FFMPEG_FAILED 中止，自动垫一条
    静音轨到临时副本后再喂插件（插件本身不支持 silent 视频）；
  * 单段超时 kill / 失败 / 预算用尽：该区间退化为本地分析。
降级路径：ffmpeg 每 5s 抽低分辨率灰度帧算亮度/运动能量，切成 6~10 个章节 segments。
结果落盘 data/analysis/<video_id>.json；存在且比视频新则直接复用。
本模块所有失败都内部消化，analyze() 绝不抛异常。
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import threading
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .config import DATA
from .models import Analysis, AnalysisSegment

LOG = logging.getLogger("livehub.analyzer")

_HOME = Path(os.environ.get("USERPROFILE") or str(Path.home()))
FFMPEG_DEFAULT = (os.environ.get("LIVEHUB_FFMPEG") or shutil.which("ffmpeg")
                  or str(_HOME / ".dsh" / "tools" / "ffmpeg" / "bin" / "ffmpeg.exe"))
NODE_DEFAULT = (os.environ.get("LIVEHUB_NODE")
                or str(_HOME / ".dsh" / "dsh-runtimes" / "dsh-plugin-desktop-primary-runtime"
                       / "dependencies" / "node" / "bin" / "node.exe"))
SCRIPT_DEFAULT = (os.environ.get("LIVEHUB_SCRIPT")
                  or str(_HOME / "Documents" / "deepseek-harness" / "default-workspace"
                         / ".tools" / "test-plugin.mjs"))

WINDOW_S = 180.0            # > 该时长按 window 分段（3 分钟）
SEG_TIMEOUT_S = 360.0       # 单段插件调用上限（6 分钟）
FRAME_STEP_S = 5.0          # 本地分析抽帧间隔

# 插件是 CPU 重的串行 pipeline，多个分析并发会互相拖死：进程内串行化
_PLUGIN_LOCK = threading.Lock()

_ANALYZE_QUESTIONS = [
    # 第一问必须命中插件的「视觉意图路由」（外观/颜色/位置/场景细节），否则会被判成
    # summary → L0，只用轨迹数据回答，等于白瞎 VLM。
    "画面里出现了什么角色、怪物和物体？它们长什么样、什么颜色、在画面什么位置、"
    "周围是什么场景（房间/地形）？请按时间顺序分点描述，每点用「大约X–Ys：」开头。",
    "画面上的文字与关键事件：哪些时间点屏幕上出现了文字（道具名/提示/BOSS名/死亡画面），"
    "哪些时间点发生了战斗、受伤、拾取道具、开宝箱、商店、BOSS 战或死亡？"
    "请按时间顺序分点列出，每点用「X–Ys：」开头。",
]

# 时间范围：约2–14s / 第5秒到第12秒 / 10-30s
_RANGE_PAT = re.compile(
    r"(?:第\s*)?(\d{1,4}(?:\.\d+)?)\s*(?:秒|s)?\s*(?:[-–—~～至到])\s*"
    r"(?:第\s*)?(\d{1,4}(?:\.\d+)?)\s*(?:秒|s)", re.I)
_POINT_PAT = re.compile(r"(?:第\s*)?(\d{1,4}(?:\.\d+)?)\s*(?:秒|s)", re.I)
_TIME_HEAD = re.compile(
    r"^[\s\-–—*•·>\|]*((?:大约|约|第)?\s*\d{1,4}(?:\.\d+)?\s*(?:秒|s)?\s*"
    r"(?:[-–—~～至到]\s*\d{1,4}(?:\.\d+)?\s*(?:秒|s)?)?)\s*[：:]\s*", re.I)
_BULLET = re.compile(r"^[\s\-–—*•·>\|]+")
_NUM = re.compile(r"^\d{1,3}\s*[.、)．]\s*")
_MD = re.compile(r"[*#`]{1,3}")


# ------------------------------------------------------------------ 工具函数
def _creationflags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _safe_id(video_id: str) -> str:
    s = re.sub(r"[^0-9A-Za-z_\-\.]+", "_", str(video_id or "")).strip("._ ") or "video"
    return s[:120]


def _kill_tree(pid: int) -> None:
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=20, creationflags=_creationflags())
        return
    except Exception:
        pass
    try:
        os.kill(pid, 9)
    except Exception:
        pass


def _run_text(cmd: list[str], timeout: float, cwd: str | None = None,
              env: dict | None = None) -> tuple[int, str, str]:
    p = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", cwd=cwd, env=env,
        creationflags=_creationflags(),
    )
    try:
        out, err = p.communicate(timeout=max(1.0, float(timeout)))
        return int(p.returncode or 0), out or "", err or ""
    except subprocess.TimeoutExpired:
        _kill_tree(int(p.pid or 0))
        try:
            p.communicate(timeout=15)
        except Exception:
            pass
        raise TimeoutError(f"命令超时 {timeout:.0f}s: {Path(str(cmd[0])).name}") from None


def _run_bytes(cmd: list[str], timeout: float, env: dict | None = None) -> bytes:
    p = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        creationflags=_creationflags(),
    )
    try:
        out, _ = p.communicate(timeout=max(1.0, float(timeout)))
        if int(p.returncode or 0) != 0:
            raise RuntimeError(f"命令失败 rc={p.returncode}")
        return out or b""
    except subprocess.TimeoutExpired:
        _kill_tree(int(p.pid or 0))
        try:
            p.communicate(timeout=10)
        except Exception:
            pass
        raise TimeoutError("抽帧超时") from None


def _clean_summary(line: str) -> str:
    s = _MD.sub("", line or "")
    s = _BULLET.sub("", s, count=1)
    s = _NUM.sub("", s, count=1)
    s = _TIME_HEAD.sub("", s, count=1)
    s = _BULLET.sub("", s, count=1)
    s = _NUM.sub("", s, count=1)
    s = _TIME_HEAD.sub("", s, count=1)
    s = s.replace("**", "").strip(" ：:，,、-–—|")
    s = re.sub(r"\s+", " ", s)
    if len(s) > 100:
        s = s[:100].rstrip("，,。；; ") + "…"
    return s or "画面继续"


def _segments_from_candidates(cands: list[list], wt0: float, wt1: float,
                              texts: list[str]) -> list[AnalysisSegment]:
    """从带时间范围的候选生成窗口内 segments；不足 2 个则等分窗口兜底。"""
    # 答案里常有「0–60s：全程无事件」这种覆盖整窗的粗粒度行，会把细粒度分段吞掉；
    # 有足够细粒度候选时（≥2 条且每条不超过窗口 70%）优先用细的。
    win = max(1.0, float(wt1) - float(wt0))
    small = [c for c in cands if float(c[1]) - float(c[0]) <= 0.7 * win]
    if len(small) >= 2:
        cands = small
    sized = []
    for a, b, sm in cands:
        a = max(wt0, min(wt1, float(a)))
        b = max(wt0, min(wt1, float(b)))
        if b - a < 1.0:
            continue
        sized.append([a, b, sm or "画面继续"])
    sized.sort(key=lambda x: x[0])

    out: list[list] = []
    for a, b, sm in sized:
        if out and a < out[-1][1] - 0.5:
            a = out[-1][1]
        if b - a < 1.0:
            continue
        out.append([a, b, sm])

    if len(out) < 2:
        # 答非所问 / 没带时间戳：按窗口等分，把回答文本按顺序分配
        span = max(1.0, wt1 - wt0)
        n = max(2, min(4, int(round(span / 20.0)) or 2))
        lines: list[str] = []
        for t in texts:
            for ln in str(t).splitlines():
                ln = _clean_summary(ln)
                if ln and ln != "画面继续":
                    lines.append(ln)
        plain = " ".join(lines)[:600]
        out = []
        step = span / n
        for k in range(n):
            a = wt0 + k * step
            b = min(wt1, a + step) if k < n - 1 else wt1
            if plain:
                part = plain[int(len(plain) * k / n):int(len(plain) * (k + 1) / n)].strip()
                sm = part[:100] or f"第{k + 1}段：画面继续"
            else:
                sm = f"第{k + 1}段：画面继续"
            out.append([a, b, sm])

    segs = [AnalysisSegment(round(float(a), 2), round(float(b), 2), str(sm))
            for a, b, sm in out]
    segs = [s for s in segs if s.t1 > s.t0]
    return segs


# ------------------------------------------------------------------ Analyzer
class Analyzer:
    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        a = (self.cfg.get("analyzer") or {}) if isinstance(self.cfg, dict) else {}
        self.acfg = dict(a)
        self.enabled = bool(a.get("enabled", True))
        self.level = str(a.get("level") or "l1")
        self.budget_cny = float(a.get("budget_cny", 0.03) or 0.03)
        self.node = str(a.get("node") or NODE_DEFAULT)
        self.script = str(a.get("script") or SCRIPT_DEFAULT)
        self.ffmpeg = str(a.get("ffmpeg") or FFMPEG_DEFAULT)
        self.ffprobe = self._derive_ffprobe()
        self.fallback_local = bool(a.get("fallback_local", True))
        self.window_s = float(a.get("window_s") or WINDOW_S)
        self.seg_timeout = float(a.get("segment_timeout_s") or SEG_TIMEOUT_S)
        # 插件内 LLM 的显式配置：小米旧模型 mimo-v2.5 已下线（HTTP 400 Unsupported model），
        # 改用 mimo-v2.6-flash（文本+视觉都可用、成本低）。LLM_API_KEY 从 DSH 凭据读。
        self.llm_model = str(a.get("llm_model") or "mimo-v2.6-flash")
        self.llm_api_url = str(a.get("llm_api_url") or "https://api.xiaomimimo.com/v1/chat/completions")
        # 分析主力：vision = 纯 Python 视觉直读（快、便宜、描述贴画面）；
        # plugin = node 视觉插件 dsh-video-understand（AVIS 轨迹层更全，但要跑 ASR+YOLO，慢一个量级）
        # auto = 先插件、失败再视觉兜底（老行为）。
        # 实测同一支 221s 视频：vision 84s / 0.009 元 / 4 段具体画面描述；
        # plugin 1006s / 0.052 元 / 14 段多为 unknown 轨迹。直播链路等不起 17 分钟，故默认 vision。
        self.prefer = str(a.get("prefer") or "vision").strip().lower()
        if self.prefer not in ("vision", "plugin", "auto"):
            self.prefer = "vision"

        self.analysis_dir = Path(DATA) / "analysis"
        try:
            self.analysis_dir.mkdir(parents=True, exist_ok=True)
        except Exception:  # pragma: no cover
            pass
        # 插件/引擎的临时文件目录：必须放在工作区（系统 %TEMP% 在本机沙箱里不可写，
        # 否则引擎 extract_audio 的 ffmpeg 会因无法写 wav 而 FFMPEG_FAILED）。
        # 注意：不要用 data/tmp —— 该目录被 ACL 放了 Everyone:(DENY)(DC)，
        # 子进程写 args.json 会 PermissionError（实测），统一改到 data/cache/analyzer。
        self.tmp_dir = Path(str(a.get("tmp_dir") or (Path(DATA) / "cache" / "analyzer")))
        try:
            self.tmp_dir.mkdir(parents=True, exist_ok=True)
        except Exception:  # pragma: no cover
            self.tmp_dir = Path(DATA) / "cache"

        self.last_mode = ""
        self.last_error = ""
        self.last_cost = 0.0

    # -------------------------------------------------------------- 路径/基础
    def _derive_ffprobe(self) -> str:
        try:
            if self.ffmpeg:
                sib = Path(self.ffmpeg).with_name("ffprobe.exe")
                if sib.exists():
                    return str(sib)
        except Exception:
            pass
        return shutil.which("ffprobe") or ""

    def _plugin_spec_ok(self) -> bool:
        return bool(self.enabled and self.node and Path(self.node).exists()
                    and Path(self.script).exists())

    @staticmethod
    def _read_cred_key(name: str) -> str:
        """从 DSH 凭据文件读一个 key（兼容 "KEY: v" 和 "KEY = v" 两种写法）。"""
        try:
            cred = Path(os.path.expanduser("~/.dsh/.credentials.yaml"))
            if not cred.exists():
                return ""
            text = cred.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"(?m)^\s*" + re.escape(name) + r"\s*[:=]\s*([^\s#]+)", text)
            return m.group(1).strip() if m else ""
        except Exception:  # noqa: BLE001
            return ""

    def _analysis_path(self, vid: str) -> Path:
        return self.analysis_dir / f"{vid}.json"

    # -------------------------------------------------------------- 主入口
    def analyze(self, video_path: str, video_id: str, progress_cb=None) -> Analysis:
        t_start = time.time()
        vid = _safe_id(video_id)
        progress = self._make_progress(progress_cb)

        progress(0.01, "检查分析缓存")
        cached = self._load_cache(video_path, vid)
        if cached is not None:
            self.last_mode = "cache"
            LOG.info("[analyzer] %s 命中缓存", vid)
            progress(1.0, "复用已有分析结果")
            return cached

        path = Path(str(video_path)) if video_path else Path("")
        duration = 0.0
        errors: list[str] = []
        transcript: list[dict] = []
        qa: list[dict] = []
        segs: list[AnalysisSegment] = []
        cost = 0.0
        used_plugin = False
        used_local = False
        used_vision = False
        model = ""

        if path.exists():
            progress(0.04, "读取视频时长")
            duration = self._probe_duration(path)
        else:
            errors.append(f"视频文件不存在: {path}")

        windows: list[tuple[float, float]] = []
        if duration > 0:
            if duration > self.window_s + 0.5:
                starts = [x * self.window_s for x in range(int(math.ceil(duration / self.window_s)))]
                windows = [(s, min(s + self.window_s, duration)) for s in starts]
            else:
                windows = [(0.0, duration)]

        failed_windows: list[tuple[float, float]] = []
        plugin_ok = self._plugin_spec_ok() and duration > 0 and self.prefer != "vision"
        if self.prefer == "vision":
            # 主力是视觉直读：所有窗口直接排进「待直读」队列，插件不启动。
            failed_windows.extend(windows)
        if not self.enabled:
            errors.append("analyzer 已禁用（enabled=false）")
        if plugin_ok:
            total = len(windows)
            plugin_path, plugin_tmp = self._prepare_plugin_input(path)
            try:
                for i, (wt0, wt1) in enumerate(windows):
                    progress(0.08 + 0.82 * (i / max(1, total)),
                             f"插件分析 {wt0:.0f}-{wt1:.0f}s")
                    # 总预算严格不超 cfg["analyzer"]["budget_cny"]：按窗口数均分，
                    # 不用「剩余预算/剩余窗口」，避免各窗口预算之和超出总预算。
                    base_budget = self.budget_cny / max(1, total)
                    budget_left = max(0.0, self.budget_cny - cost)
                    per_budget = round(min(base_budget, budget_left), 4)
                    if per_budget < 0.001:
                        errors.append("预算用尽，剩余区间走本地分析")
                        failed_windows.extend(windows[i:])
                        break
                    try:
                        res = self._invoke_plugin(plugin_path, wt0, wt1, duration, per_budget)
                        wsegs, wtr, wqa = self._parse_plugin_result(res, wt0, wt1, duration)
                        if not wsegs:
                            raise RuntimeError("插件未返回可用分段")
                        segs.extend(wsegs)
                        transcript.extend(wtr)
                        qa.extend(wqa)
                        cost += float(res.get("cost_cny") or 0.0)
                        used_plugin = True
                        layer = self._plugin_layer(res)
                        if layer and not model:
                            model = f"dsh-video-understand/{layer}"
                        LOG.info("[analyzer] %s window %s-%s 完成：segs=%d cost=%.5f elapsed=%.0fs",
                                 vid, int(wt0), int(wt1), len(wsegs),
                                 float(res.get("cost_cny") or 0.0),
                                 time.time() - t_start)
                    except Exception as exc:  # noqa: BLE001
                        msg = f"{type(exc).__name__}: {exc}"
                        errors.append(f"插件分析 {wt0:.0f}-{wt1:.0f}s 失败: {msg}")
                        LOG.warning("[analyzer] %s %s", vid, errors[-1])
                        failed_windows.append((wt0, wt1))
            finally:
                if plugin_tmp is not None:
                    shutil.rmtree(plugin_tmp, ignore_errors=True)

        if failed_windows:
            # 插件跑不起来（本机沙箱下 node 子进程写不了 args.json）时，
            # 先用纯 Python 视觉模型直读画面——它给的是「以撒在哪个房间、
            # 血量掉了、被什么围住」这种真信息；本地亮度/能量分段只能产出
            # 「画面较平稳」，讲稿必然与画面无关，所以放在最后兜底。
            progress(0.9, "视觉模型直读画面" if self.prefer == "vision" else "插件不可用，改用视觉模型直读画面")
            try:
                from .vision import VisionAnalyzer

                va = VisionAnalyzer(cfg=self.cfg)
                if not va.available:
                    raise RuntimeError("没有可用的多模态 key")
                still_failed: list[tuple[float, float]] = []
                for wt0, wt1 in list(failed_windows):
                    try:
                        d = va.describe_window(path, wt0, wt1)
                        segs.append(VisionAnalyzer.to_segment(d))
                        used_vision = True
                        LOG.info("[analyzer] %s window %s-%s 视觉兜底完成 elapsed=%.1fs",
                                 vid, int(wt0), int(wt1), float(d.get("elapsed_s") or 0))
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"视觉分析 {wt0:.0f}-{wt1:.0f}s 失败: {type(exc).__name__}: {exc}")
                        LOG.warning("[analyzer] %s %s", vid, errors[-1])
                        still_failed.append((wt0, wt1))
                if used_vision:
                    cost += float((va.client.stats() or {}).get("cost_cny") or 0.0)
                failed_windows = still_failed
            except Exception as exc:  # noqa: BLE001
                errors.append(f"视觉分析不可用: {type(exc).__name__}: {exc}")

        if failed_windows:
            progress(0.94, "本地抽帧分析兜底")
            try:
                frames = self._local_frames(path, duration) if path.exists() and duration > 0 else []
                for wt0, wt1 in failed_windows:
                    segs.extend(self._energy_segments(frames, wt0, wt1, duration))
                used_local = True
            except Exception as exc:  # noqa: BLE001
                errors.append(f"本地抽帧分析失败: {type(exc).__name__}: {exc}")
                used_local = True

        if not segs and duration > 0 and self.fallback_local:
            progress(0.92, "本地章节分析")
            try:
                segs = self._local_analysis(path, duration)
                used_local = True
            except Exception as exc:  # noqa: BLE001
                errors.append(f"本地分析失败: {type(exc).__name__}: {exc}")

        segs = self._normalize_segments(segs, duration)

        parts: list[str] = []
        if used_plugin:
            parts.append(model or f"dsh-video-understand/{self.level}")
        if used_vision:
            parts.append("mimo-vlm")
        if used_local:
            parts.append("local")
        model = "+".join(parts) or model

        status = "done"
        if not segs:
            status = "done" if duration > 0 else "failed"
            if duration > 0:
                errors.append("未能生成分段（插件与本地分析均无结果）")
            model = model or "local-fallback"

        analysis = Analysis(
            video_id=vid,
            duration=round(float(duration), 3),
            segments=segs,
            transcript=transcript,
            qa=qa,
            cost_cny=round(float(cost), 5),
            model=model,
            status=status,
            error="; ".join(errors)[:400],
            created_at=time.time(),
        )
        try:
            self._save(analysis)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("[analyzer] 保存分析失败: %s", exc)

        self.last_mode = ("plugin" if used_plugin else
                          ("vision" if used_vision else ("local" if used_local else "failed")))
        self.last_error = analysis.error
        self.last_cost = analysis.cost_cny
        LOG.info("[analyzer] %s 完成 status=%s model=%s segs=%d cost=%.5f 用时 %.0fs",
                 vid, analysis.status, analysis.model, len(segs), cost, time.time() - t_start)
        progress(1.0, f"分析完成（{self.last_mode}）")
        return analysis

    # -------------------------------------------------------------- 进度
    @staticmethod
    def _make_progress(cb) -> Callable[[float, str], None]:
        def _progress(p: float, msg: str) -> None:
            if cb is None:
                return
            p = max(0.0, min(1.0, float(p)))
            try:
                cb(p, str(msg))
            except TypeError:
                try:
                    cb(p)  # type: ignore[call-arg]
                except Exception:
                    pass
            except Exception:
                pass
        return _progress

    # -------------------------------------------------------------- 时长
    def _probe_duration(self, path: Path) -> float:
        if not self.ffprobe or not Path(self.ffprobe).exists():
            return 0.0
        try:
            rc, out, _err = _run_text(
                [self.ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "json", str(path)], timeout=30)
            if rc != 0 or "{" not in out:
                return 0.0
            data = json.loads(out[out.index("{"):])
            dur = float(data.get("format", {}).get("duration") or 0.0)
            return round(dur, 3) if dur > 0 else 0.0
        except Exception as exc:  # noqa: BLE001
            LOG.warning("[analyzer] ffprobe 失败: %s", exc)
            return 0.0

    # -------------------------------------------------------------- 插件调用
    def _plugin_layer(self, res: dict) -> str:
        routing = res.get("routing") or {}
        if isinstance(routing, dict):
            for k in ("effective_layer", "level", "initial_layer"):
                v = routing.get(k)
                if v:
                    return str(v)
        return ""

    def _probe_has_audio(self, path: Path) -> bool:
        """ffprobe 判断是否有音轨；判断不了时按「有」处理（不折腾）。"""
        if not self.ffprobe or not Path(self.ffprobe).exists():
            return True
        try:
            rc, out, _err = _run_text(
                [self.ffprobe, "-v", "error", "-select_streams", "a",
                 "-show_entries", "stream=index", "-of", "json", str(path)], timeout=30)
            if rc != 0 or "{" not in out:
                return True
            data = json.loads(out[out.index("{"):])
            return bool(data.get("streams"))
        except Exception as exc:  # noqa: BLE001
            LOG.debug("[analyzer] 音轨探测失败: %s", exc)
            return True

    def _prepare_plugin_input(self, path: Path) -> tuple[Path, Path | None]:
        """插件 pipeline 遇到无音轨视频会在 extract_audio 阶段 FFMPEG_FAILED 中止。

        这里对无音轨视频用 ffmpeg 临时垫一条 anullsrc 静音轨（视频流 copy，不转码），
        返回 (可喂插件的路径, 需要清理的临时目录)；无需处理时返回 (原路径, None)。
        """
        try:
            if not path.exists() or self._probe_has_audio(path):
                return path, None
            if not self.ffmpeg or not Path(self.ffmpeg).exists():
                return path, None
            work = self._mkwork("livehub_an_silent_")
            dst = work / f"{path.stem or 'video'}_with_silent_audio.mp4"
            cmd = [self.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                   "-i", str(path),
                   "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                   "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                   "-c:a", "aac", "-b:a", "24k", "-shortest", str(dst)]
            rc, _out, err = _run_text(cmd, timeout=180)
            if rc == 0 and dst.exists() and dst.stat().st_size > 1000:
                LOG.info("[analyzer] 视频无音轨，已垫静音轨临时副本: %s", dst)
                return dst, work
            shutil.rmtree(work, ignore_errors=True)
            LOG.warning("[analyzer] 垫静音轨失败 rc=%s: %s", rc, (err or "").strip()[-200:])
        except Exception as exc:  # noqa: BLE001
            LOG.warning("[analyzer] 准备插件输入失败: %s", exc)
        return path, None

    def _mkwork(self, prefix: str) -> Path:
        """在 tmp_dir 下建一个唯一工作目录。

        **不要用 tempfile.mkdtemp**：本机沙箱里 mkdtemp 建出来的目录（mode 0o700）
        写文件/建子目录一律 `PermissionError: [Errno 13]`，而 pathlib.mkdir 建的
        同名同层目录完全可写。实测复现稳定，故这里手写唯一目录名。
        """
        base = Path(self.tmp_dir)
        base.mkdir(parents=True, exist_ok=True)
        for _ in range(100):
            d = base / f"{prefix}{uuid.uuid4().hex[:10]}"
            try:
                d.mkdir()
                return d
            except FileExistsError:
                continue
        raise RuntimeError(f"无法在 {base} 下创建工作目录")

    def _neutral_input(self, video_path: Path, work: Path) -> Path:
        """给插件喂一个不含 BV 号的文件名（详见 _invoke_plugin 里的注释）。"""
        import re as _re
        src = Path(video_path)
        if not _re.search(r"BV[0-9A-Za-z]{10}", src.name):
            return src
        dst = work / "input.mp4"
        try:
            if not dst.exists():
                try:
                    os.link(src, dst)
                except OSError:
                    shutil.copy2(src, dst)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("[analyzer] 中性文件名准备失败，直接用原路径: %s", exc)
            return src
        return dst if dst.exists() else src

    def _invoke_plugin(self, video_path: Path, wt0: float, wt1: float,
                       duration: float, budget: float) -> dict:
        """调 test-plugin.mjs（node），返回插件 result dict；失败抛异常。"""
        node, script = self.node, self.script
        windowed = duration > self.window_s + 0.5
        level = "l2" if windowed else (self.level if self.level in ("l0", "l1", "l2") else "l1")
        args: dict[str, Any] = {
            "level": level,
            "noDownload": True,
            "questions": list(_ANALYZE_QUESTIONS[:2]),
            "budgetCny": round(max(0.001, float(budget)), 4),
        }
        if windowed:
            args["window"] = f"{int(wt0)}-{int(min(wt1, duration))}"

        work = self._mkwork("livehub_an_")
        out_file = work / "out.json"
        args_file = work / "args.json"
        try:
            args_file.write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
            env = dict(os.environ)
            env.setdefault("PYTHONUTF8", "1")
            env.setdefault("PYTHONIOENCODING", "utf-8")
            # 引擎把 audio.wav / 抽帧写到 --workdir：必须放工作区可写目录。
            # 系统 %TEMP% 在本机不可写，否则引擎 extract_audio 的 ffmpeg 会 FFMPEG_FAILED。
            env["VIDEO_UNDERSTAND_WORKDIR"] = str(work / "engine_work")
            # 插件默认 LLM 是小米 mimo-v2.5，该模型 API 已下线（HTTP 400 Unsupported model）。
            # 优先：显式 LLM_API_KEY + LLM_MODEL=mimo-v2.6-flash 走真视觉理解（小米端点）。
            # 兜底：拿不到小米 key 时才退回 DSH 凭据里的 DeepSeek key（纯文本模型）。
            if not env.get("LLM_API_KEY"):
                xm_key = self._read_cred_key("XIAOMI_API_KEY")
                if xm_key:
                    env["LLM_API_KEY"] = xm_key
                    env.setdefault("LLM_MODEL", self.llm_model)
                    # 视觉级 visual_level.py 读的是 VLM_MODEL（不是 LLM_MODEL），必须同时给，
                    # 否则回落到已下线的 mimo-v2.5 → 视觉级 HTTP 400 Bad Request。
                    env.setdefault("VLM_MODEL", self.llm_model)
                    if self.llm_api_url:
                        env.setdefault("LLM_API_URL", self.llm_api_url)
                    if self.llm_model:
                        LOG.info("[analyzer] 插件 LLM=%s", self.llm_model)
                elif not env.get("DEEPSEEK_API_KEY") and not env.get("LLM_API_URL"):
                    ds_key = self._read_cred_key("DEEPSEEK_API_KEY")
                    if ds_key:
                        env["DEEPSEEK_API_KEY"] = ds_key
            if self.ffmpeg and Path(self.ffmpeg).exists():
                env["PATH"] = str(Path(self.ffmpeg).parent) + os.pathsep + env.get("PATH", "")
            # 引擎的 target 解析用 `re.search(r"BV[0-9A-Za-z]{10}", target)` 判「这是 BV 号」，
            # 我们的文件名形如 bili_BV1tunw6qETz.mp4 → 会被当成 B 站 BV 而跳过本地文件
            # （报 MEDIA_PROBE_FAILED: 没有本地视频文件）。所以在工作目录里挂一个中性名字的
            # 硬链接（NTFS 支持，失败退复制），再把它喂给插件。
            feed_path = self._neutral_input(video_path, work)
            cmd = [node, script, str(feed_path), str(out_file), str(args_file)]
            with _PLUGIN_LOCK:
                rc, stdout, stderr = _run_text(cmd, timeout=self.seg_timeout,
                                               cwd=str(Path(script).parent), env=env)
            if not out_file.exists():
                tail = (stderr or stdout or "").strip()[-300:]
                raise RuntimeError(f"插件无输出 rc={rc}: {tail}")
            try:
                data = json.loads(out_file.read_text(encoding="utf-8", errors="replace"))
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"插件输出不是合法 JSON: {exc}") from None
            if data.get("error"):
                raise RuntimeError(f"插件报错: {str(data.get('error'))[:300]}")
            res = data.get("result")
            if not isinstance(res, dict):
                raise RuntimeError(f"插件返回为空 rc={rc}")
            res.setdefault("_elapsed_s", data.get("elapsedMs", 0) / 1000.0)
            return res
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _parse_plugin_result(self, res: dict, wt0: float, wt1: float,
                             duration: float) -> tuple[list[AnalysisSegment], list[dict], list[dict]]:
        """插件 result → (segments, transcript, qa)。"""
        answers = [a for a in (res.get("answers") or []) if isinstance(a, dict)]
        avis = res.get("avis") or {}
        if not isinstance(avis, dict):
            avis = {}
        transcript = self._normalize_transcript(avis.get("transcript"))
        qa = []
        texts: list[str] = []
        cands: list[list] = []
        for a in answers:
            ans = str(a.get("answer") or "").strip()
            question = str(a.get("question") or "").strip()
            if ans:
                texts.append(ans)
                qa.append({"q": question, "a": ans})
                for line in ans.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    m = _RANGE_PAT.search(_MD.sub("", line))
                    if not m:
                        continue
                    try:
                        a0, b0 = float(m.group(1)), float(m.group(2))
                    except Exception:
                        continue
                    if b0 <= a0:
                        continue
                    a0 = max(wt0, min(wt1, a0))
                    b0 = max(wt0, min(wt1, b0))
                    if b0 - a0 < 1.0:
                        continue
                    cands.append([a0, b0, _clean_summary(line)])
        # 视觉补充 notes 作为兜底文本（可能为空字符串）
        notes = avis.get("visual_notes") or []
        if isinstance(notes, list):
            note_text = "\n".join(str(n) for n in notes if str(n).strip())
            if note_text:
                texts.append(note_text)
        if not texts and not transcript:
            errs = [e for e in (res.get("errors") or []) if isinstance(e, dict)]
            detail = "; ".join(
                f"{e.get('code') or 'ERR'}:{str(e.get('message') or '')[:120]}"
                for e in errs[:3])
            raise RuntimeError(f"插件无有效回答（{detail}）" if detail else "插件无有效回答")
        segs = _segments_from_candidates(cands, wt0, wt1, texts)
        return segs, transcript, qa

    @staticmethod
    def _normalize_transcript(tr: Any) -> list[dict]:
        out: list[dict] = []
        if not isinstance(tr, list):
            return out
        for item in tr:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or item.get("content") or "").strip()
            if not text:
                continue
            raw_t = item.get("start", item.get("t", item.get("time", 0)))
            try:
                t = float(raw_t)
            except Exception:
                t = 0.0
            out.append({"t": round(t, 2), "text": text})
        out.sort(key=lambda x: x["t"])
        return out

    # -------------------------------------------------------------- 本地降级
    def _local_frames(self, path: Path, duration: float) -> list[dict]:
        """每 5s 抽一帧 64x36 灰度帧，算平均亮度与帧间运动能量。"""
        if not self.ffmpeg or not Path(self.ffmpeg).exists() or duration <= 0:
            return []
        w, h = 64, 36
        frame_size = w * h
        cmd = [self.ffmpeg, "-v", "error", "-nostdin", "-i", str(path),
               "-vf", f"fps=1/{FRAME_STEP_S:g},scale={w}:{h},format=gray",
               "-f", "rawvideo", "-pix_fmt", "gray", "-"]
        timeout = max(30.0, min(240.0, duration * 0.8 + 30.0))
        out = _run_bytes(cmd, timeout=timeout)
        frames: list[dict] = []
        prev = None
        idx = 0
        for off in range(0, len(out) - frame_size + 1, frame_size):
            arr = np.frombuffer(out[off:off + frame_size], dtype=np.uint8).astype(np.float32) / 255.0
            bright = float(arr.mean())
            motion = float(np.mean(np.abs(arr - prev))) if prev is not None else 0.0
            frames.append({"t": idx * FRAME_STEP_S, "bright": round(bright, 4),
                           "motion": round(motion, 4)})
            prev = arr
            idx += 1
        return frames

    def _energy_segments(self, frames: list[dict], t0: float, t1: float,
                         duration: float) -> list[AnalysisSegment]:
        """在 [t0,t1) 内按运动能量切 2~4 段，用于插件失败区间。"""
        t0 = max(0.0, float(t0))
        t1 = min(float(duration or t1), float(t1))
        if t1 - t0 < 1.0:
            return []
        span = t1 - t0
        n = max(2, min(4, int(round(span / 30.0)) or 2))
        step = span / n
        sub = [f for f in frames if t0 - 0.01 <= f["t"] < t1] if frames else []
        motions = [f["motion"] for f in sub[1:]] or [0.0]
        thr = max(0.006, float(np.median(motions)))
        out: list[AnalysisSegment] = []
        for k in range(n):
            a = t0 + k * step
            b = t1 if k == n - 1 else min(t1, a + step)
            fs = [f for f in sub if a <= f["t"] < b] or sub
            bright = float(np.mean([f["bright"] for f in fs])) if fs else 0.5
            motion = float(np.mean([f["motion"] for f in fs])) if fs else 0.0
            desc = "画面变化较大" if motion >= thr else "画面较平稳"
            note = f"平均亮度 {bright:.2f}，运动能量 {motion:.3f}"
            out.append(AnalysisSegment(round(a, 2), round(b, 2),
                                       f"第{k + 1}段：{desc}", note))
        return out

    def _local_analysis(self, path: Path, duration: float) -> list[AnalysisSegment]:
        """整片本地章节：切成 6~10 段。"""
        if duration <= 0:
            return []
        n = max(6, min(10, int(round(duration / 30.0)) or 6))
        frames = self._local_frames(path, duration)
        segs: list[AnalysisSegment] = []
        step = duration / n
        motions = [f["motion"] for f in frames[1:]] or [0.0]
        thr = max(0.006, float(np.median(motions)))
        for k in range(n):
            a = k * step
            b = duration if k == n - 1 else (k + 1) * step
            fs = [f for f in frames if a <= f["t"] < b] or frames
            bright = float(np.mean([f["bright"] for f in fs])) if fs else 0.5
            motion = float(np.mean([f["motion"] for f in fs])) if fs else 0.0
            desc = "画面变化较大" if motion >= thr else "画面较平稳"
            note = f"平均亮度 {bright:.2f}，运动能量 {motion:.3f}"
            segs.append(AnalysisSegment(round(a, 2), round(b, 2),
                                        f"第{k + 1}段：{desc}", note))
        return segs

    # -------------------------------------------------------------- 结果整理
    @staticmethod
    def _normalize_segments(segs: list[AnalysisSegment], duration: float) -> list[AnalysisSegment]:
        duration = max(0.0, float(duration or 0.0))
        items = []
        for s in segs or []:
            try:
                a, b = float(s.t0), float(s.t1)
            except Exception:
                continue
            if duration > 0:
                a = max(0.0, min(duration, a))
                b = max(0.0, min(duration, b))
            if b - a < 0.2:
                continue
            items.append([a, b, str(s.summary or "画面继续"), str(s.visual_notes or "")])
        items.sort(key=lambda x: x[0])
        out: list[list] = []
        for a, b, sm, note in items:
            if out and a < out[-1][1] - 0.05:
                a = out[-1][1]
            if b - a < 0.2:
                continue
            out.append([a, b, sm, note])
        if not out:
            return []
        if duration > 0:
            out[0][0] = 0.0 if out[0][0] < duration else out[0][0]
            for i in range(len(out) - 1):
                if out[i + 1][0] > out[i][1]:
                    out[i][1] = out[i + 1][0]
            out[-1][1] = duration
            out = [x for x in out if x[1] - x[0] >= 0.2]
        return [AnalysisSegment(round(float(a), 2), round(float(b), 2),
                                str(sm)[:200], str(note)[:300])
                for a, b, sm, note in out]

    # -------------------------------------------------------------- 缓存
    def _load_cache(self, video_path: Any, vid: str) -> Analysis | None:
        try:
            cache = self._analysis_path(vid)
            if not cache.exists():
                return None
            vid_path = Path(str(video_path)) if video_path else None
            if vid_path is not None:
                if not vid_path.exists():
                    return None
                try:
                    if cache.stat().st_mtime < vid_path.stat().st_mtime:
                        return None
                except Exception:
                    return None
            data = json.loads(cache.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
                return None
            segs: list[AnalysisSegment] = []
            for s in data.get("segments") or []:
                if not isinstance(s, dict):
                    continue
                try:
                    segs.append(AnalysisSegment(float(s.get("t0", 0.0)),
                                                float(s.get("t1", 0.0)),
                                                str(s.get("summary") or ""),
                                                str(s.get("visual_notes") or "")))
                except Exception:
                    continue
            tr = [x for x in (data.get("transcript") or []) if isinstance(x, dict)]
            qa = [x for x in (data.get("qa") or []) if isinstance(x, dict)]
            return Analysis(
                video_id=str(data.get("video_id") or vid),
                duration=float(data.get("duration") or 0.0),
                segments=segs,
                transcript=tr,
                qa=qa,
                cost_cny=float(data.get("cost_cny") or 0.0),
                model=str(data.get("model") or ""),
                status=str(data.get("status") or "done"),
                error=str(data.get("error") or ""),
                created_at=float(data.get("created_at") or time.time()),
            )
        except Exception as exc:  # noqa: BLE001
            LOG.warning("[analyzer] 读取缓存失败 %s: %s", vid, exc)
            return None

    def _save(self, analysis: Analysis) -> None:
        p = self._analysis_path(_safe_id(analysis.video_id))
        tmp = p.with_suffix(".json.tmp")
        payload = analysis.to_dict() if hasattr(analysis, "to_dict") else json.loads(
            json.dumps(analysis, default=str))
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(str(tmp), str(p))

    # -------------------------------------------------------------- 自检
    def _plugin_import_check(self) -> bool:
        """用 node 动态 import 插件 host 半部分并注册工具（不触网、不分析）。"""
        script = Path(self.script)
        plugin_index = ""
        try:
            text = script.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"['\"]([A-Za-z]:/[^'\"]*dsh/index\.js)['\"]", text)
            if m:
                plugin_index = m.group(1)
        except Exception:
            plugin_index = ""
        if not plugin_index:
            plugin_index = self._find_plugin_index()
        if not plugin_index or not Path(plugin_index).exists():
            raise RuntimeError(f"找不到插件入口 index.js（{plugin_index}）")
        js = (
            "const {pathToFileURL}=await import('node:url');"
            "const t=process.argv[1];"
            "const m=await import(pathToFileURL(t).href);"
            "const a=[];m.apply({effect(){},tools:{register:x=>a.push(x)}},{});"
            "if(!a.length)throw new Error('tool not registered');"
            "console.log('OK');"
        )
        rc, out, err = _run_text([self.node, "--input-type=module", "-e", js, plugin_index],
                                 timeout=30)
        if rc != 0 or "OK" not in out:
            raise RuntimeError((err or out).strip()[-200:] or f"node rc={rc}")
        return True

    @staticmethod
    def _find_plugin_index() -> str:
        home = Path(os.environ.get("USERPROFILE") or str(Path.home()))
        base = home / ".dsh" / "profiles" / "desktop" / "node_modules" / "dsh-video-understand" / "dsh" / "index.js"
        return str(base) if base.exists() else ""

    def selftest(self) -> dict:
        problems: list[str] = []
        ffprobe_ok = bool(self.ffprobe and Path(self.ffprobe).exists())
        ffmpeg_ok = bool(self.ffmpeg and Path(self.ffmpeg).exists())
        if not ffprobe_ok:
            problems.append(f"ffprobe 不存在: {self.ffprobe or '(空)'}")
        if not ffmpeg_ok:
            problems.append(f"ffmpeg 不存在: {self.ffmpeg}")
        if not self.enabled:
            if ffprobe_ok and ffmpeg_ok:
                return {"ok": True, "mode": "local", "error": "analyzer disabled（本地降级可用）"}
            return {"ok": False, "mode": "failed", "error": "; ".join(problems)}

        node_ok = bool(self.node and Path(self.node).exists())
        script_ok = bool(self.script and Path(self.script).exists())
        if not node_ok:
            problems.append(f"node 不存在: {self.node}")
        if not script_ok:
            problems.append(f"插件脚本不存在: {self.script}")
        plugin_ok = False
        if node_ok and script_ok:
            try:
                plugin_ok = self._plugin_import_check()
            except Exception as exc:  # noqa: BLE001
                problems.append(f"插件加载失败: {exc}")
        if plugin_ok and ffprobe_ok:
            return {"ok": True, "mode": "plugin", "error": ""}
        if self.fallback_local and ffprobe_ok and ffmpeg_ok:
            return {"ok": True, "mode": "local", "error": "; ".join(problems)}
        return {"ok": False, "mode": "failed", "error": "; ".join(problems) or "分析器不可用"}
