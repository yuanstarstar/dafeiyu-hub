#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""大肥鱼工作室 · B 站投稿上传脚本

由总控台（lib/studio.js 的 executePublish）在人类批准后调用，
只负责把已经生成好的 mp4 + 封面 jpg + meta json 提交到 B 站，
不生成视频、不改配置、不碰其它文件。

用法：
    python upload.py --video x.mp4 --cover x.jpg --meta x.json \
        --cookie bili_cookie.json [--dry-run] [--line bda2] [--confirm]

输出约定（供 studio.js 的 pickJson 解析）：
    - 日志一律写 stderr；
    - stdout 的最后一行（也是唯一一行）是 JSON；
    - 成功：{"ok": true, "dryRun": true/false, ...}，退出码 0；
    - 校验失败：{"ok": false, "error": "...", "code": "..."}，退出码 2；
    - 真实上传失败：同上，退出码 1。

安全约定：
    - 不打印任何 cookie / 凭据值，dry-run 的 payload 里只给「字段是否齐全」；
    - 不加 --dry-run 才会真正调用 bilibili_api 上传。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# bilibili_api 17.4.2 的限制（见 video_uploader.py 源码）
MAX_TITLE_LEN = 80
MAX_DESC_LEN = 2000
MAX_TAGS = 10
MAX_TAG_LEN = 20
MAX_DYNAMIC_LEN = 233

AI_NOTE = "本视频由 AI 辅助生成并发布。"
COOKIE_REQUIRED = ("SESSDATA", "bili_jct", "DedeUserID")
COOKIE_OPTIONAL = ("buvid3", "buvid4")
COVER_SUFFIXES = (".jpg", ".jpeg", ".png")


class UploadError(Exception):
    """带错误码和退出码的可预期失败。"""

    def __init__(self, code: str, message: str, exit_code: int = 2):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


class JsonArgumentParser(argparse.ArgumentParser):
    """argparse 默认的 error() 会直接退出且不输出 JSON，这里改成抛异常。"""

    def error(self, message: str):  # type: ignore[override]
        raise UploadError("BAD_ARGS", f"参数错误：{message}", 2)


def configure_stdio() -> None:
    """不依赖控制台编码：统一 UTF-8，坏字符替换掉而不是崩掉。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def log(message: str) -> None:
    """日志走 stderr，保证 stdout 最后一行永远是 JSON。"""
    print(f"[upload] {message}", file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    """输出唯一一行结果 JSON（ensure_ascii=False，UTF-8）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = JsonArgumentParser(
        prog="upload.py",
        description="大肥鱼工作室 B 站投稿上传脚本（默认只校验，--dry-run 不会联网）",
    )
    parser.add_argument("--video", required=True, help="mp4 视频路径")
    parser.add_argument("--cover", required=True, help="封面 jpg/png 路径")
    parser.add_argument("--meta", required=True, help="meta json 路径")
    parser.add_argument("--cookie", required=True, help="B 站 cookie json 路径")
    parser.add_argument("--dry-run", action="store_true", help="只校验并打印将要提交的 payload，不上传")
    parser.add_argument(
        "--line",
        default=None,
        help="上传线路（bda2 / bldsa / qn / ws，或 auto 自动测速）",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="总控台审批通过后的显式确认标记（与 --dry-run 互不影响）",
    )
    return parser.parse_args(argv)


