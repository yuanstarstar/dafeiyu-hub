# -*- coding: utf-8 -*-
"""看评论：视频评论区 / 楼中楼 / 动态评论区，以及评论的本地统计。

接口（2026-10 实测口径）：
- 视频评论首页：GET api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=2&ps=20
  mode=2 按热度、mode=3 按时间
- 后续分页：GET api.bilibili.com/x/v2/reply/wbi/main?oid&type=1&mode=2&pagination_str={"offset":"…"}
  （需 WBI 签名；返回 cursor.pagination_reply.next 作为下一页 offset）
- 楼中楼：GET api.bilibili.com/x/v2/reply/reply?type=1&oid={aid}&root={rpid}&ps=20&pn=1
- 动态详情：GET api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail?dynamic_id=…
  → data.card.desc.rid/type，动态评论 = type=17, oid=rid

只读，不发评论（发评论在 video.py / 写操作总闸后面）。
"""
from __future__ import annotations

import json
import re
import time
from collections import Counter
from typing import Any, Optional

from .client import API_PC, BiliClient
from .errors import BiliError

# 粗略情感词表（本地统计用，不当结论）
POS_WORDS = ("好听", "好看", "哈哈", "棒", "可爱", "喜欢", "爱了", "厉害", "牛", "赞",
             "优秀", "支持", "心疼", "感动", "太强", "绝了", "不错", "舒服", "精彩")
NEG_WORDS = ("不好", "难看", "吵", "失望", "无聊", "尴尬", "恶心", "难看", "差",
             "退了", "别播", "乱说", "拉胯", "无语", "烦")

LEVEL_TAGS = [
    (f"L{level}", re.compile(rf"【\s*L{level}\s*】"))
    for level in (1, 2)
]


def _norm_reply(r: dict, up_mid: int = 0) -> dict:
    member = r.get("member") or {}
    content = r.get("content") or {}
    level_info = member.get("level_info") or {}
    vip = member.get("vip") or {}
    mid = int(member.get("mid") or 0)
    up_action = r.get("up_action") or {}
    return {
        "rpid": int(r.get("rpid") or r.get("rpid_str") or 0),
        "root": int(r.get("root") or 0),
        "oid": int(r.get("oid") or 0),
        "type": int(r.get("type") or 1),
        "mid": mid,
        "uname": str(member.get("uname") or ""),
        "level": int(level_info.get("current_level") or 0),
        "vip": int(vip.get("vipStatus") or 0) == 1 or int(vip.get("vipType") or 0) > 0,
        "up_like": int(up_action.get("like") or 0) == 1,
        "message": str(content.get("message") or ""),
        "like": int(r.get("like") or 0),
        "rcount": int(r.get("rcount") or 0),
        "ctime": int(r.get("ctime") or 0),
        "is_up": bool(mid and up_mid and mid == up_mid),
        "replies": [_norm_reply(x, up_mid) for x in (r.get("replies") or [])[:3]
                    if isinstance(x, dict)],
    }


def video_replies(client: BiliClient, aid: int, *, mode: int = 2, offset: str = "",
                  ps: int = 20) -> dict:
    """取一页视频评论。返回 {items, cursor, count, page}。"""
    if aid <= 0:
        raise BiliError("aid 无效（先 bvid_to_aid）")
    params: dict[str, Any] = {"oid": aid, "type": 1, "mode": mode, "ps": ps}
    items: list[dict] = []
    cursor = ""
    total = 0
    used_wbi = False
    if offset:
        params["pagination_str"] = json.dumps({"offset": offset}, separators=(",", ":"))
    try:
        data = client.api("/x/v2/reply/wbi/main", params, wbi=True)
        used_wbi = True
    except BiliError as e:
        if e.code not in (-400, -403, -404, -412):
            raise
        plain = {"oid": aid, "type": 1, "mode": mode, "next": offset or 0, "ps": ps}
        data = client.api("/x/v2/reply/main", plain)
    replies = data.get("replies") or []
    up_mid = int((data.get("upper") or {}).get("mid") or 0)
    for r in replies:
        if isinstance(r, dict):
            items.append(_norm_reply(r, up_mid))
    total = int(((data.get("page") or {}).get("acount")) or (data.get("cursor") or {}).get("all_count") or 0)
    cur = data.get("cursor") or {}
    pag = (cur.get("pagination_reply") or {})
    cursor = str(pag.get("next") or cur.get("next") or "")
    return {"items": items, "cursor": cursor, "count": total,
            "mode": mode, "wbi": used_wbi}


