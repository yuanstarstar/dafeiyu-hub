# -*- coding: utf-8 -*-
"""大肥鱼（Dafeiyu）· B 站 Python 桥 —— 纯标准库，单文件，给 DSH 插件当「手指」。

宿主怎么用（一次性调用，不常驻）：

    python bili_bridge.py --cookie "D:/你的工作目录/live/data/bili_cookie.json" \
        '{"action":"whoami","args":{}}'

    最后一个 argv 是 JSON（action + args），输出**最后一行** UTF-8 JSON：
        {"ok":true,"action":"whoami","data":{...}}
        {"ok":false,"action":"whoami","error":"…","code":-101}

    --cookie 省略时的顺序：环境变量 FEIYU_COOKIE_FILE → 默认路径
    （D:/你的工作目录/live/data/bili_cookie.json）。

设计取舍
--------
1. **不重写 HTTP / WBI / 登录**：`sys.path` 挂上包内 `bridge/bili_api`，
   复用 `bili_api.BiliClient`（cookie 罐、buvid3 指纹、WBI 签名、-352 退避都在里面）。
   本文件只做「动作分发 + 字段裁剪 + 错误翻译」。
2. **读动作全部实测过**（见 README.md 的状态表），写动作只有参数校验和 dry-run，
   一次都没真发出去过。
3. **写动作默认 dryRun=true**：宿主必须显式传 `"dryRun": false` 才真的发请求。
   这是本桥的默认安全姿态，不是 B 站的行为。
4. 输出有硬预算（~12KB）：超了就按「最长的列表先砍一半」逐轮收缩，并在 data 里标
   `truncated: true`，绝不吐半截 JSON。

写操作闸门：本桥**不**复用 bili_api 的 `allow_write`（那个闸在 live/video 模块里），
而是自己统一判断 dryRun + 登录态 + csrf。所以别再把 allow_write=true 传给 bili_api。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import sys
import tempfile
import urllib.error
import urllib.request
import zlib
from pathlib import Path
from typing import Any, Callable, Optional

BRIDGE_VERSION = "1.0.0"
BRIDGE_FILE = Path(__file__).resolve()
BRIDGE_DIR = BRIDGE_FILE.parent

# ---------------------------------------------------------------- 复用既有资产
KIT_DIR = str(BRIDGE_DIR)
if KIT_DIR not in sys.path:
    sys.path.insert(0, KIT_DIR)

try:
    from bili_api import (  # noqa: E402
        BiliClient, BiliError, comments, live, load_cookie, video,
    )
except Exception as _imp_err:  # pragma: no cover - 只在运行时目录缺失时触发
    # 连 SDK 都 import 不了就没法干活：直接吐一行符合协议的 JSON，别抛堆栈。
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps({
        "ok": False, "action": "?",
        "error": f"加载 bili_api 失败（{KIT_DIR}）：{_imp_err}", "code": None,
    }, ensure_ascii=False))
    raise SystemExit(0)

DEFAULT_COOKIE = ""
ENV_COOKIE = "FEIYU_COOKIE_FILE"
MAX_JSON_BYTES = 12000          # 单次响应的硬预算（宿主侧日志/上下文都吃这个）
MAX_TEXT = 200                  # 列表里长文本的默认截断
MAX_SUBTITLE_CHARS = 1500       # 字幕正文截断
MAX_DESC_CHARS = 300            # 简介/签名截断

# B 站错误码 → 人话（-101/-352/-412 是日常三大坑）
CODE_HINTS = {
    -101: "未登录或登录态已失效：重新扫码登录（cookie 里的 SESSDATA 过期了）",
    -111: "csrf 校验失败（-111）：cookie 里缺 bili_jct 或它已失效，写操作必须先重新登录",
    -352: "触发风控（-352）：请求带上了但被判定可疑，隔几分钟再试；仍不行就换网络/IP",
    -400: "参数不对（-400）：检查 bvid/uid/roomId 这些是不是空的或格式错了",
    -403: "没有权限（-403）：接口要登录，或对方设置了隐私/需要很高等级",
    -404: "接口或资源不存在（-404）：视频/用户可能已被删除，或端点已下线",
    -412: "被风控拦截（-412）：请求太频繁，等 5~10 分钟再试",
    -509: "请求过于频繁（-509）：降低频率",
    -626: "账号状态异常（-626）：需要绑定手机/实名，或账号被限制",
    -799: "请求被限制（-799）：频率或参数问题",
    22001: "账号被封禁或该功能被限制（22001）",
    22013: "csrf 校验失败（22013）",
    62002: "该内容不可见（62002）：可能被删/仅粉丝可见",
    62004: "稿件正在审核中（62004）",
    62012: "仅 UP 主自己可见（62012）",
    87007: "投币失败（87007）：经验不足或已达上限",
    87008: "已经投过币了（87008）",
    10003: "分区/内容不存在（10003）",
}


class LocalError(Exception):
    """桥自己的参数/状态错误（不是 B 站返回的），code 为 None。"""


# ================================================================ 小工具
def _s(v: Any) -> str:
    return "" if v is None else str(v)


def _i(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _b(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return _s(v).strip().lower() in ("1", "true", "yes", "on")


def _clip(text: Any, n: int = MAX_TEXT) -> str:
    """单行化 + 截断（列表里的长文本都用它）。"""
    t = re.sub(r"\s+", " ", _s(text)).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def _clip_raw(text: Any, n: int = MAX_TEXT) -> str:
    """保留换行的截断（字幕正文用）。"""
    t = _s(text).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def _limit(args: dict, default: int = 10, cap: int = 50) -> int:
    n = _i(args.get("limit"), default)
    if n <= 0:
        n = default
    return max(1, min(int(n), cap))


def _need(args: dict, key: str) -> str:
    v = _s(args.get(key)).strip()
    if not v:
        raise LocalError(f"缺少参数 {key}")
    return v


def _need_int(args: dict, key: str) -> int:
    raw = _s(_need(args, key)).strip()
    try:
        return int(raw)
    except ValueError as e:
        raise LocalError(f"参数 {key} 必须是数字，收到 {raw!r}") from e


def _bvid(args: dict) -> str:
    """允许传 bvid 或整条链接，统一抠成 BV 号。"""
    return video.parse_bvid(_need(args, "bvid"))


def _mask(params: dict) -> dict:
    """dry-run 回显里把 csrf 打码（cookie 值一个都不许出境）。"""
    return {k: ("<bili_jct>" if k in ("csrf", "csrf_token") else v)
            for k, v in params.items()}


def _iso(ts: Any) -> str:
    """秒级时间戳 → 'YYYY-MM-DD HH:MM'（本地时区）。空/0 返回 ""。"""
    import time as _t
    t = _i(ts)
    if t <= 0:
        return ""
    try:
        return _t.strftime("%Y-%m-%d %H:%M", _t.localtime(t))
    except (OSError, ValueError):
        return ""


def _ago(ts: Any) -> str:
    """多久以前（比绝对时间更适合"最近投稿"这种场景）。"""
    import time as _t
    t = _i(ts)
    if t <= 0:
        return ""
    d = max(0, int(_t.time() - t))
    if d < 3600:
        return f"{d // 60}分钟前"
    if d < 86400:
        return f"{d // 3600}小时前"
    return f"{d // 86400}天前"


def _pct(v: Any) -> str:
    """播放量给人看的写法：1.2万 / 3.4亿。"""
    n = _i(v)
    if n >= 100000000:
        return f"{n / 100000000:.1f}亿"
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(n)


def _spread(items: list, limit: int) -> list:
    """从整段里等距抽 limit 条（弹幕这种成百上千条的，取头部只能看到开头几句）。"""
    n = len(items)
    if limit <= 0 or n <= limit:
        return list(items)
    step = n / float(limit)
    return [items[min(n - 1, int(i * step))] for i in range(limit)]


# ---------------------------------------------------------------- 输出预算裁剪
def _walk_dicts(node: Any):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk_dicts(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_dicts(v)


def _shrink_strings(node: Any, n: int) -> None:
    """最兜底的一步：把剩余长字符串全截到 n 字（n=0 时截到 40）。"""
    n = n or 40
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str) and len(v) > n:
                node[k] = v[: n - 1] + "…"
            else:
                _shrink_strings(v, n)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, str) and len(v) > n:
                node[i] = v[: n - 1] + "…"
            else:
                _shrink_strings(v, n)


def _fit(data: Any, action: str) -> Any:
    """把整个响应压进 MAX_JSON_BYTES：先砍最长的列表，再截字符串。"""
    def size(obj: Any) -> int:
        return len(json.dumps({"ok": True, "action": action, "data": obj},
                              ensure_ascii=False).encode("utf-8"))

    trimmed = False
    for _ in range(40):
        if size(data) <= MAX_JSON_BYTES:
            break
        holder = key = None
        best = 1
        for d in _walk_dicts(data):
            for k, v in d.items():
                if isinstance(v, list) and len(v) > best:
                    holder, key, best = d, k, len(v)
        if holder is None:
            break
        keep = max(1, int(best * 0.6))
        holder[key] = holder[key][:keep]
        trimmed = True
    if size(data) > MAX_JSON_BYTES:
        for cap in (120, 60):
            _shrink_strings(data, cap)
            if size(data) <= MAX_JSON_BYTES:
                break
    if trimmed and isinstance(data, dict):
        data["truncated"] = True
    return data


# ================================================================ 上下文
def _prefer_ipv4() -> None:
    """让所有 HTTP 连接只走 IPv4（这台机器上 IPv6 能解析但连不通）。

    实测（2026-10-25，同一台机器、同一个 cookie）：不打这个补丁时，每一次**新建
    连接**都要先试 AAAA 记录、卡满超时（20s）才回落 IPv4；打上之后所有接口
    0.1~0.3s 就回来了。api.bilibili.com 的 AAAA 记录（240e:…）在这里纯属拖累。

    只动本进程的解析结果，不改任何既有文件；需要 IPv6 时用 --ipv6 关掉。
    """
    orig = socket.getaddrinfo

    def v4_first(*args: Any, **kwargs: Any):
        res = orig(*args, **kwargs)
        v4 = [x for x in res if x[0] == socket.AF_INET]
        return v4 or res          # 一个 IPv4 都没有（纯 v6 域名）就照旧

    socket.getaddrinfo = v4_first  # type: ignore[assignment]


class Ctx:
    def __init__(self, cookie: Optional[str], timeout: float, data_dir: Optional[str]):
        self.data_dir = self._pick_data_dir(data_dir)
        cfg: dict = {"timeout_s": float(timeout or 20.0), "allow_write": False}
        self.cookie_path, self.cookie_explicit = self._resolve_cookie(cookie)
        if self.cookie_path and Path(self.cookie_path).exists():
            cfg["cookie_file"] = self.cookie_path
        self.client = BiliClient(cfg=cfg, data_dir=self.data_dir)
        info = load_cookie(self.client, cfg)
        self.cookie_info = info
        self.cookie_source = _s(info.get("source")) or self.cookie_path or ""
        # bili_api 会把来源写成 "config: D:\\…json" / "env: …"，给人看的版本去掉前缀
        self.cookie_display = re.sub(r"^(config|env|file|candidate|default)\s*:\s*",
                                     "", self.cookie_source, flags=re.I).strip()
        self.cookie_count = _i(info.get("count"))
        self.has_sessdata = bool(info.get("has_sessdata"))
        self.has_jct = bool(info.get("has_jct"))
        self.cfg = cfg

    # ---- 目录 / cookie 解析
    @staticmethod
    def _pick_data_dir(explicit: Optional[str]) -> Path:
        cands = [Path(explicit)] if explicit else []
        cands.append(BRIDGE_DIR / ".data")
        cands.append(Path(tempfile.gettempdir()) / "dafeiyu-bridge")
        for p in cands:
            try:
                p.mkdir(parents=True, exist_ok=True)
                probe = p / ".w"
                probe.write_text("ok", encoding="utf-8")
                probe.unlink(missing_ok=True)
                return p
            except OSError:
                continue
        return Path(tempfile.gettempdir())

    @staticmethod
    def _resolve_cookie(cookie: Optional[str]) -> tuple[str, bool]:
        if cookie:
            return cookie, True
        env = os.environ.get(ENV_COOKIE, "").strip()
        if env:
            return env, True
        return DEFAULT_COOKIE, False

    # ---- 便利
    def self_uid_local(self) -> int:
        """只从 cookie 里抠 UID（零请求）；抠不到回 0。dry-run 用这个。"""
        for k in ("DedeUserID", "dedeuserid", "uid"):
            v = _s((self.client.cookie_pairs or {}).get(k)).strip()
            if v.isdigit():
                return int(v)
        return 0

    def self_uid(self) -> int:
        """当前登录 UID：先用 cookie 里的 DedeUserID（零请求），不行再问 nav。"""
        uid = self.self_uid_local()
        if uid:
            return uid
        try:
            return _i(self.client.nav().get("mid"))
        except BiliError:
            return 0

    def require_login(self) -> None:
        if not self.has_sessdata:
            raise LocalError("未登录：cookie 里没有 SESSDATA（用 --cookie 指到一个有效的 "
                             "bili_cookie.json，或先扫码登录）")

    def require_csrf(self) -> None:
        self.require_login()
        if not self.client.csrf:
            raise LocalError("cookie 里没有 bili_jct：写操作需要它（重新扫码登录）")

    def raw_get(self, url: str, referer: str = "https://www.bilibili.com/",
                timeout: Optional[float] = None) -> tuple[bytes, dict]:
        """拿原始字节（弹幕 XML 是 deflate 压缩的，走 get_json 会被解成乱码）。

        复用 BiliClient 的 opener（同一个 cookie 罐），不另起会话。
        """
        self.client.ensure_buvid()
        headers = {
            "User-Agent": self.cfg.get("user_agent")
            or ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            "Referer": referer,
            "Accept": "*/*",
        }
        opener = getattr(self.client, "_opener", None)
        req = urllib.request.Request(url, headers=headers)
        try:
            if opener is not None:
                with opener.open(req, timeout=timeout or self.client.timeout) as r:
                    return r.read(), dict(r.headers)
            # 兜底：自己带 Cookie 头（正常走不到）
            jar = "; ".join(f"{k}={v}" for k, v in (self.client.cookie_pairs or {}).items())
            if jar:
                req.add_header("Cookie", jar)
            with urllib.request.urlopen(req, timeout=timeout or self.client.timeout) as r:
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode("utf-8", "replace")
            raise BiliError(f"HTTP {e.code}：{url.split('?')[0]}：{body}", code=e.code) from e
        except urllib.error.URLError as e:
            raise BiliError(f"网络错误：{e.reason}（{url.split('?')[0]}）") from e
        except TimeoutError as e:
            raise BiliError(f"请求超时：{url.split('?')[0]}") from e


def _image_file(value: str) -> Path:
    """校验图片路径；只做本地检查，图片大小按 B 站上限留余量。"""
    raw = _s(value).strip()
    if not raw:
        raise LocalError("缺少参数 pic（图片路径或素材 id）")
    path = Path(raw).expanduser()
    if not path.is_file():
        raise LocalError(f"图片不存在：{path}")
    if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
        raise LocalError("图片格式只支持 png/jpg/jpeg/webp/gif/bmp")
    if path.stat().st_size > 20 * 1024 * 1024:
        raise LocalError("图片超过 20MB，B 站可能拒收")
    return path.resolve()


def _bili_api_credential(c: Ctx):
    """图片评论/私信走 bilibili_api 的上传；只有 venv 里有它时才可用。"""
    try:
        from bilibili_api import Credential
    except Exception as exc:  # noqa: BLE001
        raise LocalError(
            "图片上传需要 bilibili_api（安装在 bili-duty/.venv）。"
            f"当前 Python 没有：{exc}"
        ) from exc
    try:
        c.client.ensure_buvid()
    except Exception:
        pass
    pairs = {str(k).lower(): str(v) for k, v in (c.client.cookie_pairs or {}).items()}

    def pick(name: str) -> str:
        return pairs.get(name.lower(), "")

    return Credential(
        sessdata=pick("SESSDATA"),
        bili_jct=pick("bili_jct"),
        buvid3=pick("buvid3"),
        buvid4=pick("buvid4"),
        dedeuserid=pick("DedeUserID"),
        ac_time_value=pick("ac_time_value"),
    )


def _maybe_inflate(raw: bytes) -> bytes:
    """B 站的 dm/list.so 固定 deflate；兜住 gzip / 未压缩三种情况。"""
    if not raw:
        return raw
    if raw[:1] == b"<" or raw[:5].lower() == b"<?xml":
        return raw
    for wbits in (15, -15, 31):
        try:
            out = zlib.decompress(raw, wbits)
            if out[:1] == b"<":
                return out
        except zlib.error:
            continue
    return raw


# ================================================================ 读动作
def act_ping(c: Ctx, a: dict) -> dict:
    """纯本地自检：不发网络请求（宿主拿它探活/探路径）。"""
    return {
        "version": BRIDGE_VERSION,
        "python": sys.version.split()[0],
        "cookie_path": c.cookie_display,
        "cookieExists": Path(c.cookie_path).exists() if c.cookie_path else False,
        "cookieFields": c.cookie_count,
        "loggedIn": c.has_sessdata,
        "hasJct": c.has_jct,
        "sdkPath": KIT_DIR,
        "dataDir": str(c.data_dir),
        "ipv4Only": socket.getaddrinfo.__name__ == "v4_first",
        "writeDefault": "dryRun",
        "actions": len(ACTIONS),
    }


def act_whoami(c: Ctx, a: dict) -> dict:
    nav = c.client.nav()
    return {
        "isLogin": bool(nav.get("isLogin")),
        "uname": _s(nav.get("uname")),
        "mid": _i(nav.get("mid")),
        "vip": _i(nav.get("vip")),
        "vipText": "大会员" if _i(nav.get("vip")) else "普通用户",
        "cookieSource": re.sub(r"^(config|env|file|candidate|default)\s*:\s*", "",
                               c.cookie_source or ""),
        "cookiePath": c.cookie_display,
        "cookieFields": c.cookie_count,
        "hasSessData": c.has_sessdata,
        "hasJct": c.has_jct,
    }


def _video_item(raw: dict) -> dict:
    """搜索结果 / 热门 / 排行 / 每周必看 里的视频条目，统一裁成一套字段。"""
    stat = raw.get("stat") or {}
    owner = raw.get("owner") or {}
    bv = _s(raw.get("bvid"))
    return {
        "bvid": bv,
        "title": _clip(_html_text(raw.get("title")), 120),
        "author": _clip(raw.get("author") or owner.get("name"), 40),
        "play": _i(raw.get("play") if raw.get("play") is not None else stat.get("view")),
        "danmaku": _i(raw.get("video_review") if raw.get("video_review") is not None
                      else stat.get("danmaku")),
        "duration": _s(raw.get("duration")),
        "pubdate": _iso(raw.get("pubdate") or raw.get("ctime")),
        "desc": _clip(raw.get("description") or raw.get("desc"), 120),
    }


def _html_text(v: Any) -> str:
    """搜索结果标题带 <em class="keyword"> 高亮标签，去掉。"""
    import html as _h
    t = _h.unescape(_s(v))
    return re.sub(r"<[^>]+>", "", t)


def act_search(c: Ctx, a: dict) -> dict:
    kw = _need(a, "keyword")
    limit = _limit(a, 10, 50)
    order = _s(a.get("order") or "totalrank").strip()
    params = {"search_type": "video", "keyword": kw, "page": _i(a.get("page"), 1),
              "order": order}
    try:
        data = c.client.api("/x/web-interface/wbi/search/type", params, wbi=True)
    except BiliError as e:
        if getattr(e, "code", None) not in (-352, -412, -403):
            raise
        # 风控/未登录时退到老的 search/type
        data = c.client.api("/x/web-interface/search/type",
                            {"search_type": "video", "keyword": kw,
                             "page": params["page"]})
    items = [x for x in (data.get("result") or []) if isinstance(x, dict)]
    videos = [_video_item(x) for x in items[:limit]]
    return {"keyword": kw, "order": order, "total": _i(data.get("numResults")),
            "count": len(videos), "videos": videos}


def act_video_info(c: Ctx, a: dict) -> dict:
    meta = video.view(c.client, _bvid(a))
    stat = meta["stat"]
    return {
        "bvid": meta["bvid"],
        "aid": meta["aid"],
        "cid": meta["cid"],
        "title": _clip(meta["title"], 160),
        "up": {"mid": meta["owner"]["mid"], "name": meta["owner"]["name"]},
        "duration": meta["duration"],
        "durationText": f"{meta['duration'] // 60}:{meta['duration'] % 60:02d}",
        "pubdate": _iso(meta["pubdate"]),
        "desc": _clip_raw(meta["desc"], MAX_DESC_CHARS),
        "stat": {
            "view": stat["view"], "viewText": _pct(stat["view"]),
            "like": stat["like"], "coin": stat["coin"],
            "favorite": stat["favorite"], "reply": stat["reply"],
            "danmaku": stat["danmaku"], "share": _i(stat.get("share")),
        },
        "url": meta["url"],
    }


def act_video_comments(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    limit = _limit(a, 20, 60)
    meta = video.view(c.client, bv)
    aid = meta["aid"]
    items: list[dict] = []
    total = 0
    offset = ""
    for page in range(3):
        got = comments.video_replies(c.client, aid, mode=2, offset=offset, ps=20)
        if page == 0:
            total = _i(got.get("count"))
        items.extend(got["items"])
        offset = got.get("cursor") or ""
        if len(items) >= limit or not offset or not got["items"]:
            break
        if page < 2:
            import time as _t
            _t.sleep(0.4)
    out = []
    for it in items[:limit]:
        out.append({
            "rpid": _i(it.get("rpid")),
            "root": _i(it.get("root")),
            "uid": _i(it.get("mid")),
            "uname": _clip(it.get("uname"), 40),
            "content": _clip(it.get("message"), 180),
            "like": _i(it.get("like")),
            "replies": _i(it.get("rcount")),
            "level": _i(it.get("level")),
            "isUp": bool(it.get("is_up")),
            "time": _iso(it.get("ctime")),
        })
    return {"bvid": meta["bvid"], "title": _clip(meta["title"], 100),
            "total": total, "count": len(out), "comments": out}


_DM_RE = re.compile(r'<d p="([^"]*)"[^>]*>([^<]*)</d>')


def act_video_danmaku(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    limit = _limit(a, 50, 200)
    meta = video.view(c.client, bv)
    cid = meta["cid"]
    if not cid:
        raise LocalError(f"{meta['bvid']} 拿不到 cid（可能已失效）")
    url = f"https://api.bilibili.com/x/v1/dm/list.so?oid={cid}"
    raw, _hdr = c.raw_get(url, referer=f"https://www.bilibili.com/video/{bv}/")
    xml = _maybe_inflate(raw).decode("utf-8", "replace")
    rows = []
    for p, text in _DM_RE.findall(xml):
        parts = p.split(",")
        t = 0.0
        try:
            t = round(float(parts[0]), 1)
        except (ValueError, IndexError):
            t = 0.0
        txt = text.strip()
        if txt:
            rows.append({"t": t, "text": _clip(txt, 80)})
    rows.sort(key=lambda x: x["t"])
    total = len(rows)
    mode = _s(a.get("mode") or "spread").lower()
    dropped = 0
    # 0s 那批多半是 B 站反诈/引流弹幕集中刷的（实测某视频 1200 条里 86 条 t=0），
    # 全按时间取前 N 条就只剩它们了，所以先剔掉，剩下的还够就不补回来。
    if mode != "head":
        kept = [r for r in rows if r["t"] > 0]
        if len(kept) >= min(limit, 10):
            dropped = total - len(kept)
            rows = kept
    picked = rows[:limit] if mode == "head" else _spread(rows, limit)
    return {"bvid": meta["bvid"], "cid": cid, "total": total,
            "count": len(picked), "sampled": mode, "droppedZero": dropped,
            "danmaku": picked}


def act_video_subtitle(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    meta = video.view(c.client, bv)
    cid = meta["cid"]
    if not cid:
        raise LocalError(f"{meta['bvid']} 拿不到 cid")
    data = c.client.api("/x/player/wbi/v2", {"bvid": meta["bvid"], "cid": cid}, wbi=True)
    sub = data.get("subtitle") or {}
    subs = [s for s in (sub.get("subtitles") or []) if isinstance(s, dict)]
    seen, langs = set(), []
    for s in subs:
        lan = _s(s.get("lan"))
        if lan and lan not in seen:
            seen.add(lan)
            langs.append({"lan": lan, "name": _s(s.get("lan_doc")),
                          "isAI": _i(s.get("ai_status")) > 0 or lan.startswith("ai-")})
    if not subs:
        return {"bvid": meta["bvid"], "cid": cid, "languages": [], "text": "",
                "note": "该视频没有字幕（AI 字幕也没生成）；不是错误，只是没内容"}
    pick = None
    for want in ("ai-zh", "zh-CN", "zh-Hans", "zh"):
        pick = next((s for s in subs if _s(s.get("lan")) == want), None)
        if pick:
            break
    pick = pick or subs[0]
    sub_url = _s(pick.get("subtitle_url"))
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    if not sub_url:
        raise BiliError("字幕条目没有 subtitle_url（接口变了或该字幕要更高权限）")
    body = c.client.get_json(sub_url, headers={"Referer": f"https://www.bilibili.com/video/{bv}/"})
    segs = [x.get("content") for x in (body.get("body") or []) if isinstance(x, dict)]
    text = "\n".join(_s(x).strip() for x in segs if _s(x).strip())
    return {"bvid": meta["bvid"], "cid": cid, "languages": langs[:8],
            "language": _s(pick.get("lan_doc")), "segments": len(segs),
            "text": _clip_raw(text, MAX_SUBTITLE_CHARS)}


def act_user_info(c: Ctx, a: dict) -> dict:
    uid = _i(a.get("uid")) or c.self_uid()
    if not uid:
        raise LocalError("缺少参数 uid（也没登录，推不出自己的 UID）")
    info = c.client.api("/x/space/wbi/acc/info", {"mid": uid}, wbi=True)
    stat: dict = {}
    err = ""
    try:
        stat = c.client.api("/x/relation/stat", {"vmid": uid}) or {}
    except BiliError as e:
        err = f"粉丝数没拿到：{e}"
    return {
        "uid": uid,
        "name": _clip(info.get("name"), 40),
        "level": _i(info.get("level")),
        "fans": _i(stat.get("follower")),
        "following": _i(stat.get("following")),
        "sign": _clip(info.get("sign"), MAX_DESC_CHARS),
        "vip": _i((info.get("vip") or {}).get("status")),
        "official": _clip((info.get("official") or {}).get("title"), 60),
        **({"note": err} if err else {}),
    }


def act_user_videos(c: Ctx, a: dict) -> dict:
    uid = _i(a.get("uid")) or c.self_uid()
    if not uid:
        raise LocalError("缺少参数 uid")
    limit = _limit(a, 10, 30)
    order = _s(a.get("order") or "pubdate")
    data = c.client.api("/x/space/wbi/arc/search",
                        {"mid": uid, "ps": limit, "pn": _i(a.get("page"), 1),
                         "order": order}, wbi=True)
    lst = data.get("list") or {}
    videos = []
    for x in (lst.get("vlist") or [])[:limit]:
        if not isinstance(x, dict):
            continue
        videos.append({
            "bvid": _s(x.get("bvid")),
            "title": _clip(x.get("title"), 100),
            "play": _i(x.get("play")),
            "danmaku": _i(x.get("video_review")),
            "comment": _i(x.get("comment")),
            "length": _s(x.get("length")),
            "created": _iso(x.get("created")),
            "ago": _ago(x.get("created")),
            "desc": _clip(x.get("description"), 100),
        })
    return {"uid": uid, "total": _i((data.get("page") or {}).get("count")),
            "order": order, "count": len(videos), "videos": videos}


_MAJOR_LABEL = {
    "MAJOR_TYPE_ARCHIVE": "视频",
    "MAJOR_TYPE_OPUS": "图文",
    "MAJOR_TYPE_ARTICLE": "专栏",
    "MAJOR_TYPE_DRAW": "图片",
    "MAJOR_TYPE_LIVE_RCMD": "直播",
    "MAJOR_TYPE_PGC": "番剧",
    "MAJOR_TYPE_COURSES": "课程",
    "MAJOR_TYPE_MUSIC": "音乐",
    "MAJOR_TYPE_COMMON": "通用",
    "MAJOR_TYPE_NONE": "纯文字",
}


def _dyn_text(md: dict) -> str:
    """动态正文：纯文字在 desc.text，其余类型在 major.* 里。"""
    desc = _s((md.get("desc") or {}).get("text")).strip()
    if desc:
        return desc
    major = md.get("major") or {}
    mt = _s(major.get("type"))
    if mt in ("MAJOR_TYPE_ARCHIVE", "MAJOR_TYPE_UGC_SEASON"):
        return _s((major.get("archive") or {}).get("title"))
    if mt == "MAJOR_TYPE_OPUS":
        op = major.get("opus") or {}
        return _s((op.get("summary") or {}).get("text")) or _s(op.get("title"))
    if mt == "MAJOR_TYPE_ARTICLE":
        art = major.get("article") or {}
        return _s(art.get("title")) or " ".join(
            _s(x.get("text")) for x in (art.get("desc") or []) if isinstance(x, dict))
    if mt == "MAJOR_TYPE_DRAW":
        items = (major.get("draw") or {}).get("items") or []
        return f"[图文动态：{len(items)} 张图]"
    if mt == "MAJOR_TYPE_LIVE_RCMD":
        return "[直播推荐] " + _s((major.get("live_rcmd") or {}).get("title"))
    if mt == "MAJOR_TYPE_PGC":
        return _s((major.get("pgc") or {}).get("title"))
    if mt == "MAJOR_TYPE_COMMON":
        cm = major.get("common") or {}
        return _s((cm.get("desc") or {}).get("text")) or _s(cm.get("title"))
    return ""


def act_user_dynamics(c: Ctx, a: dict) -> dict:
    uid = _i(a.get("uid")) or c.self_uid()
    if not uid:
        raise LocalError("缺少参数 uid")
    limit = _limit(a, 10, 30)
    params = {"host_mid": uid, "offset": _s(a.get("offset") or ""),
              "features": "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote"}
    data: dict = {}
    last_err: Optional[BiliError] = None
    for attempt in ({"wbi": True}, {"wbi": False}):
        try:
            data = c.client.api("/x/polymer/web-dynamic/v1/feed/space",
                                {k: v for k, v in params.items() if v},
                                wbi=attempt["wbi"])
            break
        except BiliError as e:
            last_err = e
            data = {}
    if not data and last_err:
        raise last_err
    out = []
    for it in (data.get("items") or [])[:limit]:
        if not isinstance(it, dict):
            continue
        mods = it.get("modules") or {}
        author = mods.get("module_author") or {}
        md = mods.get("module_dynamic") or {}
        type_code = _s(it.get("type")).replace("DYNAMIC_TYPE_", "")
        did = _s(it.get("id_str") or (it.get("basic") or {}).get("comment_id_str"))
        out.append({
            "id": did,
            "type": type_code,
            "kind": _MAJOR_LABEL.get(_s((md.get("major") or {}).get("type")), ""),
            "author": _clip(author.get("name"), 40),
            "text": _clip(_dyn_text(md) or author.get("pub_action"), 200),
            "time": _iso(author.get("pub_ts")),
            "ago": _ago(author.get("pub_ts")),
            "url": f"https://t.bilibili.com/{did}" if did else "",
        })
    return {"uid": uid, "count": len(out), "hasMore": bool(data.get("has_more")),
            "offset": _s(data.get("offset")), "dynamics": out}


def act_following(c: Ctx, a: dict) -> dict:
    uid = _i(a.get("uid")) or c.self_uid()
    if not uid:
        raise LocalError("缺少参数 uid（也没登录，推不出自己的 UID）")
    limit = _limit(a, 20, 50)
    data = c.client.api("/x/relation/followings",
                        {"vmid": uid, "pn": _i(a.get("page"), 1), "ps": limit,
                         "order": _s(a.get("order") or "desc"),
                         "order_type": _s(a.get("orderType") or "attention")})
    out = []
    for x in (data.get("list") or [])[:limit]:
        if not isinstance(x, dict):
            continue
        out.append({"uid": _i(x.get("mid")), "name": _clip(x.get("uname"), 40),
                    "sign": _clip(x.get("sign"), 80),
                    "vip": _i((x.get("vip") or {}).get("vipStatus"))})
    return {"uid": uid, "total": _i(data.get("total")) or len(out),
            "count": len(out), "following": out}


def act_favorites(c: Ctx, a: dict) -> dict:
    uid = _i(a.get("uid")) or c.self_uid()
    if not uid:
        raise LocalError("缺少参数 uid")
    data = c.client.api("/x/v3/fav/folder/created/list-all", {"up_mid": uid})
    out = []
    for x in (data.get("list") or []):
        if not isinstance(x, dict):
            continue
        out.append({"mediaId": _i(x.get("id")), "title": _clip(x.get("title"), 40),
                    "count": _i(x.get("media_count"))})
    return {"uid": uid, "count": len(out), "folders": out}


def act_favorite_content(c: Ctx, a: dict) -> dict:
    media = _i(a.get("mediaId") or a.get("media_id"))
    if not media:
        raise LocalError("缺少参数 mediaId（先调 favorites 拿）")
    limit = _limit(a, 10, 50)
    first = _i(a.get("page"), 1)
    # 这个接口 ps 上限 40（实测 50 直接 -400）。注意 **页码偏移是按 ps 算的**，
    # 翻页时 ps 一变就会重叠（实测 ps=20 翻到第三页改 ps=11，结果重复了 17 条），
    # 所以每页固定 ps=20、最多翻 3 页，最后再按 limit 截断。
    medias: list[dict] = []
    seen: set = set()
    info: dict = {}
    has_more = False
    for i in range(3):
        if len(medias) >= limit:
            break
        data = c.client.api("/x/v3/fav/resource/list",
                            {"media_id": media, "pn": first + i, "ps": 20,
                             "platform": "web"})
        if not info:
            info = data.get("info") or {}
        added = 0
        for x in (data.get("medias") or []):
            if not isinstance(x, dict):
                continue
            key = _s(x.get("bvid")) or str(_i(x.get("id")))
            if key in seen:
                continue
            seen.add(key)
            medias.append(x)
            added += 1
        has_more = bool(data.get("has_more"))
        if not added or not has_more:
            break
    out = []
    for x in medias[:limit]:
        cnt = x.get("cnt_info") or {}
        out.append({"bvid": _s(x.get("bvid")),
                    "title": _clip(x.get("title"), 100),
                    "author": _clip((x.get("upper") or {}).get("name"), 40),
                    "play": _i(cnt.get("play")),
                    "duration": _i(x.get("duration")) or _i(x.get("page")),
                    "favTime": _iso(x.get("fav_time"))})
    return {"mediaId": media, "title": _clip(info.get("title"), 40),
            "total": _i(info.get("media_count")), "hasMore": has_more,
            "count": len(out), "medias": out}


def act_home_feed(c: Ctx, a: dict) -> dict:
    """登录态下的个性化首页推荐；这是大肥鱼平时“刷B站”的主入口。"""
    limit = _limit(a, 10, 20)
    params = {
        "ps": max(limit, 12),
        "fresh_type": _i(a.get("freshType") or a.get("fresh_type"), 3),
        "feed_version": "V8",
        "homepage_ver": 1,
    }
    data = c.client.api("/x/web-interface/wbi/index/top/feed/rcmd", params, wbi=True)
    videos = []
    for raw in (data.get("item") or [])[:limit]:
        if not isinstance(raw, dict) or not _s(raw.get("bvid")):
            continue
        item = _video_item(raw)
        item["cover"] = _s(raw.get("pic"))
        item["url"] = _s(raw.get("uri")) or f"https://www.bilibili.com/video/{item['bvid']}"
        item["goto"] = _s(raw.get("goto"))
        reason = raw.get("rcmd_reason")
        if isinstance(reason, dict):
            reason = reason.get("content") or reason.get("reason") or ""
        item["reason"] = _clip(reason, 60)
        videos.append(item)
    return {"count": len(videos), "videos": videos}


def act_hot(c: Ctx, a: dict) -> dict:
    limit = _limit(a, 10, 20)
    data = c.client.api("/x/web-interface/popular",
                        {"pn": _i(a.get("page"), 1), "ps": max(limit, 20)})
    videos = [_video_item(x) for x in (data.get("list") or [])[:limit]
              if isinstance(x, dict)]
    return {"count": len(videos), "videos": videos}


def act_rank(c: Ctx, a: dict) -> dict:
    limit = _limit(a, 10, 20)
    data = c.client.api("/x/web-interface/ranking/v2",
                        {"rid": _i(a.get("rid"), 0), "type": _s(a.get("type") or "all")})
    videos = [_video_item(x) for x in (data.get("list") or [])[:limit]
              if isinstance(x, dict)]
    return {"note": _clip(data.get("note"), 80), "count": len(videos), "videos": videos}


def act_weekly(c: Ctx, a: dict) -> dict:
    limit = _limit(a, 10, 20)
    number = _i(a.get("number"))
    subject, name = "", ""
    if not number:
        lst = c.client.api("/x/web-interface/popular/series/list", {})
        series = [x for x in (lst.get("list") or []) if isinstance(x, dict)]
        if not series:
            raise BiliError("每周必看列表为空（接口没返回期号）")
        number = _i(series[0].get("number"))
        subject = _s(series[0].get("subject"))
        name = _s(series[0].get("name"))
    data = c.client.api("/x/web-interface/popular/series/one", {"number": number})
    cfg = data.get("config") or {}
    videos = [_video_item(x) for x in (data.get("list") or [])[:limit]
              if isinstance(x, dict)]
    return {"number": number,
            "subject": _clip(cfg.get("subject") or subject, 60),
            "name": _clip(cfg.get("name") or name, 60),
            "count": len(videos), "videos": videos}


def act_live_room(c: Ctx, a: dict) -> dict:
    rid = _i(a.get("roomId") or a.get("room_id"))
    mid = _i(a.get("mid") or a.get("uid"))
    if not rid and not mid:
        mid = c.self_uid()
        if not mid:
            raise LocalError("缺少参数 roomId 或 mid")
    info = live.room(c.client, room_id=rid, mid=mid)
    return {
        "roomId": info["room_id"], "mid": info["mid"],
        "live": info["live_status"], "liveText": info["live_status_text"],
        "title": _clip(info["title"], 80),
        "area": _s(info.get("area_name")),
        "parentArea": _s(info.get("parent_area_name")),
        "online": _i(info.get("online")),
        "followers": _i(info.get("attention")),
        "url": info["url"],
    }


_LIVE_BASE = getattr(live, "API_LIVE", "https://api.live.bilibili.com")
_LIVE_SORTS = ("online", "live_time")


def _area_room(x: dict) -> dict:
    """`/room/v1/area/getRoomList` 的裸条目 → 统一形状。"""
    rid = _i(x.get("roomid"))
    return {"roomId": rid, "mid": _i(x.get("uid")),
            "title": _clip(x.get("title"), 60), "uname": _clip(x.get("uname"), 40),
            "area": _s(x.get("area_v2_name") or x.get("area_name")),
            "parent_area_id": _i(x.get("area_v2_parent_id") or x.get("parent_id")),
            "parent_area_name": _s(x.get("area_v2_parent_name") or x.get("parent_name")),
            "online": _i(x.get("online")),
            "url": f"https://live.bilibili.com/{rid}" if rid else ""}


def _sdk_room(r: dict) -> dict:
    """`live.list_by_area` 的条目 → 统一形状（备胎路径用）。"""
    return {"roomId": _i(r.get("room_id")), "mid": _i(r.get("mid")),
            "title": _clip(r.get("title"), 60), "uname": _clip(r.get("uname"), 40),
            "area": _s(r.get("area_name")), "parent_area_id": _i(r.get("parent_area_id")),
            "parent_area_name": _s(r.get("parent_area_name")),
            "online": _i(r.get("online")), "url": _s(r.get("url"))}


def act_live_roam(c: Ctx, a: dict) -> dict:
    area = a.get("area") if a.get("area") is not None else "虚拟"
    limit = _limit(a, 10, 30)
    sort = _s(a.get("sort") or "online")
    if sort not in _LIVE_SORTS:
        sort = "online"
    page = _i(a.get("page"), 1)
    note = ""
    import time as _t

    # area 可以是中文（虚拟/网游…）或数字区号；换成 id 和名字，两个都拿来做匹配
    try:
        area_id = int(live.AREA_PRESETS.get(str(area), area) or 0)
    except (TypeError, ValueError):
        raise LocalError(f"area 不认识：{area!r}（中文分区名或数字区号，见 live.AREA_PRESETS）")
    area_name = ""
    for k, v in live.AREA_PRESETS.items():
        if v == area_id and not k.isdigit():
            area_name = k
            break

    rooms = []
    src = "area/getRoomList"
    # 主路径：/room/v1/area/getRoomList —— 一级分区直接给房间（实测 30 个/页、0.2s）。
    # 注意：second/getListByArea 对该账号恒回空列表，second/getList 恒 -352，
    # SDK 的 list_by_area 兜底是「筛不到就原样返回首页全量」，所以只能当备胎。
    for pn in range(page, page + 3):
        if len(rooms) >= limit:
            break
        try:
            raw = c.client.api("/room/v1/area/getRoomList",
                               {"parent_area_id": area_id or 0, "area_id": 0,
                                "page": pn, "page_size": 30,
                                "sort_type": sort, "platform": "web"},
                               base=_LIVE_BASE)
        except BiliError:
            raw = None
        if not isinstance(raw, list) or not raw:
            break
        seen = {r["roomId"] for r in rooms}
        for x in raw:
            rid = _i(x.get("roomid"))
            if not rid or rid in seen:
                continue
            seen.add(rid)
            rooms.append(_area_room(x))
        if len(raw) < 30:
            break
        _t.sleep(0.25)

    if not rooms:
        src = "live.list_by_area"
        try:
            rooms = [_sdk_room(r) for r in live.list_by_area(
                c.client, area=area, page=page, page_size=max(limit, 10), sort=sort)]
        except BiliError:
            rooms = []
        if area_id:
            rooms = [r for r in rooms if r["parent_area_id"] == area_id
                     or (area_name and r["parent_area_name"] == area_name)]

    if len(rooms) < 3:
        note = (f"分区「{area_name or area}」这次只拿到 {len(rooms)} 个房间："
                "B 站该分区当前开播少，或接口降级；换 area 或过一会儿再试")

    out = []
    for r in rooms[:limit]:
        tag = r["area"]
        if r.get("parent_area_name") and tag and r["parent_area_name"] not in tag:
            tag = f'{r["parent_area_name"]}·{tag}'
        out.append({"roomId": r["roomId"], "title": r["title"], "uname": r["uname"],
                    "area": tag, "online": r["online"], "url": r["url"]})
    data = {"area": _s(area), "areaId": area_id, "sort": sort, "source": src,
            "count": len(out), "rooms": out,
            "onlineIsHeat": True}  # online 是分区页的人气值，不是 live_online 的真人数
    if note:
        data["note"] = note
    return data


def act_live_online(c: Ctx, a: dict) -> dict:
    rid = _need_int(a, "roomId")
    data = live.online_count(c.client, rid)
    return {"roomId": rid, "online": data.get("total"),
            **({"error": _clip(data.get("error"), 120)} if data.get("error") else {})}


def act_messages_unread(c: Ctx, a: dict) -> dict:
    c.require_login()
    data = c.client.api("/x/msgfeed/unread", {}, allow_guest=False) or {}
    keys = ("reply", "at", "like", "recv_like", "recv_reply", "sys_msg", "chat",
            "danmu", "coin", "favorite", "up")
    out = {k: _i(data.get(k)) for k in keys if k in data}
    # 各类未读的总和（含私信/sys_msg，跟 B 站角标口径不完全一样，所以叫 totalAll）
    out["totalAll"] = sum(v for v in out.values() if isinstance(v, int))
    return out


def _dm_content(last: dict) -> str:
    """私信 last_msg.content 是 JSON 字符串；按 msg_type 提取可读正文。"""
    raw = last.get("content")
    if isinstance(raw, str):
        try:
            obj = json.loads(raw)
        except (TypeError, ValueError):
            return _clip(raw, 200)
    elif isinstance(raw, dict):
        obj = raw
    else:
        return ""
    if not isinstance(obj, dict):
        return ""
    msg_type = _i(last.get("msg_type"))
    if msg_type == 2:
        return "[图片]"
    for key in ("content", "text", "title", "desc"):
        val = obj.get(key)
        if isinstance(val, dict):
            val = val.get("text") or val.get("content")
        if _s(val).strip():
            return _clip(val, 200)
    return ""


def act_messages_sessions(c: Ctx, a: dict) -> dict:
    """最近私信会话（session_type=1）。只读，供互动反馈做新私信提醒。

    last_msg 有时是「我们已互相关注，开始聊天吧~」这类系统开场，
    真正的正文在 fetch_session_msgs 里，所以每个会话再取最近几条。
    """
    c.require_login()
    try:
        from bilibili_api import session as bili_session
        cred = _bili_api_credential(c)
        data = asyncio.run(bili_session.get_sessions(cred, session_type=1))
    except Exception as exc:  # noqa: BLE001
        raise LocalError(f"读取私信会话失败：{exc}") from exc
    self_uid = c.self_uid_local()
    items = []
    for row in (data.get("session_list") or []):
        if not isinstance(row, dict):
            continue
        last = row.get("last_msg") or {}
        if not isinstance(last, dict):
            last = {}
        talker = _i(row.get("talker_id"))
        account = last.get("account_info") or {}
        name = _s(account.get("name")) or _s(row.get("group_name")) or str(talker)
        messages = []
        try:
            detail = asyncio.run(bili_session.fetch_session_msgs(talker, cred, session_type=1))
            for msg in (detail.get("messages") or [])[:6]:
                if not isinstance(msg, dict):
                    continue
                messages.append({
                    "senderUid": _i(msg.get("sender_uid")),
                    "text": _dm_content(msg),
                    "msgType": _i(msg.get("msg_type")),
                    "time": _iso(msg.get("timestamp")),
                    "seqno": _s(msg.get("msg_seqno")),
                })
            messages.reverse()  # API 返回新→旧，统一成旧→新
        except Exception:  # noqa: BLE001
            messages = []
        if not messages:
            messages = [{
                "senderUid": _i(last.get("sender_uid")),
                "text": _dm_content(last),
                "msgType": _i(last.get("msg_type")),
                "time": _iso(last.get("timestamp")),
                "seqno": _s(last.get("msg_seqno")),
            }]
        latest = messages[-1] if messages else {}
        items.append({
            "talkerId": talker,
            "from": _clip(name, 30),
            "fromUid": talker,
            "senderUid": _i(latest.get("senderUid")),
            "text": _s(latest.get("text")),
            "msgType": _i(latest.get("msgType")),
            "time": _s(latest.get("time")),
            "seqno": _s(latest.get("seqno")),
            "unread": _i(row.get("unread_count")),
            "url": f"https://message.bilibili.com/#/whisper/mid{talker}",
            "messages": messages,
        })
    items.sort(key=lambda x: x.get("time") or "", reverse=True)
    return {"count": len(items), "selfUid": self_uid, "items": items}


def _msg_item(x: dict) -> dict:
    """msgfeed/reply 与 msgfeed/at 的条目结构不同（实测字段名差别很大）。

    reply：item.source_content 是别人回复我的那句；顶层 reply_time 是时间。
    at   ：item.source_content 是 @ 我的那条评论；顶层 at_time 是时间。
    注意 item.desc 是**目标视频的简介**，不是消息正文，别拿它当聊天内容。
    """
    user = x.get("user") or {}
    item = x.get("item") or {}
    text = ""
    for key in ("source_content", "target_reply_content", "root_reply_content",
                "message", "content"):
        cand = item.get(key)
        if isinstance(cand, dict):
            cand = cand.get("text") or cand.get("content")
        if _s(cand).strip():
            text = _s(cand)
            break
    return {
        "from": _clip(user.get("nickname"), 30),
        "fromUid": _i(user.get("mid")),
        "kind": _s(item.get("business")) or _s(item.get("type")),
        "title": _clip(item.get("title") or item.get("detail_title"), 60),
        "text": _clip(text, 150),
        "time": _iso(x.get("reply_time") or x.get("at_time") or x.get("time")),
        "url": _s(item.get("uri")) or _s(item.get("native_uri")),
    }


def _msgfeed(c: Ctx, path: str, a: dict, cap: int = 30) -> dict:
    c.require_login()
    limit = _limit(a, 10, cap)
    data = c.client.api(path, {"pn": _i(a.get("page"), 1), "ps": limit},
                        allow_guest=False) or {}
    items = [_msg_item(x) for x in (data.get("items") or [])[:limit]
             if isinstance(x, dict)]
    return {"count": len(items), "hasMore": not bool((data.get("cursor") or {}).get("is_end")),
            "items": items}


def act_messages_replies(c: Ctx, a: dict) -> dict:
    return _msgfeed(c, "/x/msgfeed/reply", a)


def act_messages_at(c: Ctx, a: dict) -> dict:
    return _msgfeed(c, "/x/msgfeed/at", a)


def act_relation_status(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    c.require_login()
    meta = video.view(c.client, bv)
    rel = c.client.api("/x/web-interface/archive/relation", {"bvid": bv}) or {}
    up_mid = _i(meta["owner"]["mid"])
    following = None
    note = ""
    if up_mid:
        try:
            fr = c.client.api("/x/relation", {"fid": up_mid}) or {}
            following = _i(fr.get("attribute")) in (2, 6)  # 2=已关注 6=互关
        except BiliError as e:
            note = f"关注状态没拿到：{e}"
    coin = _i(rel.get("coin"))
    out = {
        "bvid": meta["bvid"],
        "up": {"mid": up_mid, "name": meta["owner"]["name"]},
        "hasLiked": bool(rel.get("like")),
        "hasFav": bool(rel.get("favorite")),
        "coin": coin,
        "hasCoin": coin > 0,
        "followingUp": following,
        "url": meta["url"],
    }
    if note:
        out["note"] = note
    return out


# ================================================================ 写动作
#
# 统一约定：
#   · args.dryRun 缺省 = true（安全默认）；只有显式 false 才真的发请求。
#   · dry-run 完全不发请求（连 bvid→aid 都不解析），回显 endpoint + 参数骨架，
#     参数里的 csrf 一律打码成 <bili_jct>，cookie 值一个都不出境。
#   · 真发之前过 require_csrf()（SESSDATA + bili_jct 都在）。
#
def _dry(c: Ctx, action: str, endpoint: str, params: dict, **extra: Any) -> dict:
    return {
        "dryRun": True,
        "action": action,
        "endpoint": endpoint,
        "params": _mask(params),
        "loggedIn": c.has_sessdata,
        "hasCsrf": c.has_jct,
        "note": "dryRun：没有发送任何请求。真发要显式传 \"dryRun\": false。",
        **extra,
    }


def _plan_only(c: Ctx, action: str, endpoint: str, params: dict, *,
               needs: Optional[list] = None, **extra: Any) -> tuple[bool, dict]:
    """返回 (要不要真发, 要发就返回 dry-run 之外的空 dict 里的东西)。"""
    if needs:
        for key, why in needs:
            if not _s(params.get(key)).strip():
                raise LocalError(f"缺少或无效的参数 {key}：{why}")
    return True, {}




def _write_receipt(action: str, endpoint: str, params: dict, result: Any = None) -> dict:
    """真发之后的回执：带上 B 站回的关键字段（评论的 rpid 尤其要，宿主判重要用）。"""
    out: dict[str, Any] = {
        "dryRun": False,
        "action": action,
        "endpoint": endpoint,
        "params": _mask(params),
        "sent": True,
    }
    if isinstance(result, dict):
        for k in ("rpid", "rpid_str", "aid", "like", "coin", "upper", "msg_key",
                  "def", "count"):
            val = result.get(k)
            if val in (None, "", 0, [], {}):
                continue
            out[k] = _clip(val, 80) if isinstance(val, str) else val
    return out


def _find_comment_root(c: Ctx, bvid: str, aid: int, target: int) -> int:
    """把「要回复的评论」定位到它所在的根评论。

    顶层评论 root 就是自己；楼中楼必须用真正的 root，否则 B 站会把回复挂到
    错误的那条楼下（看起来就像“评论到别人评论下了”）。
    """
    if not target:
        return 0
    main = c.client.api(
        "/x/v2/reply/main",
        {"type": 1, "oid": aid, "mode": 2, "next": 0, "ps": 20},
        headers={"Referer": f"https://www.bilibili.com/video/{bvid}"},
    ) or {}
    roots: list[int] = []
    for item in main.get("replies") or []:
        rid = _i(item.get("rpid"))
        if rid == target:
            return target
        if rid and _i(item.get("rcount")) > 0:
            roots.append(rid)
    for rid in roots[:10]:
        page = _reply_page(c, bvid, aid, rid)
        for item in page.get("replies") or []:
            if _i(item.get("rpid")) == target:
                return _i(page.get("root")) or rid
    return target


def _reply_page(c: Ctx, bvid: str, aid: int, root: int) -> dict:
    return c.client.api(
        "/x/v2/reply/reply",
        {"type": 1, "oid": aid, "root": root, "ps": 20, "pn": 1},
        headers={"Referer": f"https://www.bilibili.com/video/{bvid}"},
    ) or {}


def _comment_visibility(c: Ctx, bvid: str, aid: int, rpid: int, root: int = 0) -> dict:
    """查评论的 state：顶层查 /reply/main，楼中楼查 /reply/reply。

    B 站 state=0 才是所有人可见；state=17/其他值常见于「审核中/仅自己可见」。
    回楼的 rpid 不会出现在顶层列表里，所以必须同时查它所在的 root。
    这个检查只读，失败不影响已经发出去的评论。
    """
    out: dict[str, Any] = {"state": None, "visible": None, "note": "", "scope": None, "root": root or None}
    if not rpid:
        out["note"] = "没拿到 rpid，查不了可见性"
        return out

    def scan(items, scope: str, root_id: int = 0) -> bool:
        for item in items or []:
            if _i(item.get("rpid")) == rpid:
                state = _i(item.get("state"))
                out.update({
                    "state": state,
                    "attr": _i(item.get("attr")),
                    "visible": state == 0,
                    "scope": scope,
                    "root": root_id or (out.get("root") if scope == "reply" else None),
                })
                if state != 0:
                    out["note"] = (f"B站返回 state={state}：评论在审核/仅自己可见，"
                                   "别人和消息中心看不到")
                return True
        return False

    try:
        checked_roots: set[int] = set()
        if root:
            checked_roots.add(root)
            if scan(_reply_page(c, bvid, aid, root).get("replies"), "reply", root):
                return out
        main = c.client.api(
            "/x/v2/reply/main",
            {"type": 1, "oid": aid, "mode": 2, "next": 0, "ps": 20},
            headers={"Referer": f"https://www.bilibili.com/video/{bvid}"},
        ) or {}
        if scan(main.get("replies"), "top"):
            return out
        # comment_state 可能只拿到回楼 rpid、没有 root：在最近一层楼里找。
        roots: list[int] = []
        for item in main.get("replies") or []:
            rid = _i(item.get("rpid"))
            if rid and rid not in checked_roots and _i(item.get("rcount")) > 0:
                roots.append(rid)
        for rid in roots[:10]:
            checked_roots.add(rid)
            if scan(_reply_page(c, bvid, aid, rid).get("replies"), "reply", rid):
                return out
        out["note"] = "评论已提交，但顶层和楼中楼列表都没找到（可能审核中/被折叠）"
    except Exception as exc:  # noqa: BLE001
        out["note"] = f"评论已提交，但查可见性失败：{exc}"
    return out


def act_comment_state(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    rpid = _i(a.get("rpid"))
    root = _i(a.get("root") or a.get("rootRpid") or a.get("replyTo"))
    if not rpid:
        raise LocalError("缺少参数 rpid")
    c.require_login()
    meta = video.view(c.client, bv)
    state = _comment_visibility(c, meta["bvid"], _i(meta["aid"]), rpid, root)
    return {"bvid": meta["bvid"], "rpid": rpid, **state, "url": meta["url"]}



def _reply_headers(c: Ctx, bvid: str) -> dict:
    """网页端发评论会带的头；缺 Origin/x-csrf-token 时 B 站容易判成接口调用。"""
    return {
        "Referer": f"https://www.bilibili.com/video/{bvid}",
        "Origin": "https://www.bilibili.com",
        "x-csrf-token": c.client.csrf,
        "x-requested-with": "XMLHttpRequest",
    }


def act_comment_add(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    text = _s(a.get("text") or a.get("message")).strip()
    pic = _s(a.get("pic") or a.get("image") or "").strip()
    if not text:
        raise LocalError("缺少参数 text")
    if len(text) > 1000:
        raise LocalError(f"评论 {len(text)} 字，超过 B 站 1000 字上限")
    target = _i(a.get("parent") or a.get("parentRpid") or a.get("rpid") or a.get("replyTo"))
    root = _i(a.get("root") or a.get("rootRpid"))
    parent = target
    aid = _i(a.get("aid"))
    if pic:
        image = _image_file(pic)
        if not _b(a.get("dryRun", True)):
            c.require_csrf()
            meta = video.view(c.client, bv)
            if not root and target:
                root = _find_comment_root(c, meta["bvid"], _i(meta["aid"]), target)
                parent = target
            cred = _bili_api_credential(c)
            try:
                from bilibili_api.comment import CommentResourceType, send_comment
                from bilibili_api.utils.picture import Picture

                result = asyncio.run(send_comment(
                    text=text,
                    oid=meta["aid"],
                    type_=CommentResourceType.VIDEO,
                    root=root or None,
                    parent=parent or None,
                    credential=cred,
                    pic=Picture.from_file(str(image)),
                ))
            except Exception as exc:  # noqa: BLE001
                raise LocalError(f"带图评论失败：{exc}") from exc
            out = _write_receipt("comment_add", "bilibili_api.comment.send_comment (pic)",
                                 {"bvid": bv, "text": text, "pic": str(image)},
                                 result if isinstance(result, dict) else {"result": result})
            out.update({"url": meta["url"], "pic": str(image), "withImage": True})
            rpid = _i((result or {}).get("rpid") if isinstance(result, dict) else 0)
            if rpid:
                out.update(_comment_visibility(c, meta["bvid"], _i(meta["aid"]), rpid))
            return out
        return {
            "dryRun": True,
            "action": "comment_add",
            "endpoint": "bilibili_api.comment.send_comment (pic)",
            "params": {"bvid": bv, "text": text, "pic": str(image), "root": root or None,
                       "parent": parent or None},
            "note": "带图评论：dry-run 只校验图片，不上传、不发评论",
        }
    params = {
        "oid": aid or f"<view({bv}).aid>",
        "type": 1,
        "message": text,
        "plat": 1,
        "csrf": c.client.csrf,
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        meta = video.view(c.client, bv)
        if not root and target:
            root = _find_comment_root(c, meta["bvid"], _i(meta["aid"]), target)
            parent = target
        if root:
            params["root"] = root
            params["parent"] = parent or root
        params["oid"] = aid or meta["aid"]
        res = c.client.api_post("/x/v2/reply/add",
                                {k: str(v) for k, v in params.items()},
                                headers=_reply_headers(c, meta["bvid"]))
        out = _write_receipt("comment_add", "POST /x/v2/reply/add", params, res)
        out["url"] = meta["url"]
        rpid = _i((res or {}).get("rpid"))
        if rpid:
            visibility = {}
            for attempt in range(3):
                visibility = _comment_visibility(c, meta["bvid"], _i(meta["aid"]), rpid, root)
                if visibility.get("state") is not None:
                    break
                if attempt < 2:
                    import time as _t
                    _t.sleep(0.8)
            out.update(visibility)
        out["root"] = root or None
        return out
    return _dry(c, "comment_add", "POST /x/v2/reply/add", params,
                hint="oid 是 aid；dry-run 不解析 bvid→aid")


def act_like(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    like = 1 if _b(a.get("like", True)) else 0
    params = {"aid": _i(a.get("aid")) or f"<view({bv}).aid>", "like": like,
              "csrf": c.client.csrf}
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        aid = _i(a.get("aid")) or video.view(c.client, bv)["aid"]
        params["aid"] = aid
        c.client.api_post("/x/web-interface/archive/like",
                          {k: str(v) for k, v in params.items()})
        return {"dryRun": False, "sent": True, "endpoint": "POST /x/web-interface/archive/like",
                "bvid": bv, "aid": aid, "liked": bool(like)}
    return _dry(c, "like", "POST /x/web-interface/archive/like", params)


def act_coin(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    num = _i(a.get("num"), 1) or 1
    if num not in (1, 2):
        raise LocalError(f"num 只能是 1 或 2（B 站单次投币上限 2 枚），收到 {num}")
    params = {
        "aid": _i(a.get("aid")) or f"<view({bv}).aid>",
        "bvid": bv,
        "multiply": num,
        "like": 1 if _b(a.get("like", False)) else 0,
        "csrf": c.client.csrf,
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        aid = _i(a.get("aid")) or video.view(c.client, bv)["aid"]
        params["aid"] = aid
        c.client.api_post("/x/web-interface/coin/add",
                          {k: str(v) for k, v in params.items()})
        return {"dryRun": False, "sent": True,
                "endpoint": "POST /x/web-interface/coin/add",
                "bvid": bv, "aid": aid, "coins": num}
    return _dry(c, "coin", "POST /x/web-interface/coin/add", params)


def act_favorite(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    add_id = _i(a.get("addFolderId"))
    del_id = _i(a.get("removeFolderId"))
    if not add_id and not del_id:
        raise LocalError("addFolderId / removeFolderId 至少给一个（收藏夹 id 用 favorites 查）")
    params = {
        "rid": _i(a.get("aid")) or f"<view({bv}).aid>",
        "type": 2,
        "add_media_ids": _s(add_id),
        "del_media_ids": _s(del_id),
        "platform": "web",
        "csrf": c.client.csrf,
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        aid = _i(a.get("aid")) or video.view(c.client, bv)["aid"]
        params["rid"] = aid
        c.client.api_post("/x/v3/fav/resource/deal",
                          {k: str(v) for k, v in params.items()})
        return {"dryRun": False, "sent": True, "endpoint": "POST /x/v3/fav/resource/deal",
                "bvid": bv, "aid": aid, "added": add_id or None, "removed": del_id or None}
    return _dry(c, "favorite", "POST /x/v3/fav/resource/deal", params,
                hint="rid 是 aid；type=2 表示视频")


def act_triple(c: Ctx, a: dict) -> dict:
    """一键三连：点赞 + 投币（+ 有 folderId 才收藏）。"""
    bv = _bvid(a)
    num = _i(a.get("num"), 1) or 1
    if num not in (1, 2):
        raise LocalError(f"num 只能是 1 或 2，收到 {num}")
    folder = _i(a.get("folderId") or a.get("addFolderId"))
    aid_ph = _i(a.get("aid")) or f"<view({bv}).aid>"
    steps = [
        {"endpoint": "POST /x/web-interface/archive/like",
         "params": _mask({"aid": aid_ph, "like": 1, "csrf": c.client.csrf})},
        {"endpoint": "POST /x/web-interface/coin/add",
         "params": _mask({"aid": aid_ph, "bvid": bv, "multiply": num, "like": 0,
                          "csrf": c.client.csrf})},
    ]
    if folder:
        steps.append({"endpoint": "POST /x/v3/fav/resource/deal",
                      "params": _mask({"rid": aid_ph, "type": 2, "add_media_ids": folder,
                                       "del_media_ids": "", "platform": "web",
                                       "csrf": c.client.csrf})})
    skipped = [] if folder else ["收藏：没给 folderId，跳过（用 favorites 查一个再传 folderId）"]
    if _b(a.get("dryRun", True)):
        return _dry(c, "triple", "（三连 = 3 个 POST，见 steps）", {"bvid": bv},
                    steps=steps, skipped=skipped,
                    hint="按顺序发；任一步失败就停（不重试，避免重复投币）")
    c.require_csrf()
    meta = video.view(c.client, bv)
    aid = _i(a.get("aid")) or meta["aid"]
    done, results = [], []
    for step in steps:
        p = dict(step["params"])
        p["aid" if "aid" in p else "rid"] = aid
        p["csrf"] = c.client.csrf
        try:
            res = c.client.api_post(step["endpoint"].split(" ", 1)[1],
                                    {k: str(v) for k, v in p.items()})
        except BiliError as e:
            # 重复点赞/已收藏不是失败：三连是幂等的，继续做剩下两步。
            if step["endpoint"].endswith("/archive/like") and e.code == 65006:
                done.append(step["endpoint"])
                results.append({"step": "triple", "endpoint": step["endpoint"],
                                "ok": True, "code": 65006, "note": "已经赞过，跳过"})
                continue
            if step["endpoint"].endswith("/fav/resource/deal") and e.code == 11201:
                done.append(step["endpoint"])
                results.append({"step": "triple", "endpoint": step["endpoint"],
                                "ok": True, "code": 11201, "note": "已经收藏过，跳过"})
                continue
            raise
        done.append(step["endpoint"])
        results.append(_write_receipt("triple", step["endpoint"], p, res))
    return {"dryRun": False, "sent": True, "bvid": bv, "aid": aid,
            "steps": results, "done": done, "skipped": skipped}


def act_follow(c: Ctx, a: dict) -> dict:
    uid = _need_int(a, "uid")
    action = _s(a.get("action") or "follow").strip().lower()
    if action not in ("follow", "unfollow"):
        raise LocalError("action 只能是 follow 或 unfollow")
    act_code = 1 if action == "follow" else 2
    params = {"fid": uid, "act": act_code, "re_src": 11, "csrf": c.client.csrf}
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        c.client.api_post("/x/relation/modify", {k: str(v) for k, v in params.items()})
        return {"dryRun": False, "sent": True, "endpoint": "POST /x/relation/modify",
                "uid": uid, "action": action}
    return _dry(c, "follow", "POST /x/relation/modify", params)


def act_danmaku_send(c: Ctx, a: dict) -> dict:
    bv = _bvid(a)
    # text 是正式参数；message 是旧目录/聊天里常用的别名，别再让它静默发不出去。
    text = _s(a.get("text") or a.get("message")).strip()
    if not text:
        raise LocalError("缺少参数 text（弹幕内容，不是 message）")
    if len(text) > 100:
        raise LocalError(f"弹幕 {len(text)} 字，超过 B 站 100 字上限")
    # time 是秒数；progress 也按秒数接收，避免工具目录写 progress 时被当成默认第 1 秒。
    sec = a.get("time", a.get("progress", 1))
    try:
        sec = float(sec)
    except (TypeError, ValueError) as e:
        raise LocalError(f"time 必须是秒数，收到 {sec!r}") from e
    if sec < 0:
        raise LocalError("time 不能是负数")
    params = {
        "type": 1,
        "bvid": bv,
        "oid": _i(a.get("cid")) or f"<view({bv}).cid>",   # 弹幕 oid 是 cid（不是 aid）
        "pid": _i(a.get("aid")) or f"<view({bv}).aid>",
        "msg": text,
        "progress": int(sec * 1000),
        "mode": _i(a.get("mode"), 1) or 1,
        "fontsize": 25,
        "color": _i(a.get("color"), 16777215) or 16777215,
        "pool": 0,
        "plat": 1,
        "csrf": c.client.csrf,
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        meta = video.view(c.client, bv)
        if not meta["cid"]:
            raise LocalError(f"{bv} 拿不到 cid，发不了弹幕（可能已失效）")
        params["oid"] = _i(a.get("cid")) or meta["cid"]
        params["pid"] = _i(a.get("aid")) or meta["aid"]
        res = c.client.api_post("/x/v2/dm/post",
                                {k: str(v) for k, v in params.items()})
        out = _write_receipt("danmaku_send", "POST /x/v2/dm/post", params, res)
        out["bvid"] = bv
        out["atSeconds"] = round(sec, 1)
        return out
    return _dry(c, "danmaku_send", "POST /x/v2/dm/post", params,
                hint="oid=cid、pid=aid（B 站弹幕接口的老规矩）；最后的 params 才是实际顺序")


def act_live_danmaku(c: Ctx, a: dict) -> dict:
    rid = _need_int(a, "roomId")
    text = _s(a.get("text") or a.get("message")).strip()
    if not text:
        raise LocalError("缺少参数 text（直播弹幕内容，不是 message）")
    if len(text) > 20:
        text = text[:20]      # 直播间弹幕上限 20 字，截断而不是报错（B 站自己也会截）
    import time as _t
    params = {
        "roomid": rid,
        "msg": text,
        "color": _i(a.get("color"), 16777215) or 16777215,
        "fontsize": 25,
        "mode": 1,
        "rnd": int(_t.time()),
        "pool": 0,
        "bubble": 0,
        "csrf": c.client.csrf,
        "csrf_token": c.client.csrf,
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        # 直接 POST /msg/send：不走 live.send_danmaku（它自带 allow_write 闸）
        c.client.api_post("/msg/send", {k: str(v) for k, v in params.items()},
                          base="https://api.live.bilibili.com")
        return {"dryRun": False, "sent": True, "endpoint": "POST api.live.bilibili.com/msg/send",
                "roomId": rid, "text": text}
    return _dry(c, "live_danmaku", "POST api.live.bilibili.com/msg/send", params)


def act_dm_send(c: Ctx, a: dict) -> dict:
    """私信：B 站 web_im 接口（mcp_server 走的 bilibili_api 最后落到这里）。

    ⚠️ 这条**没有实测**（写操作，测试期一律没发）：参数形状照
       `POST api.vc.bilibili.com/web_im/v1/web_im/send_msg` 的 web 端调用来。
       宿主真要用，先 dry-run 看一眼，再拿一个自己的小号试一次。
    """
    uid = _need_int(a, "uid")
    text = _s(a.get("text") or a.get("message")).strip()
    pic = _s(a.get("pic") or a.get("image") or "").strip()
    if not text and not pic:
        raise LocalError("缺少参数 text 或 pic")
    if len(text) > 1000:
        raise LocalError(f"私信 {len(text)} 字，太长了（建议 500 字以内）")
    if pic:
        image = _image_file(pic)
        if _b(a.get("dryRun", True)):
            return {
                "dryRun": True,
                "action": "dm_send",
                "endpoint": "bilibili_api.session.send_msg (PICTURE)",
                "params": {"uid": uid, "pic": str(image), "text": text},
                "note": "私信带图：dry-run 只校验图片；真发会先发文字（如果有）再发图片",
            }
        c.require_csrf()
        text_result = None
        if text:
            import random
            import time as _t
            dev_id = "".join(random.choice("0123456789ABCDEF") for _ in range(32))
            params = {
                "msg[sender_uid]": c.self_uid(),
                "msg[receiver_id]": uid,
                "msg[receiver_type]": 1,
                "msg[msg_type]": 1,
                "msg[msg_status]": 0,
                "msg[dev_id]": dev_id,
                "msg[timestamp]": int(_t.time()),
                "msg[content]": json.dumps({"content": text}, ensure_ascii=False),
                "csrf": c.client.csrf,
                "csrf_token": c.client.csrf,
                "build": 0,
                "mobi_app": "web",
            }
            text_result = c.client.api_post(
                "https://api.vc.bilibili.com/web_im/v1/web_im/send_msg",
                {k: str(v) for k, v in params.items()})
        try:
            from bilibili_api.session import EventType, send_msg
            from bilibili_api.utils.picture import Picture

            result = asyncio.run(send_msg(
                credential=_bili_api_credential(c),
                receiver_id=uid,
                msg_type=EventType.PICTURE,
                content=Picture.from_file(str(image)),
            ))
        except Exception as exc:  # noqa: BLE001
            raise LocalError(f"私信图片发送失败：{exc}") from exc
        out = _write_receipt("dm_send", "bilibili_api.session.send_msg (PICTURE)",
                             {"uid": uid, "pic": str(image), "text": text},
                             result if isinstance(result, dict) else {"result": result})
        out.update({"to": uid, "pic": str(image), "withImage": True,
                    "textSent": bool(text_result), "verified": False})
        return out
    import time as _t
    dev_id = _s(a.get("devId"))
    if not dev_id:
        import random
        dev_id = "".join(random.choice("0123456789ABCDEF") for _ in range(32))
    params = {
        "msg[sender_uid]": c.self_uid_local() or "<login uid>",
        "msg[receiver_id]": uid,
        "msg[receiver_type]": 1,
        "msg[msg_type]": 1,
        "msg[msg_status]": 0,
        "msg[dev_id]": dev_id,
        "msg[timestamp]": int(_t.time()),
        "msg[content]": json.dumps({"content": text}, ensure_ascii=False),
        "csrf": c.client.csrf,
        "csrf_token": c.client.csrf,
        "build": 0,
        "mobi_app": "web",
    }
    if not _b(a.get("dryRun", True)):
        c.require_csrf()
        params["msg[sender_uid]"] = c.self_uid()
        res = c.client.api_post("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg",
                                {k: str(v) for k, v in params.items()})
        out = _write_receipt("dm_send",
                             "POST api.vc.bilibili.com/web_im/v1/web_im/send_msg",
                             params, res)
        out["to"] = uid
        out["verified"] = False      # 没实测过：宿主别把它当既定事实
        return out
    return _dry(c, "dm_send", "POST api.vc.bilibili.com/web_im/v1/web_im/send_msg", params,
                verified=False,
                hint="未实测；先用小号试，别往真人号上发第一条测试消息")


def act_dynamic_post(c: Ctx, a: dict) -> dict:
    """发动态：**故意不实现**。

    新版创建动态接口（/x/dynamic/feed/create/dyn）除了 dyn_req 还要求 upload_id、
    特定 header 和一次性的风控参数；参数猜错可能发出一条半截动态，比失败更糟。
    所以：dry-run 告诉你端点长什么样，真发一律 ok:false（宿主可以据此禁用按钮）。
    """
    text = _s(a.get("text")).strip()
    if not text:
        raise LocalError("缺少参数 text")
    shape = {
        "dyn_req": {
            "content": {"contents": [{"type": 1, "raw_text": text}]},
            "scene": 1, "attach_card": None, "upload_id": "<需先申请>", "dyn_id": "",
            "publish": True,
        },
        "csrf": "<bili_jct>",
        "platform": "web",
    }
    if _b(a.get("dryRun", True)):
        return {
            "dryRun": True, "action": "dynamic_post",
            "endpoint": "POST /x/dynamic/feed/create/dyn",
            "params": shape,
            "implemented": False,
            "note": "接口形状已标注，但**未实现/未验证**：创建动态还需要 upload_id 与"
                    "风控 header，猜着发可能产生半截动态。需要时先补一个真机抓包再开。",
        }
    raise LocalError("dynamic_post 未实现（不猜参数发动态）：需要 B 站 "
                     "/x/dynamic/feed/create/dyn 的完整 dyn_req + upload_id 抓包，"
                     "确认后再补；当前请手工在 B 站 App/网页发。")


# ================================================================ 动作表
ACTIONS: dict[str, dict] = {
    # ---- 自检 / 账号
    "ping": {"fn": act_ping, "write": False, "desc": "本地自检（不发请求）"},
    "whoami": {"fn": act_whoami, "write": False, "desc": "当前登录态（不回传 cookie 值）"},
    # ---- 视频
    "search": {"fn": act_search, "write": False, "desc": "搜索视频 {keyword,limit,order,page}"},
    "video_info": {"fn": act_video_info, "write": False, "desc": "视频详情 {bvid}"},
    "video_comments": {"fn": act_video_comments, "write": False, "desc": "热门评论 {bvid,limit}"},
    "video_danmaku": {"fn": act_video_danmaku, "write": False, "desc": "弹幕 {bvid,limit}"},
    "video_subtitle": {"fn": act_video_subtitle, "write": False, "desc": "字幕 {bvid}"},
    "comment_state": {"fn": act_comment_state, "write": False,
                      "desc": "查评论可见性 {bvid,rpid}（state=0 才是所有人可见）"},
    "relation_status": {"fn": act_relation_status, "write": False,
                        "desc": "我对该视频的赞/币/藏 + 是否关注 UP {bvid}"},
    # ---- 用户
    "user_info": {"fn": act_user_info, "write": False, "desc": "用户资料 {uid?}"},
    "user_videos": {"fn": act_user_videos, "write": False, "desc": "最近投稿 {uid?,limit}"},
    "user_dynamics": {"fn": act_user_dynamics, "write": False, "desc": "空间动态 {uid?,limit}"},
    "following": {"fn": act_following, "write": False, "desc": "关注列表 {uid?,limit}"},
    "favorites": {"fn": act_favorites, "write": False, "desc": "收藏夹列表 {uid?}"},
    "favorite_content": {"fn": act_favorite_content, "write": False,
                         "desc": "收藏夹内容 {mediaId,limit}"},
    # ---- 发现
    "home_feed": {"fn": act_home_feed, "write": False,
                  "desc": "个性化首页推荐（刷B站主入口）{limit,freshType?}"},
    "hot": {"fn": act_hot, "write": False, "desc": "热门视频 {limit}"},
    "rank": {"fn": act_rank, "write": False, "desc": "排行榜 {limit,rid,type}"},
    "weekly": {"fn": act_weekly, "write": False, "desc": "每周必看 {limit,number?}"},
    # ---- 直播
    "live_room": {"fn": act_live_room, "write": False, "desc": "直播间信息 {roomId?|mid?}"},
    "live_roam": {"fn": act_live_roam, "write": False,
                  "desc": "分区乱逛 {area='虚拟',limit,sort}"},
    "live_online": {"fn": act_live_online, "write": False, "desc": "真实在线人数 {roomId}"},
    # ---- 消息
    "messages_unread": {"fn": act_messages_unread, "write": False, "desc": "未读数 {}"},
    "messages_sessions": {"fn": act_messages_sessions, "write": False,
                          "desc": "最近私信会话（含最近一条正文）{}"},
    "messages_replies": {"fn": act_messages_replies, "write": False,
                         "desc": "收到的回复 {limit}"},
    "messages_at": {"fn": act_messages_at, "write": False, "desc": "收到的 @ {limit}"},
    # ---- 写（默认 dryRun）
    "comment_add": {"fn": act_comment_add, "write": True, "desc": "发评论 {bvid,text,pic?,root?,parent?}"},
    "like": {"fn": act_like, "write": True, "desc": "点赞 {bvid,like}"},
    "coin": {"fn": act_coin, "write": True, "desc": "投币 {bvid,num,like}"},
    "favorite": {"fn": act_favorite, "write": True,
                 "desc": "收藏/取消 {bvid,addFolderId?,removeFolderId?}"},
    "triple": {"fn": act_triple, "write": True, "desc": "三连 {bvid,num,folderId?}"},
    "follow": {"fn": act_follow, "write": True, "desc": "关注/取关 {uid,action}"},
    "danmaku_send": {"fn": act_danmaku_send, "write": True,
                     "desc": "发视频弹幕 {bvid,text,time}"},
    "live_danmaku": {"fn": act_live_danmaku, "write": True, "desc": "发直播弹幕 {roomId,text}"},
    "dm_send": {"fn": act_dm_send, "write": True, "desc": "发私信 {uid,text,pic?}（未实测）"},
    "dynamic_post": {"fn": act_dynamic_post, "write": True, "desc": "发动态 {text}（未实现）"},
}


# ================================================================ 入口
def _emit(payload: dict) -> None:
    """一行 UTF-8 JSON 到 stdout（Windows 下强制 bypass 本地编码）。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    try:
        buf = getattr(sys.stdout, "buffer", None)
        if buf is not None:
            buf.write(text.encode("utf-8") + b"\n")
            buf.flush()
        else:  # pragma: no cover
            sys.stdout.write(text + "\n")
            sys.stdout.flush()
    except Exception:  # pragma: no cover - 兜底：至少别把栈炸出来
        sys.stdout.write(json.dumps({"ok": False, "action": payload.get("action", "?"),
                                     "error": "输出失败", "code": None}) + "\n")


