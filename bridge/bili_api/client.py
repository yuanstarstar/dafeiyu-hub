# -*- coding: utf-8 -*-
"""B 站 HTTP 客户端（纯标准库）。

为什么不用 requests / httpx：
本机（DSH 自带运行时）只有标准库 + numpy/Pillow，pip 装不了东西；而 B 站接口只需要
GET/POST + cookie + WBI 签名，urllib 完全够用。

能力：
- cookie 会话（http.cookiejar，可注入 bili_cookie.json 里的 SESSDATA / bili_jct）
- buvid3/buvid4 指纹（/x/frontend/finger/spi，磁盘缓存，避免冷启动 20~40 秒）
- WBI 签名（nav 取 img/sub key，1 小时缓存；算法与 B 站前端一致）
- 统一错误：HTTP 非 200 / 非 JSON / code != 0 都会抛 BiliError，带 code 和中文消息

不做的：不做重试风暴、不自动刷新登录态——慢/失败就让调用方看见原因。
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .errors import BiliError, NotLoggedIn

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

API_PC = "https://api.bilibili.com"
API_LIVE = "https://api.live.bilibili.com"

# WBI 混淆表（B 站前端公开算法）
_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
    11, 36, 20, 34, 44, 52,
]
_WBI_SAFE = "!'()*"

# 未登录时 B 站也返回 code=-101，这类「业务码」交给调用方决定是否降级
GUEST_CODES = {-101}


def mixin_key(orig: str) -> str:
    return "".join(orig[i] for i in _MIXIN_KEY_ENC_TAB)[:32]


def sign_wbi(params: dict, img_key: str, sub_key: str) -> dict:
    """WBI 签名：过滤特殊字符 → 加 wts → 排序编码 → md5(query + mixin)。"""
    mk = mixin_key(img_key + sub_key)
    keep = str.maketrans("", "", _WBI_SAFE)
    signed = {k: str(v).translate(keep) for k, v in params.items() if v is not None}
    signed["wts"] = str(int(time.time()))
    query = urllib.parse.urlencode(sorted(signed.items()), quote_via=urllib.parse.quote)
    signed["w_rid"] = hashlib.md5((query + mk).encode("utf-8")).hexdigest()
    return signed


def key_from_url(url: str) -> str:
    """从 wbi_img.img_url 里抠出 key（文件名去掉扩展名）。"""
    name = str(url or "").rsplit("/", 1)[-1]
    return name.split(".")[0] if name else ""


def _cookie(name: str, value: str, domain: str = ".bilibili.com") -> http.cookiejar.Cookie:
    return http.cookiejar.Cookie(
        version=0, name=name, value=value, port=None, port_specified=False,
        domain=domain, domain_specified=True, domain_initial_dot=True,
        path="/", path_specified=True, secure=False, expires=None,
        discard=False, comment=None, comment_url=None, rest={}, rfc2109=False,
    )


class BiliClient:
    """一个极简但有登录态的 B 站客户端。线程不安全，单线程用。"""

    def __init__(self, cfg: Optional[dict] = None, data_dir: Optional[Path] = None,
                 timeout: float = 15.0) -> None:
        self.cfg = dict(cfg or {})
        self.timeout = float(self.cfg.get("timeout_s") or timeout)
        self.data_dir = Path(data_dir) if data_dir else Path.cwd() / "data"
        self.cookie_pairs: dict[str, str] = {}
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar))
        self._wbi_keys: tuple[str, str] = ("", "")
        self._wbi_ts = 0.0
        self._buvid_ready = False

    # ------------------------------------------------------------ 底层请求
    def request(self, url: str, method: str = "GET", params: Optional[dict] = None,
                data: Optional[dict] = None, headers: Optional[dict] = None,
                timeout: Optional[float] = None) -> tuple[int, str]:
        """发请求，返回 (HTTP 状态码, 响应文本)。网络层错误抛 BiliError。"""
        h = {
            "User-Agent": self.cfg.get("user_agent") or UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        if headers:
            h.update(headers)
        if params:
            qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            url = f"{url}{'&' if '?' in url else '?'}{qs}"
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
            h["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            with self._opener.open(req, timeout=timeout or self.timeout) as resp:
                return int(resp.status), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return int(e.code), e.read().decode("utf-8", "replace")
        except urllib.error.URLError as e:
            raise BiliError(f"网络错误：{e.reason}（{url.split('?')[0]}）") from e
        except TimeoutError as e:
            raise BiliError(f"请求超时：{url.split('?')[0]}") from e

    def get_json(self, url: str, params: Optional[dict] = None,
                 headers: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        status, text = self.request(url, params=params, headers=headers, timeout=timeout)
        return self._parse(status, text, url)

    def post_form(self, url: str, data: dict, headers: Optional[dict] = None,
                  timeout: Optional[float] = None) -> dict:
        status, text = self.request(url, method="POST", data=data,
                                    headers=headers, timeout=timeout)
        return self._parse(status, text, url)

    @staticmethod
    def _parse(status: int, text: str, url: str) -> dict:
        if status != 200:
            raise BiliError(f"HTTP {status}：{url.split('?')[0]}", code=status)
        try:
            body = json.loads(text)
        except ValueError as e:
            raise BiliError(f"返回非 JSON：{url.split('?')[0]}：{text[:120]}") from e
        if not isinstance(body, dict):
            raise BiliError(f"返回格式异常：{url.split('?')[0]}")
        return body

    # ------------------------------------------------------------ 登录态
    def add_cookie_pairs(self, pairs: dict[str, str]) -> int:
        n = 0
        for k, v in pairs.items():
            if k and v:
                self._jar.set_cookie(_cookie(str(k), str(v)))
                self.cookie_pairs[str(k)] = str(v)
                n += 1
        return n

    @property
    def has_login(self) -> bool:
        return bool(self.cookie_pairs.get("SESSDATA"))

    @property
    def csrf(self) -> str:
        return str(self.cookie_pairs.get("bili_jct") or "")

    def require_login(self) -> None:
        if not self.has_login:
            raise NotLoggedIn("没有登录态：请在 config.json 配 bili.cookie_file，"
                              "或设环境变量 BILI_COOKIE（SESSDATA=…; bili_jct=…）")
        if not self.csrf:
            raise NotLoggedIn("cookie 里缺 bili_jct（写操作必需）：重新扫码登录后再用")

    # ------------------------------------------------------------ 指纹 / WBI
    def ensure_buvid(self, allow_guest: bool = True, force: bool = False) -> None:
        """确保有 buvid3（直播分区列表/弹幕 token 缺它会被风控挡成 code=-352）。

        即使已登录也要补：登录 cookie 里通常不含 buvid3。
        """
        if not force and (self._buvid_ready or self.cookie_pairs.get("buvid3")):
            return
        self._buvid_ready = False
        cache = self.data_dir / "buvid.json"
        if not force:
            try:
                saved = json.loads(cache.read_text(encoding="utf-8"))
                if saved.get("b_3"):
                    self.add_cookie_pairs({"buvid3": saved["b_3"], "buvid4": saved.get("b_4") or ""})
                    self._buvid_ready = True
                    return
            except (OSError, ValueError):
                pass
        try:
            body = self.get_json(f"{API_PC}/x/frontend/finger/spi", timeout=6.0,
                                 headers={"Referer": "https://www.bilibili.com/"})
        except BiliError:
            if not allow_guest:
                raise
            return
        data = body.get("data") or {}
        if data.get("b_3"):
            self.add_cookie_pairs({"buvid3": str(data["b_3"])})
            if data.get("b_4"):
                self.add_cookie_pairs({"buvid4": str(data["b_4"])})
            self._buvid_ready = True
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps({"b_3": data.get("b_3"), "b_4": data.get("b_4"),
                                             "updated": time.time()}, ensure_ascii=False),
                                encoding="utf-8")
            except OSError:
                pass

    def wbi_keys(self, force: bool = False) -> tuple[str, str]:
        if not force and self._wbi_keys[0] and time.time() - self._wbi_ts < 3600:
            return self._wbi_keys
        try:
            body = self.get_json(f"{API_PC}/x/web-interface/nav", timeout=8.0)
        except BiliError:
            return self._wbi_keys
        wbi = ((body.get("data") or {}).get("wbi_img") or {})
        img = key_from_url(wbi.get("img_url") or "")
        sub = key_from_url(wbi.get("sub_url") or "")
        if img and sub:
            self._wbi_keys = (img, sub)
            self._wbi_ts = time.time()
        return self._wbi_keys

    # ------------------------------------------------------------ 业务接口
    def _site_headers(self, path: str, base: str, headers: Optional[dict]) -> dict:
        """按站点补 Referer/Origin：直播接口缺 Referer 也会被风控挡。"""
        h = dict(headers or {})
        if base == API_LIVE or path.startswith("/xlive"):
            h.setdefault("Referer", "https://live.bilibili.com/")
            h.setdefault("Origin", "https://live.bilibili.com")
        else:
            h.setdefault("Referer", "https://www.bilibili.com/")
        return h

    def api(self, path: str, params: Optional[dict] = None, *, base: str = API_PC,
            wbi: bool = False, headers: Optional[dict] = None,
            allow_guest: bool = True, timeout: Optional[float] = None,
            unwrap: bool = True) -> Any:
        """GET 一个 B 站接口：成功返回 data（unwrap=True）或整个 body。

        allow_guest=True 时 -101（未登录）不抛错，把 data 原样返回给调用方判断。
        -352 是 B 站风控（请求太密或缺指纹/签名）：刷新 buvid3 并退避后重试。
        """
        self.ensure_buvid()
        hdr = self._site_headers(path, base, headers)
        code = None
        for attempt in range(2):
            p = dict(params or {})
            if wbi:
                img, sub = self.wbi_keys()
                if img and sub:
                    p = sign_wbi(p, img, sub)
            url = path if path.startswith("http") else base + path
            body = self.get_json(url, params=p or None, headers=hdr, timeout=timeout)
            code = body.get("code")
            if code != -352 or attempt == 1:
                break
            self.ensure_buvid(force=True)
            time.sleep(2.0)
        if code not in (0, None) and not (allow_guest and int(code) in GUEST_CODES):
            hint = "（风控 -352：手工确认 wbi 签名/buvid3，或隔几分钟再试）" if code == -352 else ""
            raise BiliError(f"接口错误 code={code}：{body.get('message') or ''}"
                            f"{hint}（{path.split('?')[0]}）", code=int(code))
        return (body.get("data") or {}) if unwrap else body

    def api_post(self, path: str, data: dict, *, base: str = API_PC,
                 headers: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        url = path if path.startswith("http") else base + path
        body = self.post_form(url, data, headers=self._site_headers(path, base, headers),
                              timeout=timeout)
        code = body.get("code")
        if code not in (0, None):
            raise BiliError(f"接口错误 code={code}：{body.get('message') or ''}"
                            f"（{path.split('?')[0]}）", code=int(code))
        return body.get("data") or {}

    # ------------------------------------------------------------ 常用
    def nav(self) -> dict:
        """当前登录状态（未登录返回 isLogin=False，不抛错）。"""
        body = self.api("/x/web-interface/nav", allow_guest=True, unwrap=False)
        data = body.get("data") or {}
        return {
            "isLogin": bool(data.get("isLogin")),
            "uname": str(data.get("uname") or ""),
            "mid": int(data.get("mid") or 0),
            "vip": int(data.get("vipStatus") or 0),
        }