def load_json(path: Path, code: str, label: str) -> Dict[str, Any]:
    if not path.exists():
        raise UploadError(code, f"{label}不存在：{path}")
    if not path.is_file():
        raise UploadError(code, f"{label}不是文件：{path}")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise UploadError(code, f"{label}读取失败：{exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise UploadError(code, f"{label}不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise UploadError(code, f"{label}必须是 JSON 对象")
    return data


def stat_file(raw: str, code: str, label: str) -> Tuple[Path, int]:
    path = Path(raw).expanduser()
    if not path.exists():
        raise UploadError(code, f"{label}不存在：{path}")
    if not path.is_file():
        raise UploadError(code, f"{label}不是文件：{path}")
    try:
        size = path.stat().st_size
        resolved = path.resolve()
    except OSError as exc:
        raise UploadError(code, f"{label}无法读取：{exc}") from exc
    if size <= 0:
        raise UploadError(code, f"{label}是空文件：{resolved}")
    return resolved, size


def sniff_cover(path: Path) -> str:
    """B 站封面只接受 JPEG / PNG，dry-run 阶段先看魔数，不联网。"""
    try:
        with path.open("rb") as fp:
            head = fp.read(12)
    except OSError as exc:
        raise UploadError("BAD_COVER", f"封面读取失败：{exc}") from exc
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    raise UploadError("BAD_COVER", f"封面必须是 JPEG 或 PNG：{path}")


def normalize_meta(data: Dict[str, Any]) -> Dict[str, Any]:
    """按契约校验并归一化 meta，返回可直接落 payload 的字段。"""

    title = data.get("title")
    if not isinstance(title, str):
        raise UploadError("META_INVALID", "meta.title 必须是字符串")
    title = title.strip()
    if not title:
        raise UploadError("TITLE_EMPTY", "标题不能为空")
    if len(title) > MAX_TITLE_LEN:
        raise UploadError("TITLE_TOO_LONG", f"标题最多 {MAX_TITLE_LEN} 字，当前 {len(title)} 字")

    desc = data.get("desc")
    if desc is None:
        desc = ""
    if not isinstance(desc, str):
        raise UploadError("META_INVALID", "meta.desc 必须是字符串")
    desc = desc.strip()

    declare_ai = data.get("declareAI", False)
    if not isinstance(declare_ai, bool):
        raise UploadError("META_INVALID", "meta.declareAI 必须是布尔值")
    ai_appended = False
    if declare_ai and AI_NOTE not in desc:
        desc = f"{desc}\n{AI_NOTE}" if desc else AI_NOTE
        ai_appended = True

    if not desc:
        raise UploadError("DESC_EMPTY", "简介不能为空（declareAI 为 true 时会自动补 AI 声明）")
    if len(desc) > MAX_DESC_LEN:
        raise UploadError(
            "DESC_TOO_LONG",
            f"简介最多 {MAX_DESC_LEN} 字（含 AI 声明），当前 {len(desc)} 字",
        )

    raw_tags = data.get("tags")
    if isinstance(raw_tags, str):
        # 容忍 "a,b" 写法，但契约是数组
        raw_tags = raw_tags.split(",")
    if not isinstance(raw_tags, list):
        raise UploadError("TAGS_INVALID", "meta.tags 必须是字符串数组")
    if len(raw_tags) > MAX_TAGS:
        raise UploadError("TAGS_COUNT", f"标签最多 {MAX_TAGS} 个，当前 {len(raw_tags)} 个")
    tags: List[str] = []
    for item in raw_tags:
        if not isinstance(item, str):
            raise UploadError("TAGS_INVALID", "meta.tags 里每一项都必须是字符串")
        tag = item.strip()
        if not tag:
            raise UploadError("TAG_EMPTY", "标签不能为空字符串")
        if len(tag) > MAX_TAG_LEN:
            raise UploadError("TAG_TOO_LONG", f"标签「{tag}」超过 {MAX_TAG_LEN} 字")
        tags.append(tag)
    if not tags:
        raise UploadError("TAGS_COUNT", "至少需要 1 个标签")
    uniq: List[str] = []
    for tag in tags:
        if tag not in uniq:
            uniq.append(tag)
    if len(uniq) != len(tags):
        log(f"标签有重复，已去重：{len(tags)} -> {len(uniq)}")
    tags = uniq

    tid = data.get("tid")
    if isinstance(tid, bool) or not isinstance(tid, int):
        raise UploadError("TID_INVALID", "meta.tid 必须是整数分区 id")
    if tid <= 0:
        raise UploadError("TID_INVALID", f"meta.tid 不是合法分区 id：{tid}")

    dynamic = data.get("dynamic")
    if dynamic is not None and not isinstance(dynamic, str):
        raise UploadError("DYNAMIC_INVALID", "meta.dynamic 必须是字符串或不填")
    if isinstance(dynamic, str):
        dynamic = dynamic.strip() or None
    if dynamic is not None and len(dynamic) > MAX_DYNAMIC_LEN:
        # 库遇到超长 dynamic 会静默丢弃，这里必须显式报错
        raise UploadError(
            "DYNAMIC_TOO_LONG",
            f"动态最多 {MAX_DYNAMIC_LEN} 字，当前 {len(dynamic)} 字",
        )

    return {
        "title": title,
        "desc": desc,
        "tags": tags,
        "tid": tid,
        "dynamic": dynamic,
        "declareAI": declare_ai,
        "aiNoteAppended": ai_appended,
    }


def load_cookie(path: Path) -> Dict[str, str]:
    """读 cookie，只做必填校验；缺 buvid3/buvid4 时由库自动获取，不打印任何值。"""
    data = load_json(path, "BAD_COOKIE", "cookie")
    if isinstance(data.get("cookies"), dict):
        data = data["cookies"]
    fields: Dict[str, str] = {}
    for name in COOKIE_REQUIRED + COOKIE_OPTIONAL:
        value = data.get(name)
        fields[name] = value.strip() if isinstance(value, str) else ""
    missing = [name for name in COOKIE_REQUIRED if not fields[name]]
    if missing:
        raise UploadError("BAD_COOKIE", f"cookie 缺少字段：{', '.join(missing)}")
    if not fields["DedeUserID"].isdigit():
        raise UploadError("BAD_COOKIE", "cookie 里的 DedeUserID 不是数字")
    absent = [name for name in COOKIE_OPTIONAL if not fields[name]]
    if absent:
        log(f"cookie 缺少 {', '.join(absent)}，上传时由 bilibili_api 自动获取")
    return fields


def resolve_line(raw: Optional[str], lines_enum):
    """把 --line 映射到 bilibili_api.video_uploader.Lines；空/auto 表示自动测速。"""
    if raw is None:
        return None
    value = str(raw).strip().lower()
    if not value or value in ("auto", "none"):
        return None
    valid = [item.value for item in lines_enum]
    if value not in valid:
        raise UploadError(
            "BAD_LINE",
            f"未知线路 {raw}，可选：{', '.join(valid)}（或 auto）",
        )
    return lines_enum(value)


def load_lib():
    """延迟导入，--help 不依赖 venv 里的库。"""
    try:
        from bilibili_api import Credential
        from bilibili_api.video_uploader import (
            Lines,
            VideoMeta,
            VideoUploader,
            VideoUploaderEvents,
            VideoUploaderPage,
        )
    except Exception as exc:  # ImportError / 依赖损坏
        raise UploadError(
            "LIB_IMPORT_FAILED",
            f"无法导入 bilibili_api：{type(exc).__name__}: {exc}",
            2,
        ) from exc
    return {
        "Credential": Credential,
        "Lines": Lines,
        "VideoMeta": VideoMeta,
        "VideoUploader": VideoUploader,
        "VideoUploaderEvents": VideoUploaderEvents,
        "VideoUploaderPage": VideoUploaderPage,
    }


def build_objects(
    lib: Dict[str, Any],
    video_path: Path,
    cover_path: Path,
    meta: Dict[str, Any],
):
    """构造 VideoMeta / VideoUploaderPage，dry-run 也走这里以复用库的本地校验。"""
    try:
        meta_obj = lib["VideoMeta"](
            tid=meta["tid"],
            title=meta["title"],
            desc=meta["desc"],
            cover=str(cover_path),
            tags=meta["tags"],
            dynamic=meta["dynamic"],
        )
    except ValueError as exc:
        raise UploadError("META_INVALID", f"VideoMeta 校验失败：{exc}") from exc
    except OSError as exc:
        raise UploadError("BAD_COVER", f"封面读取失败：{exc}") from exc
    except Exception as exc:
        raise UploadError(
            "BAD_COVER",
            f"封面无法解析（需要可读的 JPEG/PNG）：{type(exc).__name__}: {exc}",
        ) from exc

    page = lib["VideoUploaderPage"](
        path=str(video_path),
        title=meta["title"],
        description=meta["desc"],
    )
    return meta_obj, page


def build_credential(lib: Dict[str, Any], cookie: Dict[str, str]):
    def value(name: str) -> Optional[str]:
        return cookie.get(name) or None

    # bilibili_api 17.4.2 没有 Credential.from_cookie 之类的构造器，直接传字段；
    # buvid3/buvid4 允许 None，上传时 get_buvid_cookies() 会自动补。
    return lib["Credential"](
        sessdata=value("SESSDATA"),
        bili_jct=value("bili_jct"),
        buvid3=value("buvid3"),
        buvid4=value("buvid4"),
        dedeuserid=value("DedeUserID"),
    )


def make_payload(
    video_path: Path,
    video_size: int,
    cover_path: Path,
    cover_size: int,
    cover_format: str,
    meta: Dict[str, Any],
    line: Optional[Any],
    cookie: Dict[str, str],
) -> Dict[str, Any]:
    return {
        "video": str(video_path),
        "videoBytes": video_size,
        "cover": str(cover_path),
        "coverBytes": cover_size,
        "coverFormat": cover_format,
        "title": meta["title"],
        "desc": meta["desc"],
        "tags": meta["tags"],
        "tid": meta["tid"],
        "dynamic": meta["dynamic"],
        "declareAI": meta["declareAI"],
        "aiNoteAppended": meta["aiNoteAppended"],
        "copyright": 1,
        "pages": [
            {"title": meta["title"], "description": meta["desc"]},
        ],
        "line": getattr(line, "value", "auto") if line is not None else "auto",
        # 只报字段是否齐全，绝不输出 cookie 值
        "credential": {
            "sessdata": bool(cookie.get("SESSDATA")),
            "bili_jct": bool(cookie.get("bili_jct")),
            "dedeuserid": bool(cookie.get("DedeUserID")),
            "buvid3": bool(cookie.get("buvid3")),
            "buvid4": bool(cookie.get("buvid4")),
        },
    }


def attach_progress(uploader, events) -> None:
    """把关键事件打到 stderr，真实上传时能看出卡在哪一步。"""
    messages = {
        events.PREUPLOAD.value: "准备上传分P",
        events.AFTER_PAGE.value: "分P上传完成",
        events.AFTER_COVER.value: "封面上传完成",
        events.AFTER_SUBMIT.value: "投稿提交完成",
        events.COMPLETED.value: "上传完成",
        events.PREUPLOAD_FAILED.value: "获取上传信息失败",
        events.COVER_FAILED.value: "封面上传失败",
        events.SUBMIT_FAILED.value: "投稿提交失败",
    }

    def make_handler(message: str):
        def _on(data=None):
            if message == "准备上传分P":
                page = data.get("page") if isinstance(data, dict) else None
                log(f"{message}：{getattr(page, 'title', '')}")
            else:
                log(message)

        return _on

    for name, message in messages.items():
        try:
            uploader.add_event_listener(name, make_handler(message))
        except Exception:
            # 进度日志不是关键路径，挂不上就算了
            pass


def run_dry(args: argparse.Namespace) -> int:
    video_path, video_size = stat_file(args.video, "VIDEO_NOT_FOUND", "视频")
    if video_path.suffix.lower() != ".mp4":
        log(f"提示：视频后缀是 {video_path.suffix or '(无)'}，B 站一般要求 mp4")
    cover_path, cover_size = stat_file(args.cover, "COVER_NOT_FOUND", "封面")
    if cover_path.suffix.lower() not in COVER_SUFFIXES:
        log(f"提示：封面后缀是 {cover_path.suffix or '(无)'}，B 站一般要求 jpg/png")
    cover_format = sniff_cover(cover_path)
    meta = normalize_meta(load_json(Path(args.meta), "BAD_META", "meta"))
    cookie = load_cookie(Path(args.cookie))

    lib = load_lib()
    line = resolve_line(args.line, lib["Lines"])
    build_objects(lib, video_path, cover_path, meta)  # 复用库的本地校验
    build_credential(lib, cookie)

    payload = make_payload(
        video_path, video_size, cover_path, cover_size, cover_format, meta, line, cookie
    )
    log(f"dry-run 通过：{payload['title']}（{len(payload['tags'])} 个标签，tid={payload['tid']}）")
    emit({"ok": True, "dryRun": True, "payload": payload})
    return 0


def _error_code(exc: BaseException) -> str:
    name = type(exc).__name__
    if name == "ApiException":
        return "API_ERROR"
    if name == "NetworkException":
        return "NETWORK_ERROR"
    if name in ("FileNotFoundError", "PermissionError"):
        return "FILE_ERROR"
    return "UPLOAD_FAILED"


def run_real(args: argparse.Namespace) -> int:
    video_path, _ = stat_file(args.video, "VIDEO_NOT_FOUND", "视频")
    cover_path, _ = stat_file(args.cover, "COVER_NOT_FOUND", "封面")
    sniff_cover(cover_path)
    meta = normalize_meta(load_json(Path(args.meta), "BAD_META", "meta"))
    cookie = load_cookie(Path(args.cookie))

    lib = load_lib()
    line = resolve_line(args.line, lib["Lines"])
    meta_obj, page = build_objects(lib, video_path, cover_path, meta)
    credential = build_credential(lib, cookie)

    uploader = lib["VideoUploader"](
        pages=[page],
        meta=meta_obj,
        credential=credential,
        cover=str(cover_path),
        line=line,
    )
    attach_progress(uploader, lib["VideoUploaderEvents"])

    log(f"开始真实上传：{meta['title']} -> {video_path.name}（{meta['tid']} 区）")
    if args.confirm:
        log("已收到 --confirm（总控台审批确认）")
    try:
        result = asyncio.run(uploader.start())
    except KeyboardInterrupt:
        raise UploadError("INTERRUPTED", "上传被中断", 1) from None
    except Exception as exc:
        code = _error_code(exc)
        message = f"上传失败：{type(exc).__name__}: {exc}"
        raise UploadError(code, message[:2000], 1) from exc

    if not isinstance(result, dict):
        raise UploadError("UPLOAD_RESULT", f"投稿返回格式异常：{type(result).__name__}", 1)
    bvid = result.get("bvid")
    aid = result.get("aid")
    if not bvid:
        raise UploadError("UPLOAD_RESULT", f"投稿返回里没有 bvid：{result}", 1)
    emit({"ok": True, "dryRun": False, "bvid": str(bvid), "aid": aid})
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    configure_stdio()
    dry_mode = False
    try:
        args = parse_args(argv)
        dry_mode = bool(args.dry_run)
        if args.dry_run:
            return run_dry(args)
        return run_real(args)
    except UploadError as exc:
        log(f"失败[{exc.code}] {exc.message}")
        emit({"ok": False, "error": exc.message, "code": exc.code})
        return exc.exit_code
    except KeyboardInterrupt:
        emit({"ok": False, "error": "被中断", "code": "INTERRUPTED"})
        return 1
    except Exception as exc:  # 兜底：保证最后一行仍是 JSON
        message = f"未预期错误：{type(exc).__name__}: {exc}"
        log(message)
        emit({"ok": False, "error": message, "code": "INTERNAL"})
        return 2 if dry_mode else 1


if __name__ == "__main__":
    raise SystemExit(main())
