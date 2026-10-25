#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""大肥鱼七步视频流水线（本地执行）。

输入一份 request JSON：
  shotlist lines -> 豆包逐句配音 -> PIL 卡片 -> ffmpeg 底板 -> timeline.json
  -> work/edit/build.py 渲染 -> 抽帧联系表

不依赖网络，除 TTS（gen_line.py）和 ffmpeg/Pillow 外不依赖第三方包。
输出最后一行 `RESULT {json}`，供 DSH 插件解析。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

W, H = 1920, 1080
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"

BG_TOP = (10, 15, 30)
BG_BOT = (20, 28, 48)
INK = (238, 244, 255)
DIM = (160, 175, 205)
FAINT = (110, 126, 154)
MINT = (110, 231, 183)
ROSE = (251, 113, 133)
AMBER = (251, 191, 36)
CYAN = (125, 211, 252)
PANEL = (255, 255, 255)
LINE = (60, 78, 110)

EMO_COLORS = {
    "撒欢": AMBER,
    "客服腔": CYAN,
    "摆烂": DIM,
    "撒娇": ROSE,
    "吐槽": MINT,
    "嘴硬": AMBER,
}


def log(msg: str = "") -> None:
    print(msg, flush=True)


def progress(pct: int, stage: str = "", msg: str = "") -> None:
    print(f"PROGRESS {pct} {stage} {msg}", flush=True)


def run(cmd, *, cwd=None, timeout=1200, env=None):
    log("$ " + " ".join(str(x) for x in cmd))
    proc = subprocess.run(
        [str(x) for x in cmd],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
    )
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-1200:] + "\n" + (proc.stderr or "")[-1800:]
        raise RuntimeError(f"命令失败（exit {proc.returncode}）：{tail}")
    return proc


def probe_duration(ffprobe: str, path: str) -> float:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    try:
        return max(0.0, float((proc.stdout or "0").strip().splitlines()[0]))
    except Exception:
        return 0.0


