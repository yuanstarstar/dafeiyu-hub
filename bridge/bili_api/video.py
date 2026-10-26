# -*- coding: utf-8 -*-
"""视频元信息 + 视频评论区写入口（发评论 / 点赞，受 allow_write 闸控制）。

读：GET /x/web-interface/view?bvid= → aid/cid/标题/时长/播放/UP 主
写：POST /x/v2/reply/add      {oid, type:1, message, plat:1, csrf, root, parent}
    POST /x/web-interface/archive/like {aid, like, csrf}
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from .client import API_PC, BiliClient, UA
from .errors import BiliError
from .live import check_write

BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
_AV_RE = re.compile(r"av(\d+)", re.I)


def parse_bvid(text: str) -> str:
    """从 BV 号 / 链接里抠出 BV 号。"""
    m = BV_RE.search(str(text or ""))
    if not m:
        raise BiliError(f"没找到 BV 号：{text!r}")
    return m.group(1)


def view(client: BiliClient, bvid: str) -> dict:
    """视频元信息（公开接口，不用登录）。"""
    bv = parse_bvid(bvid)
    data = client.api("/x/web-interface/view", {"bvid": bv})
    stat = data.get("stat") or {}
    owner = data.get("owner") or {}
    pages = data.get("pages") or []
    return {
        "bvid": bv,
        "aid": int(data.get("aid") or 0),
        "cid": int((pages[0] or {}).get("cid") or 0) if pages else 0,
        "title": str(data.get("title") or ""),
        "desc": str(data.get("desc") or ""),
        "duration": int(data.get("duration") or 0),
        "pubdate": int(data.get("pubdate") or 0),
        "owner": {"mid": int(owner.get("mid") or 0), "name": str(owner.get("name") or "")},
        "stat": {"view": int(stat.get("view") or 0), "like": int(stat.get("like") or 0),
                 "reply": int(stat.get("reply") or 0), "favorite": int(stat.get("favorite") or 0),
                 "coin": int(stat.get("coin") or 0), "danmaku": int(stat.get("danmaku") or 0)},
        "url": f"https://www.bilibili.com/video/{bv}",
    }


def bvid_to_aid(client: BiliClient, bvid: str) -> int:
    return int(view(client, bvid)["aid"])


def post_comment(client: BiliClient, target: str, message: str, *,
                 root: int = 0, parent: int = 0) -> dict:
    """发一条视频评论（写操作）。target 可以是 BV 号或 aid 数字。

    root/parent 都填时是「回复某条评论」。返回 {ok, rpid, aid}。
    """
    check_write(client)
    client.require_login()
    msg = str(message or "").strip()
    if not msg:
        raise BiliError("评论内容为空")
    if len(msg) > 1000:
        raise BiliError("评论超过 1000 字（B 站上限）")
    t = str(target or "").strip()
    if t.isdigit():
        aid = int(t)
    else:
        aid = bvid_to_aid(client, t)
    data = {"oid": str(aid), "type": "1", "message": msg, "plat": "1",
            "csrf": client.csrf}
    if root:
        data["root"] = str(int(root))
        data["parent"] = str(int(parent or root))
    body = client.api_post("/x/v2/reply/add", data)
    path = f"https://www.bilibili.com/video/{parse_bvid(target)}" if not t.isdigit() \
        else f"https://www.bilibili.com/video/av{aid}"
    return {"ok": True, "aid": aid, "rpid": int(body.get("rpid") or 0), "url": path}


def like_video(client: BiliClient, bvid: str, like: int = 1) -> dict:
    """给视频点赞 / 取消点赞（写操作，like=1 赞、0 取消）。"""
    check_write(client)
    client.require_login()
    aid = bvid_to_aid(client, bvid)
    client.api_post("/x/web-interface/archive/like",
                    {"aid": str(aid), "like": str(int(like)), "csrf": client.csrf})
    return {"ok": True, "aid": aid, "like": int(like)}


# ------------------------------------------------------------------ 下载
def _find_ffmpeg(client: BiliClient) -> str:
    cfg = client.cfg or {}
    for key in ("ffmpeg", "ffmpeg_path"):
        p = str(cfg.get(key) or "").strip()
        if p and Path(p).exists():
            return p
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    fallback = Path.home() / ".dsh" / "tools" / "ffmpeg" / "bin" / "ffmpeg.exe"
    if fallback.exists():
        return str(fallback)
    raise BiliError("找不到 ffmpeg：PATH 里没有，config.json 的 bili.ffmpeg 也没配")


def playurl(client: BiliClient, bvid: str, cid: int = 0, qn: int = 64) -> dict:
    """取播放直链（匿名最高一般 720P；durl 是整段 mp4，省去合并音轨）。"""
    meta = view(client, bvid)
    cid = int(cid or meta["cid"])
    if not cid:
        raise BiliError(f"{meta['bvid']} 没有 cid（分 P 信息缺失）")
    params = {"bvid": meta["bvid"], "cid": cid, "qn": qn, "fnval": 1,
              "fnver": 0, "fourk": 1}
    data = client.api("/x/player/wbi/playurl", params, wbi=True)
    durl = data.get("durl") or []
    urls = [str(x.get("url") or "") for x in durl if x.get("url")]
    if not urls:
        raise BiliError("playurl 没给 durl（可能被要求登录/风控）")
    return {"urls": urls, "quality": int(data.get("quality") or 0),
            "accept_quality": data.get("accept_quality") or [], "meta": meta}


def download(client: BiliClient, bvid: str, dest: str | Path, *,
             qn: int = 64, timeout_s: float = 900.0) -> dict:
    """下载 B 站视频（单段 mp4）到 dest。慢/大文件用 ffmpeg 走 CDN，断点不管。

    返回 {path, bvid, size, duration}。写盘成功才改名，失败留 .part 方便排查。
    """
    info = playurl(client, bvid, qn=qn)
    meta = info["meta"]
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    ffmpeg = _find_ffmpeg(client)
    url = info["urls"][0]
    headers = (f"Referer: https://www.bilibili.com/\r\n"
               f"User-Agent: {client.cfg.get('user_agent') or UA}\r\n"
               f"Origin: https://www.bilibili.com\r\n")
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-headers", headers,
           "-i", url, "-c", "copy", "-f", "mp4", str(part)]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        raise BiliError(f"下载超时（{timeout_s:.0f}s）：{meta['bvid']}") from e
    if proc.returncode != 0 or not part.exists() or part.stat().st_size == 0:
        err = (proc.stderr or b"").decode("utf-8", "replace")[-300:]
        part.unlink(missing_ok=True)
        raise BiliError(f"ffmpeg 下载失败：{err or '无输出'}")
    os.replace(part, dest)
    return {"path": str(dest), "bvid": meta["bvid"], "size": dest.stat().st_size,
            "duration": meta.get("duration"), "title": meta.get("title")}
