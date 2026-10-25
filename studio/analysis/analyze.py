#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""视频解析命令行：切成窗口 → 抽帧 → 多模态模型描述 → JSON / Markdown。"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from video_analysis import config as vcfg          # noqa: E402
from video_analysis.analyzer import Analyzer       # noqa: E402
from video_analysis.models import as_json          # noqa: E402

VIDEO_EXT = {".mp4", ".mkv", ".webm", ".mov", ".flv", ".avi", ".ts"}


def fmt_ts(sec: float) -> str:
    sec = max(0, int(round(float(sec or 0))))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def collect(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    if not target.exists():
        return []
    return sorted(p for p in target.rglob("*") if p.suffix.lower() in VIDEO_EXT)


def write_markdown(path: Path, res) -> None:
    lines = [
        f"# {path.stem} · 画面解析",
        "",
        f"- 时长：{fmt_ts(res.duration)}（{res.duration:.1f}s）",
        f"- 段数：{len(res.segments)}",
        f"- 模型：{res.model or 'local'}",
        f"- 估计花费：¥{res.cost_cny:.3f}",
        f"- 状态：{res.status}" + (f"（{res.error}）" if res.error else ""),
        "",
    ]
    for seg in res.segments:
        lines.append(f"## {fmt_ts(seg.t0)} – {fmt_ts(seg.t1)}")
        lines.append(seg.summary or "（无描述）")
        notes = (seg.visual_notes or "").strip()
        if notes:
            lines.append(f"- 时间点：{notes}")
        lines.append("")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="把视频切成窗口、抽帧交给多模态模型，输出带时间轴的画面描述。")
    ap.add_argument("video", help="视频文件，或包含视频的目录")
    ap.add_argument("--out", default="out", help="输出目录（默认 out）")
    ap.add_argument("--window", type=float, help="每段多少秒（默认 config 里的 window_s，通常 60）")
    ap.add_argument("--frames", type=int, help="每段抽几帧（默认 config 里的 vision_frames，通常 8）")
    ap.add_argument("--model", help="覆盖模型名，例如 mimo-v2.6-flash")
    ap.add_argument("--prefer", choices=["vision", "auto"], help="vision=纯视觉直读（默认）")
    ap.add_argument("--budget", type=float, help="单条视频预算上限（元）")
    ap.add_argument("--id", help="自定义视频 id（默认用文件名；影响缓存路径）")
    ap.add_argument("--fresh", action="store_true", help="忽略缓存，强制重新分析")
    ap.add_argument("--no-save", action="store_true", help="只打印，不写 json/md")
    ap.add_argument("--json", action="store_true", help="把完整 JSON 打到 stdout")
    ap.add_argument("--quiet", action="store_true", help="不打印进度")
    args = ap.parse_args(argv)

    cfg = vcfg.load()
    a = cfg.setdefault("analyzer", {})
    if args.window:
        a["window_s"] = float(args.window)
    if args.frames:
        a["vision_frames"] = int(args.frames)
    if args.model:
        a["llm_model"] = args.model
    if args.prefer:
        a["prefer"] = args.prefer
    if args.budget is not None:
        a["budget_cny"] = float(args.budget)

    target = Path(args.video).expanduser()
    files = collect(target)
    if not files:
        print(f"[x] 没找到视频：{target}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    if not args.no_save:
        out_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()
    total_cost = 0.0
    ok = 0
    for path in files:
        vid = args.id or path.stem
        cache = Path(vcfg.DATA) / "analysis" / f"{vid}.json"
        if args.fresh and cache.exists():
            try:
                cache.unlink()
            except OSError:
                pass

        def cb(p: float, msg: str) -> None:
            if not args.quiet:
                print(f"  [{p * 100:3.0f}%] {msg}", flush=True)

        if not args.quiet:
            print(f"\n=== {path.name} ===", flush=True)
        an = Analyzer(cfg)
        try:
            res = an.analyze(str(path), vid, progress_cb=None if args.quiet else cb)
        except Exception as exc:  # noqa: BLE001
            print(f"[x] {path.name} 失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            continue

        if res.status != "done":
            print(f"[!] {path.name} 状态={res.status} {res.error}", file=sys.stderr)

        if not args.quiet:
            print(f"  时长 {fmt_ts(res.duration)} · {len(res.segments)} 段 · "
                  f"模型 {res.model or 'local'} · ¥{res.cost_cny:.3f} · {res.status}")
            for seg in res.segments:
                head = (seg.summary or "")[:70]
                print(f"  {fmt_ts(seg.t0)}-{fmt_ts(seg.t1)} {head}")

        total_cost += float(res.cost_cny or 0.0)
        ok += 1
        if args.json:
            print(json.dumps(as_json(res), ensure_ascii=False, indent=2))
        elif not args.no_save:
            js = out_dir / f"{path.stem}.analysis.json"
            md = out_dir / f"{path.stem}.analysis.md"
            js.write_text(json.dumps(as_json(res), ensure_ascii=False, indent=2), encoding="utf-8")
            write_markdown(md, res)
            if not args.quiet:
                print(f"  → {js}")
                print(f"  → {md}")

    if not args.quiet:
        took = time.time() - started
        print(f"\n完成 {ok}/{len(files)} 条，用时 {took:.1f}s，估计花费 ¥{total_cost:.3f}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