def sub_replies(client: BiliClient, aid: int, root: int, *, pn: int = 1, ps: int = 20) -> dict:
    """楼中楼：某条评论下的回复。"""
    data = client.api("/x/v2/reply/reply",
                      {"type": 1, "oid": aid, "root": root, "ps": ps, "pn": pn})
    items = [_norm_reply(r) for r in (data.get("replies") or []) if isinstance(r, dict)]
    return {"items": items, "count": int(((data.get("page") or {}).get("count")) or 0)}


def dynamic_detail(client: BiliClient, dynamic_id: int) -> dict:
    data = client.api(f"https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/"
                      f"get_dynamic_detail?dynamic_id={dynamic_id}")
    card = (data.get("card") or {})
    desc = card.get("desc") or {}
    return {"rid": int(desc.get("rid") or 0),
            "type": int(desc.get("type") or 0),
            "name": str(desc.get("user_profile", {}).get("info", {}).get("uname")
                        or (data.get("cards") or [{}])[0].get("card", {}).get("name", ""))}


def dynamic_replies(client: BiliClient, dynamic_id: int, *, mode: int = 2, ps: int = 20) -> dict:
    """动态评论区（type=17）。"""
    dd = dynamic_detail(client, dynamic_id)
    if not dd["rid"]:
        raise BiliError(f"动态 {dynamic_id} 没有 rid（已删除或不是评论可用的动态）")
    data = client.api("/x/v2/reply/main",
                      {"type": 17, "oid": dd["rid"], "mode": mode, "ps": ps, "next": 0})
    items = [_norm_reply(r) for r in (data.get("replies") or []) if isinstance(r, dict)]
    return {"items": items, "count": int(((data.get("page") or {}).get("acount")) or 0),
            "dynamic_id": dynamic_id, "rid": dd["rid"]}


# ------------------------------------------------------------------ 本地分析
def _hit(text: str, words: tuple[str, ...]) -> int:
    return sum(1 for w in words if w in text)


def analyze(items: list[dict], up_mid: int = 0) -> dict:
    """评论的本地统计：量、情感、等级/VIP、时段、热评。不调模型，零成本。"""
    now = time.time()
    pos = neg = 0
    levels: Counter = Counter()
    hours: dict[str, int] = {}
    top: list[dict] = []
    mid_counts: Counter = Counter()
    up_in = 0
    for it in items:
        msg = it.get("message") or ""
        pos += _hit(msg, POS_WORDS)
        neg += _hit(msg, NEG_WORDS)
        levels[it.get("level") or 0] += 1
        mid_counts[it.get("mid") or 0] += 1
        if it.get("ctime"):
            hh = time.strftime("%H", time.localtime(it["ctime"]))
            hours[hh] = hours.get(hh, 0) + 1
        if it.get("is_up") or (up_mid and it.get("mid") == up_mid):
            up_in += 1
        top.append(it)
    top.sort(key=lambda x: (-(x.get("like") or 0), -(x.get("ctime") or 0)))
    return {
        "count": len(items),
        "unique_users": len({it.get("mid") for it in items if it.get("mid")}),
        "avg_like": round(sum(it.get("like") or 0 for it in items) / len(items), 2) if items else 0,
        "pos_hits": pos,
        "neg_hits": neg,
        "level": {str(k): v for k, v in sorted(levels.items())},
        "vip_users": sum(1 for it in items if it.get("vip")),
        "up_replies": up_in,
        "by_hour": dict(sorted(hours.items())),
        "top": [{k: it.get(k) for k in ("rpid", "uname", "message", "like", "level")} for it in top[:8]],
        "oldest_hours_ago": round((now - min([it["ctime"] for it in items if it.get("ctime")] or [now])) / 3600, 1),
    }


def brief(items: list[dict], limit: int = 40, max_chars: int = 900) -> str:
    """把评论拼成一段紧凑文本（给模型/笔记用）。"""
    lines = []
    for it in items[:limit]:
        msg = (it.get("message") or "").replace("\n", " ").strip()
        if not msg:
            continue
        lines.append(f"- {it.get('uname', '')}（L{it.get('level', 0)}，{it.get('like', 0)} 赞）：{msg}")
        if sum(len(x) for x in lines) > max_chars:
            break
    return "\n".join(lines)


def collect_video_comments(client: BiliClient, aid: int, *, pages: int = 1,
                           mode: int = 2, pause_s: float = 1.2) -> list[dict]:
    """连取几页评论（默认 1 页 20 条；够做「看评论」分析用）。"""
    out: list[dict] = []
    offset = ""
    for i in range(max(1, pages)):
        page = video_replies(client, aid, mode=mode, offset=offset, ps=20)
        out.extend(page["items"])
        offset = page["cursor"]
        if not page["items"] or not offset:
            break
        if i + 1 < pages:
            time.sleep(pause_s)
    return out