def hash_key(*parts) -> str:
    raw = "|".join(str(x) for x in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def norm_lines(raw) -> list[dict]:
    lines = []
    if not isinstance(raw, list):
        return lines
    for idx, item in enumerate(raw, 1):
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            continue
        text = re.sub(r"\s+", " ", str(item.get("text") or item.get("line") or "")).strip()
        if not text:
            continue
        try:
            seg = int(item.get("seg") or item.get("scene") or 1)
        except Exception:
            seg = 1
        name = str(item.get("name") or item.get("section") or f"第 {seg} 段").strip()
        instr = str(item.get("instr") or item.get("emotion") or "客服腔").strip()
        try:
            gap = max(0.0, min(2.0, float(item.get("gap", 0.35))))
        except Exception:
            gap = 0.35
        lines.append({
            "i": idx,
            "seg": max(1, seg),
            "name": name,
            "gap": gap,
            "instr": instr or "客服腔",
            "text": text[:120],
            "video": str(item.get("video") or item.get("recording") or "").strip(),
            "crop": str(item.get("crop") or "").strip(),
        })
    return lines


def get_tts(request: dict, line: dict, out_dir: Path) -> tuple[Path, float]:
    gen_line = request.get("gen_line") or ""
    if not gen_line or not Path(gen_line).is_file():
        raise RuntimeError("找不到 gen_line.py（豆包逐句配音脚本）")
    key = hash_key(line["text"], line["instr"], request.get("voice"), request.get("pitch"))
    base = out_dir / f"L{line['i']:02d}_{key}"
    mp3 = base.with_suffix(".mp3")
    sig = base.with_suffix(".txt")
    want = line["text"] + "||" + line["instr"]
    have = sig.read_text(encoding="utf-8") if sig.is_file() else ""
    if (not mp3.is_file() or mp3.stat().st_size < 2000 or have != want):
        progress(18 + min(20, line["i"] * 2), "配音", f"第 {line['i']} 句")
        proc = run([
            request["python"], gen_line,
            "--text", line["text"],
            "--instr", line["instr"],
            "--voice", str(request.get("voice") or "撒娇学妹"),
            "--pitch", str(int(request.get("pitch", 2))),
            "--out", str(mp3),
        ], timeout=240, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        if not mp3.is_file() or mp3.stat().st_size < 2000:
            raise RuntimeError(f"TTS 没有产出音频：{(proc.stdout or '')[-500:]}")
        sig.write_text(want, encoding="utf-8")
    wav = base.with_suffix(".wav")
    if not wav.is_file() or wav.stat().st_size < 2000 or wav.stat().st_mtime < mp3.stat().st_mtime:
        run([
            request["ffmpeg"], "-y", "-i", str(mp3),
            "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(wav),
        ], timeout=120)
    return wav, probe_duration(request["ffprobe"], str(wav))


def font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.truetype(FONT_REG, size)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, fnt, max_width: int) -> list[str]:
    text = re.sub(r"\s+", "", text)
    rows, cur = [], ""
    for ch in text:
        if ch == "\n":
            rows.append(cur)
            cur = ""
            continue
        if draw.textlength(cur + ch, font=fnt) > max_width and cur:
            rows.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        rows.append(cur)
    return rows


def gradient_bg(seed: int = 0) -> Image.Image:
    img = Image.new("RGB", (W, H), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / max(1, H - 1)
        d.line([(0, y), (W, y)], fill=(
            int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * k),
            int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * k),
            int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * k)))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    x = 260 + (seed * 190) % 1100
    gd.ellipse([x - 380, -420, x + 820, 520], fill=(72, 130, 220, 55))
    gd.ellipse([W - 760 - seed * 90, H - 620, W + 260, H + 200], fill=(185, 90, 205, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    return Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")


def cover_image(path: str) -> Image.Image | None:
    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        return None
    ratio = max(W / img.width, H / img.height)
    nw, nh = int(img.width * ratio), int(img.height * ratio)
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - W) // 2
    top = (nh - H) // 2
    img = img.crop((left, top, left + W, top + H))
    overlay = Image.new("RGBA", (W, H), (8, 12, 24, 145))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def paste_character(img: Image.Image, char_path: str) -> Image.Image:
    try:
        char = Image.open(char_path).convert("RGBA")
    except Exception:
        return img
    max_h = 620
    ratio = min(max_h / char.height, 460 / char.width)
    char = char.resize((max(80, int(char.width * ratio)), max(80, int(char.height * ratio))), Image.LANCZOS)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.alpha_composite(char, (W - char.width - 70, H - char.height - 90))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def make_card(request: dict, seg: dict, index: int, total: int, out_path: Path) -> None:
    seg_assets = request.get("assets") or []
    cover = request.get("cover") or ""
    asset = seg_assets[index % len(seg_assets)] if seg_assets else ""
    bg = cover_image(cover) if (index == 0 and cover and Path(cover).is_file()) else None
    if bg is None and asset and Path(asset).is_file() and any(k in Path(asset).name.lower() for k in ("title", "cover", "bg")):
        bg = cover_image(asset)
    if bg is None:
        bg = gradient_bg(index)
    img = bg
    char = ""
    for item in seg_assets:
        if item and Path(item).is_file() and "char" in Path(item).name.lower():
            char = item
            break
    if char:
        img = paste_character(img, char)
    d = ImageDraw.Draw(img)

    # 顶部信息
    d.rounded_rectangle([120, 82, 540, 146], radius=32, fill=(22, 33, 56), outline=(70, 96, 136), width=2)
    d.text((154, 97), "大肥鱼  /  DAFEIYU", font=font(FONT_BOLD, 27), fill=MINT)
    d.text((W - 460, 98), f"{index + 1:02d} / {total:02d}", font=font(FONT_REG, 28), fill=DIM)

    # 主卡片
    d.rounded_rectangle([118, 240, W - 118, 820], radius=38, fill=PANEL, outline=(215, 225, 240), width=2)
    accent = EMO_COLORS.get(str(seg.get("instr") or ""), MINT)
    d.rectangle([118, 240, 132, 820], fill=accent)

    kicker = "开场" if index == 0 else "一段"
    d.text((176, 292), kicker, font=font(FONT_BOLD, 28), fill=accent)
    title = request.get("title") if index == 0 and request.get("title") else str(seg.get("name") or "一段话")
    title_font = font(FONT_BOLD, 66 if len(title) <= 12 else 54)
    d.text((172, 334), title[:22], font=title_font, fill=(15, 23, 42))
    d.rectangle([176, 438, 520, 445], fill=accent)

    body = "\n".join(str(x.get("text") or "") for x in seg.get("lines", []))
    body_font = font(FONT_REG, 36)
    rows = wrap_text(d, body, body_font, W - 420)
    rows = rows[:7]
    y = 494
    for row in rows:
        d.text((176, y), row, font=body_font, fill=(44, 56, 78))
        y += 54

    # 底部信息
    d.text((176, 760), "AI 辅助创作  ·  画面与配音由大肥鱼完成", font=font(FONT_REG, 24), fill=(120, 136, 160))
    d.text((W - 320, 760), f"{seg['start']:.1f}s — {seg['end']:.1f}s", font=font(FONT_REG, 24), fill=(120, 136, 160))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, quality=95)
    log(f"  卡片 {out_path.name}")


