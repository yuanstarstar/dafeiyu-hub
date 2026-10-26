# -*- coding: utf-8 -*-
"""直播相关接口：房间信息 / 直播列表（刷直播）/ 弹幕服务器 / 发弹幕。

读接口不需要登录；写接口（发弹幕）在 `check_write` 后面：
config.json 的 bili.allow_write 为 false 时一律拒绝（默认就是 false，对应「先不用」）。

接口口径参考大肥鱼直播包 livehub/bili.py（它的房间号/UID 两种查法踩过坑，这里照抄结论）：
- 按房间号：GET api.live.bilibili.com/room/v1/Room/get_info?room_id=
- 按用户 UID：GET api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=
- 直播列表：GET /xlive/web-interface/v1/second/getListByArea?platform=web&parent_area_id=&area_id=&sort_type=online&page=&page_size=
- 弹幕服务器：GET /xlive/web-room/v1/index/getDanmuInfo?id=<room_id>&type=0 → token + host_list
"""
from __future__ import annotations

import random
import time
from typing import Any, Optional

from .client import API_LIVE, BiliClient
from .errors import BiliError, NotLoggedIn, WriteBlocked

LIVE_STATUS = {0: "未开播", 1: "直播中", 2: "轮播中"}

# 直播分区（首页一级分区，随手能用的几个；空/0 表示全部）
AREA_PRESETS = {
    "0": 0, "推荐": 0, "全部": 0,
    "虚拟": 9, "虚拟主播": 9, "vtuber": 9,
    "网游": 2, "手游": 3, "单机": 6, "娱乐": 1, "电台": 5, "知识": 11, "生活": 10,
}


def _s(v: Any) -> str:
    return str(v or "")


def check_write(client: BiliClient) -> None:
    """写操作总闸：config.json bili.allow_write 为 true 才放行。"""
    if not bool((client.cfg or {}).get("allow_write")):
        raise WriteBlocked("写操作是关的（config.json 里 bili.allow_write=false）："
                           "确认要用时改成 true 再执行")


def _web_headers(room_id: int = 0) -> dict:
    h = {"Referer": "https://live.bilibili.com/", "Origin": "https://live.bilibili.com"}
    if room_id:
        h["Referer"] = f"https://live.bilibili.com/{room_id}"
    return h


# ------------------------------------------------------------------ 房间
def room(client: BiliClient, room_id: int = 0, mid: int = 0) -> dict:
    """直播间信息。room_id 与 mid 二选一；都传时以 room_id 为准。"""
    if room_id:
        data = client.api("/room/v1/Room/get_info", {"room_id": int(room_id)},
                          base=API_LIVE)
        rid = int(data.get("room_id") or room_id)
        return {
            "room_id": rid,
            "mid": int(data.get("uid") or 0),
            "live_status": int(data.get("live_status") or 0),
            "live_status_text": LIVE_STATUS.get(int(data.get("live_status") or 0), "未知"),
            "title": _s(data.get("title")),
            "area_name": _s(data.get("area_name")),
            "parent_area_name": _s(data.get("parent_area_name")),
            "online": int(data.get("online") or 0),
            "attention": int(data.get("attention") or 0),
            "url": f"https://live.bilibili.com/{rid}",
        }
    if not mid:
        mid = int(client.nav().get("mid") or 0)
    if not mid:
        raise BiliError("room() 需要 room_id 或 mid（没登录时查不到自己的 UID）")
    data = client.api("/room/v1/Room/getRoomInfoOld", {"mid": int(mid)}, base=API_LIVE)
    rid = int(data.get("roomid") or 0)
    return {
        "room_id": rid,
        "mid": int(mid),
        "live_status": int(data.get("liveStatus") or 0),
        "live_status_text": LIVE_STATUS.get(int(data.get("liveStatus") or 0), "未知"),
        "title": _s(data.get("title")),
        "area_name": _s(data.get("areaName")),
        "parent_area_name": _s(data.get("parentAreaName") or data.get("parentAreaName")),
        "online": int(data.get("online") or 0),
        "attention": int(data.get("attention") or 0),
        "url": _s(data.get("url")) or (f"https://live.bilibili.com/{rid}" if rid else ""),
    }