def _error(action: str, error: str, code: Any = None, **extra: Any) -> dict:
    out = {"ok": False, "action": action, "error": error, "code": code}
    out.update({k: v for k, v in extra.items() if v not in (None, "", [], {})})
    return out


def _bili_error(action: str, e: BiliError) -> dict:
    code = getattr(e, "code", None)
    msg = _s(e) or "B 站接口报错（无消息）"
    hint = CODE_HINTS.get(code) if isinstance(code, int) else None
    if hint and hint not in msg:
        msg = f"{msg}｜{hint}"
    return _error(action, msg, code)


def dispatch(ctx: Ctx, action: str, args: dict) -> dict:
    spec = ACTIONS.get(action)
    if spec is None:
        raise LocalError(f"未知 action：{action}（用 --list-actions 看全部）")
    fn: Callable[[Ctx, dict], Any] = spec["fn"]
    data = fn(ctx, args or {})
    return _fit(data, action)


def _parse_request(raw: str) -> tuple[str, dict]:
    raw = _s(raw).strip()
    if not raw:
        raise LocalError("没有收到请求 JSON（最后一个参数应该是 {\"action\":…,\"args\":…}）")
    try:
        obj = json.loads(raw)
    except ValueError as e:
        raise LocalError(f"请求不是合法 JSON：{e}；收到 {raw[:120]!r}") from e
    if not isinstance(obj, dict):
        raise LocalError(f"请求必须是 JSON 对象，收到 {type(obj).__name__}")
    action = _s(obj.get("action")).strip()
    if not action:
        raise LocalError("请求里没有 action 字段")
    args = obj.get("args")
    if args is None:
        args = obj.get("arguments") or {}
    if not isinstance(args, dict):
        raise LocalError("args 必须是对象")
    return action, args


