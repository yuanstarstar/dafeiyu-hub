# -*- coding: utf-8 -*-
"""bili_api：B 站直播 / 评论 / 视频接口（纯标准库）。

快速开始：
    from bili_api import BiliClient, load_cookie
    from bili_api import live, comments, video

    c = BiliClient(cfg={"allow_write": False})
    print(load_cookie(c))
    print(live.room(c, room_id=1822156050))
    print(comments.video_replies(c, video.bvid_to_aid(c, "BV1xx...")))

写操作（发弹幕 / 发评论 / 点赞）默认被 bili.allow_write=false 挡住，
对应「先不用」：接口写好了、闸关着，要用时改配置。
"""
from .client import BiliClient, sign_wbi, mixin_key
from .auth import load_cookie, parse_cookie_text, find_cookie_source
from .errors import BiliError, NotLoggedIn, WriteBlocked
from . import live, comments, video

__all__ = [
    "BiliClient", "load_cookie", "parse_cookie_text", "find_cookie_source",
    "BiliError", "NotLoggedIn", "WriteBlocked",
    "sign_wbi", "mixin_key", "live", "comments", "video",
]