def rooms(client: BiliClient, room_ids: list[int]) -> list[dict]:
    """批量房间状态（逐个查；数量大时自己加 sleep，别把接口打急）。"""
    out = []
    for i, rid in enumerate(room_ids):
        try:
            out.append(room(client, room_id=rid))
        except BiliError as e:
            out.append({"room_id": rid, "error": str(e)})
        if i + 1 < len(room_ids):
            time.sleep(0.3)
    return out


# ------------------------------------------------------------------ 刷直播
def _norm_room(raw: dict) -> dict:
    rid = int(raw.get("roomid") or raw.get("room_id") or 0)
    ws = raw.get("watched_show")
    watched = _s(ws.get("text_small")) if isinstance(ws, dict) else ""
    return {
        "room_id": rid,
        "mid": int(raw.get("uid") or 0),
        "title": _s(raw.get("title")),
        "uname": _s(raw.get("uname")),
        "cover": _s(raw.get("cover") or raw.get("system_cover") or raw.get("user_cover")),
        "face": _s(raw.get("face")),
        "area_name": _s(raw.get("area_name") or raw.get("area_v2_name")),
        "parent_area_name": _s(raw.get("parent_area_name") or raw.get("area_v2_parent_name")
                               or raw.get("parentAreaName")),
        "parent_area_id": int(raw.get("area_v2_parent_id") or raw.get("parent_area_id") or 0),
        "area_id": int(raw.get("area_v2_id") or raw.get("area_id") or 0),
        "online": int(raw.get("online") or 0),
        "watched_show": watched,
        "live_status": int(raw.get("live_status") or 1),
        "url": f"https://live.bilibili.com/{rid}" if rid else "",
    }


def _pick_list(data: Any) -> list[dict]:
    """不同列表接口把数组塞在不同键里，这里统一捞出来。"""
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if not isinstance(data, dict):
        return []
    for key in ("list", "rooms", "recommend_room_list", "room_list", "data",
                "items", "result"):
        v = data.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v
        if isinstance(v, dict):
            inner = _pick_list(v)
            if inner:
                return inner
    return []


def list_by_area(client: BiliClient, area: str | int = 0, *, sort: str = "online",
                 page: int = 1, page_size: int = 30) -> list[dict]:
    """直播分区列表（刷直播）。area 可以给数字区号或 AREA_PRESETS 里的中文键。

    实测（2026-10）：getListByArea 不带 WBI 会被风控挡成 -352，必须 wbi=True；
    连 WBI 都被挡（同一 IP 请求太密）时，退到首页推荐流 getList 再按分区过滤。
    """
    area_id = int(AREA_PRESETS.get(str(area), area) or 0)
    try:
        data = client.api("/xlive/web-interface/v1/second/getListByArea",
                          {"platform": "web", "parent_area_id": area_id, "area_id": 0,
                           "sort_type": sort, "page": page,
                           "page_size": min(50, page_size)},
                          base=API_LIVE, headers=_web_headers(), wbi=True)
        rooms = [_norm_room(r) for r in _pick_list(data)
                 if int(r.get("roomid") or r.get("room_id") or 0)]
        if rooms:
            return rooms
    except BiliError as e:
        if getattr(e, "code", None) != -352:
            raise
    # 兜底：首页推荐流不需要 WBI（实测稳定），按一级分区客户端过滤
    home = list_home(client, page=page, page_size=max(30, min(50, page_size)))
    if area_id:
        picked = [r for r in home if r.get("parent_area_id") == area_id]
        if picked:
            return picked
    return home


def list_home(client: BiliClient, page: int = 1, page_size: int = 30) -> list[dict]:
    """直播首页推荐流（换个口味：看 B 站现在在推什么直播）。"""
    data = client.api("/xlive/web-interface/v1/index/getList",
                      {"platform": "web", "page": page, "page_size": page_size},
                      base=API_LIVE, headers=_web_headers())
    return [_norm_room(r) for r in _pick_list(data)]