def main(argv: Optional[list[str]] = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="bili_bridge.py", add_help=False,
        description="大肥鱼 B 站桥：一次调用一个 action，输出一行 JSON")
    ap.add_argument("request", nargs="?", help='JSON：{"action":"whoami","args":{}}')
    ap.add_argument("--cookie", default=None,
                    help=f"cookie 文件路径（默认环境变量 {ENV_COOKIE} → {DEFAULT_COOKIE}）")
    ap.add_argument("--timeout", type=float, default=0.0, help="单请求超时秒数（默认 20）")
    ap.add_argument("--data-dir", default=None, help="buvid 缓存目录（默认 bridge/.data）")
    ap.add_argument("--list-actions", action="store_true", help="列出全部 action 后退出")
    ap.add_argument("--ipv6", action="store_true",
                    help="允许走 IPv6（默认强制 IPv4：这台机器 v6 只解析不通，会让每个"
                         "新连接卡 20s）")
    ap.add_argument("--version", action="store_true", help="打印版本后退出")
    ap.add_argument("-h", "--help", action="store_true", help="打印帮助（JSON）")
    try:
        ns = ap.parse_args(argv or sys.argv[1:])
    except SystemExit:
        _emit(_error("?", "参数解析失败：检查命令行（最后一个参数应是 JSON）"))
        return 0

    if ns.version:
        _emit({"ok": True, "action": "version", "data": {"version": BRIDGE_VERSION}})
        return 0
    if ns.help:
        _emit({"ok": True, "action": "help", "data": {
            "usage": "python bili_bridge.py [--cookie PATH] '{\"action\":\"…\",\"args\":{…}}'",
            "actions": {k: v["desc"] for k, v in ACTIONS.items()},
            "note": "写动作默认 dryRun=true，要真发传 \"dryRun\": false",
        }})
        return 0
    if ns.list_actions:
        _emit({"ok": True, "action": "list-actions", "data": {
            "version": BRIDGE_VERSION,
            "actions": [{"name": k, "write": v["write"], "desc": v["desc"]}
                        for k, v in ACTIONS.items()]}})
        return 0

    action = "?"
    try:
        # 必须在建 client / 发第一个请求之前打补丁（见 _prefer_ipv4 的实测数据）
        if not ns.ipv6 and os.environ.get("FEIYU_IPV6", "") not in ("1", "true", "on"):
            _prefer_ipv4()
        action, args = _parse_request(ns.request or "")
        ctx = Ctx(cookie=ns.cookie, timeout=ns.timeout, data_dir=ns.data_dir)
        data = dispatch(ctx, action, args)
        _emit({"ok": True, "action": action, "data": data})
        return 0
    except LocalError as e:
        _emit(_error(action, str(e)))
    except BiliError as e:
        _emit(_bili_error(action, e))
    except KeyboardInterrupt:  # pragma: no cover
        _emit(_error(action, "已中断"))
    except Exception as e:  # noqa: BLE001 - 兜底：任何异常都变成 ok:false
        import traceback
        tb = traceback.format_exc(limit=3).strip().splitlines()
        _emit(_error(action, f"内部错误：{type(e).__name__}: {e}",
                     code=None, trace=tb[-1][:300] if tb else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