def render_still(ffmpeg: str, card: Path, dur: float, out: Path) -> None:
    frames = max(2, int(round(dur * 30)))
    vf = (
        "scale=3840:2160:flags=lanczos,"
        "zoompan=z='min(1.0+0.00045*on,1.045)':"
        "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
        f"d={frames}:s=1920x1080:fps=30,setsar=1"
    )
    run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-framerate", "30", "-t", f"{dur:.3f}", "-i", str(card),
        "-vf", vf, "-frames:v", str(frames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", "30", "-an", str(out),
    ], timeout=240)


def render_clip(ffmpeg: str, src: str, dur: float, out: Path, crop: str = "") -> None:
    vf = "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30"
    if crop:
        vf = f"crop={crop}," + vf
    run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-stream_loop", "-1", "-i", src, "-t", f"{dur:.3f}",
        "-vf", vf, "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", "30", str(out),
    ], timeout=300)


def concat_videos(ffmpeg: str, files: list[Path], out: Path) -> None:
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    for f in files:
        args += ["-i", str(f)]
    fc = "".join(f"[{i}:v]" for i in range(len(files))) + f"concat=n={len(files)}:v=1:a=0[v]"
    args += [
        "-filter_complex", fc, "-map", "[v]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr", str(out),
    ]
    run(args, timeout=600)


