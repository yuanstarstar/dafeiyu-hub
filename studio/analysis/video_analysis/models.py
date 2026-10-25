# -*- coding: utf-8 -*-
"""共享数据结构（Lead 维护，改动需同步 CONTRACT.md 并通知全员）。"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any, Optional


def _d(o: Any) -> Any:
    if isinstance(o, list):
        return [_d(x) for x in o]
    if hasattr(o, "to_dict"):
        return o.to_dict()
    if hasattr(o, "__dataclass_fields__"):
        return {k: _d(v) for k, v in asdict(o).items()}
    return o


# ------------------------------------------------------------------ 台词/讲稿
@dataclass
class Line:
    text: str
    preset: str = "吐槽"          # 撒欢/嘴硬/撒娇/摆烂/吐槽/客服腔
    pitch: int = 2
    rate: int = 0


@dataclass
class Beat:
    id: str
    t0: float                      # 对应视频时间窗 [t0, t1)
    t1: float
    shot: str = ""                 # 这一段的画面/事件描述（给观众看要点卡片）
    lines: list[Line] = field(default_factory=list)
    cue: str = "讲解"              # 讲解/互动/悬念/吐槽
    interactive: bool = False      # True = 这段留空档给弹幕


@dataclass
class Script:
    video_id: str
    title: str = ""
    duration: float = 0.0
    beats: list[Beat] = field(default_factory=list)
    qa_hooks: list[dict] = field(default_factory=list)
    source: str = "template"       # template / manual / llm
    created_at: float = field(default_factory=time.time)


# ------------------------------------------------------------------ 视频分析
@dataclass
class AnalysisSegment:
    t0: float
    t1: float
    summary: str
    visual_notes: str = ""


@dataclass
class Analysis:
    video_id: str
    duration: float = 0.0
    segments: list[AnalysisSegment] = field(default_factory=list)
    transcript: list[dict] = field(default_factory=list)   # [{t, text}]
    qa: list[dict] = field(default_factory=list)           # [{q, a}]
    cost_cny: float = 0.0
    model: str = ""
    status: str = "pending"        # pending/running/done/failed
    error: str = ""
    created_at: float = field(default_factory=time.time)


# ------------------------------------------------------------------ 视频条目
@dataclass
class VideoItem:
    id: str
    path: str
    title: str = ""
    duration: float = 0.0
    status: str = "new"            # new/analyzing/analyzed/ready
    analysis: Optional[Analysis] = None
    script: Optional[Script] = None
    # --- B 站「刷视频」来源字段（本地视频保持 local/空） ---
    source: str = "local"          # local / bili
    bvid: str = ""
    cover: str = ""
    owner: str = ""
    desc: str = ""
    page_url: str = ""
    stat: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "id": self.id, "path": self.path, "title": self.title,
            "duration": self.duration, "status": self.status,
            "analysis": None, "script": None,
            "source": self.source, "bvid": self.bvid, "cover": self.cover,
            "owner": self.owner, "desc": self.desc, "page_url": self.page_url,
            "stat": dict(self.stat or {}),
        }
        if self.analysis:
            d["analysis"] = self.analysis.to_dict()
        if self.script:
            d["script"] = self.script.to_dict()
        return d


# ------------------------------------------------------------------ 弹幕
@dataclass
class Danmaku:
    id: str
    uid: str
    uname: str
    text: str
    kind: str = "danmu"            # danmu/sc/gift/guard/enter/like
    price: float = 0.0
    ts: float = field(default_factory=time.time)
    reply: str = ""                # 大肥鱼对它的回应（若有）
    reply_ts: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id, "uid": self.uid, "uname": self.uname, "text": self.text,
            "kind": self.kind, "price": self.price, "ts": self.ts,
            "reply": self.reply, "reply_ts": self.reply_ts,
        }


# 统一把 dataclass 转 dict 的辅助
def as_json(obj: Any) -> Any:
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [as_json(x) for x in obj]
    if isinstance(obj, dict):
        return {k: as_json(v) for k, v in obj.items()}
    if hasattr(obj, "to_dict"):
        return as_json(obj.to_dict())
    if hasattr(obj, "__dataclass_fields__"):
        return {k: as_json(v) for k, v in asdict(obj).items()}
    return obj


# dataclass 缺 to_dict：统一挂上
for _cls in (Line, Beat, Script, AnalysisSegment, Analysis):
    if not hasattr(_cls, "to_dict"):
        _cls.to_dict = lambda self: {k: as_json(v) for k, v in asdict(self).items()}
