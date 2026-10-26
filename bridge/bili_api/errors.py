# -*- coding: utf-8 -*-
"""统一异常类型。"""


class BiliError(RuntimeError):
    """B 站接口/网络/登录态错误（可读的中文消息，调用方直接展示）。"""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class NotLoggedIn(BiliError):
    """需要登录态（SESSDATA / bili_jct）但本地 cookie 里没有。"""


class WriteBlocked(BiliError):
    """写操作被总闸挡住：config.json 的 bili.allow_write 为 false（默认「先不用」）。"""