def srt_time(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def split_subtitle(text: str, start: float, end: float) -> list[dict]:
    text = re.sub(r"\s+", "", text)
    if not text:
        return []
    chars = list(text)
    # 按标点先切，再按 16 字硬切，避免一条字幕过长
    parts, cur = [], ""
    for ch in chars:
        cur += ch
        if ch in "。！？!?；;，,、：:" and len(cur) >= 6:
            parts.append(cur)
            cur = ""
        elif len(cur) >= 16:
            parts.append(cur)
            cur = ""
    if cur:
        parts.append(cur)
    total_chars = sum(len(x) for x in parts) or 1
    span = max(0.4, end - start)
    out = []
    cursor = start
    for part in parts:
        d = max(0.35, span * len(part) / total_chars)
        out.append({"text": part, "start": round(cursor, 3), "end": round(cursor + d, 3)})
        cursor += d
    return out


def find_asset(request: dict, needles: tuple[str, ...]) -> str:
    for item in request.get("assets") or []:
        name = Path(item).name.lower()
        if item and Path(item).is_file() and any(n in name for n in needles):
            return item
    return ""


def ensure_silence(ffmpeg: str, work: Path) -> str:
    """build.py 要求 bgm.src 非空；没有 BGM 时给一条可循环的静音底。"""
    target = work / "silence.wav"
    if not target.is_file() or target.stat().st_size < 1000:
        run([
            ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
            "-t", "2", "-c:a", "pcm_s16le", str(target),
        ], timeout=60)
    return str(target)


def build_timeline(request: dict, lines: list[dict], segments: list[dict], base: Path, total: float, out_mp4: Path) -> dict:
    actual = probe_duration(request["ffprobe"], str(base)) or total
    timeline_total = min(total, actual) if actual > 0 else total
    subtitles = []
    for line in lines:
        subtitles.extend(split_subtitle(line["text"], line["start"], line["end"]))
    sfx = []
    whoosh = find_asset(request, ("whoosh", "swish", "transition"))
    if not whoosh:
        for item in os.listdir(request.get("sfx_dir") or "") if request.get("sfx_dir") and os.path.isdir(request.get("sfx_dir")) else []:
            if item.lower().endswith(".wav") and ("whoosh" in item.lower() or "swish" in item.lower()):
                whoosh = os.path.join(request["sfx_dir"], item)
                break
    if whoosh:
        for seg in segments[1:]:
            sfx.append({"src": whoosh, "start": round(max(0, seg["start"] - 0.05), 3), "volume": 0.45})
    bgm = request.get("bgm") or ""
    if not bgm or not Path(bgm).is_file():
        bgm = ensure_silence(request["ffmpeg"], Path(request["work_dir"]))
    timeline = {
        "meta": {
            "title": request.get("title") or request.get("topic") or "大肥鱼视频",
            "output": str(out_mp4),
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "duration": round(timeline_total, 3),
            "voice_lufs": -16,
            "master_lufs": -14,
            "master_tp": -1,
        },
        "video": {
            "clips": [{"src": str(base), "in": 0, "out": round(timeline_total, 3)}],
            "clip_audio_volume": 0.0,
        },
        "voice": [{"src": str(x["wav"]), "start": round(x["start"], 3), "volume": 1.0} for x in lines],
        "sfx": sfx,
        "bgm": {
            "src": bgm,
            "volume": 0.12,
            "loop": True,
            "fade_in": 1.0,
            "fade_out": 2.0,
            "duck": {"enabled": True, "depth_db": -9, "attack": 120, "release": 380},
        } if bgm and Path(bgm).is_file() else {"src": "", "enabled": False},
        "subtitle_style": {
            "font_name": "Microsoft YaHei",
            "font_size": 54,
            "bold": True,
            "primary_color": "#FFFFFF",
            "outline_color": "#000000",
            "outline": 3.0,
            "shadow": 1.5,
            "margin_v": 58,
            "margin_lr": 110,
            "alignment": 2,
        },
        "subtitles": subtitles,
        "watermark": {
            "enabled": True,
            "src": request.get("watermark") or "",
            "position": "top-right",
            "margin": 30,
            "opacity": 0.88,
            "scale": 0.9,
        } if request.get("watermark") and Path(request["watermark"]).is_file() else {"enabled": False},
        "effects": [],
    }
    return timeline


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--request", required=True)
    a = ap.parse_args()
    request = json.loads(Path(a.request).read_text(encoding="utf-8"))
    work = Path(request["work_dir"])
    work.mkdir(parents=True, exist_ok=True)
    out_dir = Path(request["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    job_id = request.get("job_id") or "pipeline"
    started = time.time()

    lines = norm_lines(request.get("lines"))
    if not lines:
        raise RuntimeError("shotlist 里没有台词")
    log(f"分镜 {len(lines)} 句，开始配音")
    progress(8, "配音", "逐句合成")
    for line in lines:
        line["wav"], line["dur"] = get_tts(request, line, work / "tts")

    # 时间轴先由配音决定；段落按 seg 分组
    t = 0.6
    for line in lines:
        line["start"] = round(t + line["gap"], 3)
        line["end"] = round(line["start"] + line["dur"], 3)
        t = line["end"]
    total = round(t + 3.4, 3)

    seg_map = {}
    for line in lines:
        seg_map.setdefault(int(line["seg"]), []).append(line)
    segments = []
    keys = sorted(seg_map)
    for idx, key in enumerate(keys):
        group = seg_map[key]
        start = max(0.0, group[0]["start"] - 0.45) if idx else 0.0
        end = group[-1]["end"] + (0.65 if idx < len(keys) - 1 else 3.4)
        if idx < len(keys) - 1:
            end = min(end, max(start + 0.8, seg_map[keys[idx + 1]][0]["start"] - 0.45))
        segments.append({
            "index": idx,
            "name": group[0]["name"],
            "instr": group[0]["instr"],
            "lines": group,
            "start": round(start, 3),
            "end": round(min(total, end), 3),
            "video": next((line["video"] for line in group if line.get("video")), ""),
            "crop": next((line["crop"] for line in group if line.get("crop")), ""),
        })
    # 保证不重叠、最后一段覆盖到结尾
    for i, seg in enumerate(segments):
        if seg["end"] <= seg["start"]:
            seg["end"] = seg["start"] + 0.8
        if i + 1 < len(segments):
            seg["end"] = min(seg["end"], segments[i + 1]["start"])
    segments[-1]["end"] = total

    log(f"底板 {len(segments)} 段，配音总长 {t:.2f}s")
    progress(46, "卡片", "生成分镜卡片")
    cards = []
    for i, seg in enumerate(segments):
        card = work / "cards" / f"seg_{i + 1:02d}.png"
        make_card(request, seg, i, len(segments), card)
        cards.append(card)

    progress(58, "底板", "渲染静帧并拼接")
    parts = []
    for i, seg in enumerate(segments):
        seg_file = work / "segments" / f"seg_{i + 1:02d}.mp4"
        seg_file.parent.mkdir(parents=True, exist_ok=True)
        video = seg.get("video") or ""
        if video and Path(video).is_file():
            render_clip(request["ffmpeg"], video, seg["end"] - seg["start"], seg_file, seg.get("crop") or "")
            log(f"  录屏段 {i + 1}/{len(segments)} {seg['end'] - seg['start']:.2f}s · {Path(video).name}")
        else:
            render_still(request["ffmpeg"], cards[i], seg["end"] - seg["start"], seg_file)
            log(f"  卡片段 {i + 1}/{len(segments)} {seg['end'] - seg['start']:.2f}s")
        parts.append(seg_file)
    base = work / "base.mp4"
    concat_videos(request["ffmpeg"], parts, base)

    final = out_dir / f"{job_id}.mp4"
    timeline = build_timeline(request, lines, segments, base, total, final)
    timeline_path = work / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")

    progress(72, "渲染", "交给 build.py 烧字幕/混音/母带")
    stills = ",".join(f"{x:.1f}" for x in [1.0, total * 0.3, total * 0.6, max(1, total - 2)])
    build_proc = run([
        request["python"], request["build_py"], str(timeline_path),
        "--output", str(final), "--stills", stills,
    ], cwd=request.get("edit_dir") or None, timeout=1800,
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    log((build_proc.stdout or "")[-3000:])

    duration = probe_duration(request["ffprobe"], str(final))
    cover = out_dir / f"{job_id}.jpg"
    try:
        run([request["ffmpeg"], "-y", "-ss", "0.6", "-i", str(final), "-frames:v", "1", "-q:v", "2", str(cover)], timeout=60)
    except Exception:
        cover = Path("")

    srt = out_dir / f"{job_id}.srt"
    srt.write_text("\n".join(
        f"{i}\n{srt_time(s['start'])} --> {srt_time(s['end'])}\n{s['text']}\n"
        for i, s in enumerate(timeline.get("subtitles") or [], 1)
    ), encoding="utf-8")

    contact = out_dir / f"{job_id}_contact.jpg"
    try:
        run([
            request["ffmpeg"], "-y", "-i", str(final),
            "-vf", "fps=1/2,scale=480:-1,tile=4x3", "-frames:v", "1", "-q:v", "3", str(contact),
        ], timeout=120)
    except Exception:
        contact = Path("")

    result = {
        "engine": "dafeiyu-pipeline",
        "videoPath": str(final),
        "coverPath": str(cover) if cover else "",
        "srtPath": str(srt),
        "contactPath": str(contact) if contact else "",
        "timelinePath": str(timeline_path),
        "basePath": str(base),
        "workDir": str(work),
        "duration": round(duration, 3),
        "title": request.get("title") or request.get("topic") or "大肥鱼视频",
        "lines": [{"i": x["i"], "seg": x["seg"], "text": x["text"], "instr": x["instr"], "start": x["start"], "end": x["end"]} for x in lines],
        "segments": len(segments),
        "elapsed": round(time.time() - started, 1),
    }
    log("RESULT " + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR {exc}", flush=True)
        raise