def random_rooms(client: BiliClient, count: int = 10) -> list[dict]:
    """随机直播间：「随便看看」用。

    注意：官方的 getRandomLiveRooms 已经 404，这里改成从几个一级分区的列表里混起来随机挑，
    少则 1 次、多则 3 次请求（每段之间 0.3s，别把风控惹毛）。
    """
    areas = [0, 9, 1, 2, 3, 6, 10, 11, 5]
    random.shuffle(areas)
    pool: dict[int, dict] = {}
    for i, area in enumerate(areas[:3]):
        try:
            rooms = list_by_area(client, area=area, page=random.randint(1, 2),
                                 page_size=30)
        except BiliError:
            continue
        for r in rooms:
            pool.setdefault(r["room_id"], r)
        if len(pool) >= count * 4 or len(pool) >= 80:
            break
        if i + 1 < 3:
            time.sleep(0.3)
    picked = list(pool.values())
    random.shuffle(picked)
    return picked[:count]


def online_count(client: BiliClient, room_id: int, ruid: int = 0) -> dict:
    """直播间真实在线人数（getOnlineGoldRank 的 OnlineRankCount，不是页面人气值）。

    best-effort：接口要 ruid（主播 UID），没传就先查房间信息补上；
    对部分直播间不返回时 total=None，调用方自行降级。
    """
    if not ruid:
        try:
            ruid = int(room(client, room_id=room_id).get("mid") or 0)
        except BiliError:
            ruid = 0
    params = {"roomId": int(room_id), "ruid": int(ruid), "page": 1, "pageSize": 1}
    try:
        data = client.api("/xlive/general-interface/v1/rank/getOnlineGoldRank", params,
                          base=API_LIVE, headers=_web_headers(room_id), wbi=True)
    except BiliError as e:
        return {"total": None, "error": str(e), "room_id": room_id}
    total = data.get("OnlineRankCount")
    if total is None:
        items = data.get("OnlineRankItem") or []
        total = len(items)
    return {"total": int(total or 0), "room_id": room_id}


# ------------------------------------------------------------------ 弹幕
def danmaku_server(client: BiliClient, room_id: int) -> dict:
    """弹幕长连接的 host_list + token。

    实测（2026-10）：getDanmuInfo 与分区列表一样必须带 WBI 签名，裸参数一律 -352。
    """
    data = client.api("/xlive/web-room/v1/index/getDanmuInfo",
                      {"id": int(room_id), "type": 0, "web_location": 444.8},
                      base=API_LIVE, headers=_web_headers(room_id), wbi=True)
    hosts = data.get("host_list") or []
    norm = [{"host": _s(h.get("host")), "port": int(h.get("port") or 2243),
             "wss_port": int(h.get("wss_port") or 443)} for h in hosts if h.get("host")]
    return {"token": _s(data.get("token")), "hosts": norm,
            "room_id": int(room_id)}


def send_danmaku(client: BiliClient, room_id: int, text: str, *,
                 max_chars: int = 20) -> dict:
    """往直播间发一条弹幕（写操作，受 allow_write 闸控制）。

    参数照 livehub/bili.py 的实测写法：msg 截断 + rnd 时间戳 + csrf/csrf_token。
    B 站风控很紧：新账号/高频会被 412 或直接没反应，冷却与日限自己把握。
    """
    check_write(client)
    client.require_login()
    text = _s(text).strip()
    if not text:
        raise BiliError("弹幕内容为空")
    if int(room_id) <= 0:
        raise BiliError("room_id 无效")
    csrf = client.csrf
    data = {
        "bubble": "0", "msg": text[:max_chars], "color": "16777215", "mode": "1",
        "fontsize": "25", "rnd": str(int(time.time())), "roomid": str(int(room_id)),
        "csrf": csrf, "csrf_token": csrf,
    }
    body = client.api_post("/msg/send", data, base=API_LIVE,
                           headers=_web_headers(int(room_id)))
    return {"ok": True, "room_id": int(room_id), "text": text[:max_chars],
            "raw_code": body.get("code")}
