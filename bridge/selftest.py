#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""bili_bridge.py 的自测：像宿主那样 spawn 桥进程，检查协议与数据。

原则
----
* 读动作全部真跑（需要有效 cookie）。
* 写动作**只跑 dryRun:true**，并断言响应里没有 "sent": true —— 这个脚本永远不会
  真的发评论/弹幕/私信/点赞/投币/收藏/关注。
* 每条都断言 stdout **恰好一行** 合法 JSON（宿主就是靠这一行取结果）。

用法
----
  python selftest.py                  # 只测读动作
  python selftest.py --writes         # 加写动作 dry-run
  python selftest.py --bad            # 加错参数用例
  python selftest.py --all            # 读 + 写 dry-run + 错参数
  python selftest.py --only search,video_info --show 2
  python selftest.py --json           # 只吐机器可读结果（供 CI / 别的 agent 用）

退出码：全过 0，有失败 1。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = str(HERE / "bili_bridge.py")
DEFAULT_COOKIE = ""
BV = "BV1GJ411x7h7"
UID = 0
FAV = 3244581855

# ---- 用例表：(名字, 请求, 检查项) ------------------------------------------
# 检查项 keys：must（必须存在的键路径，点在 dict 上）、eq（键路径 → 期望值）
READ_CASES: list[tuple[str, dict, dict]] = [
    ("ping", {"action": "ping", "args": {}},
     {"must": ["version", "python", "cookie_path", "loggedIn"]}),
    ("whoami", {"action": "whoami", "args": {}},
     {"must": ["isLogin", "uname", "mid"], "eq": {"isLogin": True}}),
    ("search", {"action": "search", "args": {"keyword": "DeepSeek", "limit": 3}},
     {"must": ["count", "videos"]}),
    ("video_info", {"action": "video_info", "args": {"bvid": BV}},
     {"must": ["bvid", "title", "up", "stat"], "eq": {"bvid": BV}}),
    ("video_comments", {"action": "video_comments", "args": {"bvid": BV, "limit": 3}},
     {"must": ["count", "comments"]}),
    ("video_danmaku", {"action": "video_danmaku", "args": {"bvid": BV, "limit": 5}},
     {"must": ["cid", "danmaku"]}),
    ("video_subtitle", {"action": "video_subtitle", "args": {"bvid": BV}},
     {"must": ["languages"]}),
    ("user_info", {"action": "user_info", "args": {"uid": UID}},
     {"must": ["name", "level", "fans", "following"]}),
    ("user_videos", {"action": "user_videos", "args": {"uid": UID, "limit": 3}},
     {"must": ["count", "videos"]}),
    ("user_dynamics", {"action": "user_dynamics", "args": {"uid": UID, "limit": 3}},
     {"must": ["count", "dynamics"]}),
    ("following", {"action": "following", "args": {"limit": 3}},
     {"must": ["count", "following"]}),
    ("favorites", {"action": "favorites", "args": {}},
     {"must": ["count", "folders"]}),
    ("favorite_content", {"action": "favorite_content", "args": {"mediaId": FAV, "limit": 5}},
     {"must": ["count", "medias"]}),
    ("hot", {"action": "hot", "args": {"limit": 3}}, {"must": ["count", "videos"]}),
    ("rank", {"action": "rank", "args": {"limit": 3}}, {"must": ["count", "videos"]}),
    ("weekly", {"action": "weekly", "args": {"limit": 3}},
     {"must": ["number", "count", "videos"]}),
    ("live_room(roomId)", {"action": "live_room", "args": {"roomId": 1}},
     {"must": ["roomId"]}),
    ("live_room(mid)", {"action": "live_room", "args": {"mid": UID}},
     {"must": ["roomId"]}),
    ("live_roam", {"action": "live_roam", "args": {"area": "虚拟", "limit": 5}},
     {"must": ["count", "rooms"]}),
    ("live_online", {"action": "live_online", "args": {"roomId": 1}},
     {"must": ["roomId"]}),
    ("messages_unread", {"action": "messages_unread", "args": {}},
     {"must": ["totalAll"]}),
    ("messages_replies", {"action": "messages_replies", "args": {"limit": 3}},
     {"must": ["count", "items"]}),
    ("messages_at", {"action": "messages_at", "args": {"limit": 3}},
     {"must": ["count", "items"]}),
    ("relation_status", {"action": "relation_status", "args": {"bvid": BV}},
     {"must": ["hasLiked", "hasFav", "hasCoin", "followingUp"]}),
]

# ---- 写动作：全部 dryRun:true，一条真请求都不许发 --------------------------
WRITE_DRY_CASES: list[dict] = [
    {"action": "comment_add", "args": {"bvid": BV, "text": "自测 dry-run", "dryRun": True}},
    {"action": "comment_add", "args": {"bvid": BV, "text": "回复 dry-run", "root": 1, "parent": 2, "dryRun": True}},
    {"action": "like", "args": {"bvid": BV, "like": True, "dryRun": True}},
    {"action": "like", "args": {"bvid": BV, "like": False, "dryRun": True}},
    {"action": "coin", "args": {"bvid": BV, "num": 1, "dryRun": True}},
    {"action": "favorite", "args": {"bvid": BV, "addFolderId": FAV, "dryRun": True}},
    {"action": "triple", "args": {"bvid": BV, "folderId": FAV, "dryRun": True}},
    {"action": "triple", "args": {"bvid": BV, "dryRun": True}},
    {"action": "follow", "args": {"uid": UID, "action": "follow", "dryRun": True}},
    {"action": "follow", "args": {"uid": UID, "action": "unfollow", "dryRun": True}},
    {"action": "danmaku_send", "args": {"bvid": BV, "text": "自测弹幕", "time": 5, "dryRun": True}},
    {"action": "live_danmaku", "args": {"roomId": 1, "text": "自测直播弹幕", "dryRun": True}},
    {"action": "dm_send", "args": {"uid": 7173021, "text": "自测私信", "dryRun": True}},
    {"action": "dynamic_post", "args": {"text": "自测动态", "dryRun": True}},
]

# ---- 错参数：必须 ok:false，且错误文案里带上关键词 --------------------------
BAD_CASES: list[tuple[str, dict, str]] = [
    ("search 空词", {"action": "search", "args": {"keyword": ""}}, "keyword"),
    ("video_info 坏 BV", {"action": "video_info", "args": {"bvid": "abc"}}, "BV"),
    ("favorite_content 缺 mediaId", {"action": "favorite_content", "args": {}}, "mediaId"),
    ("comment_add 缺 text", {"action": "comment_add", "args": {"bvid": BV, "dryRun": True}}, "text"),
    ("danmaku_send 空 text", {"action": "danmaku_send", "args": {"bvid": BV, "text": "  ", "dryRun": True}}, "text"),
    ("live_online 缺 roomId", {"action": "live_online", "args": {}}, "roomId"),
    ("coin 币数越界", {"action": "coin", "args": {"bvid": BV, "num": 3, "dryRun": True}}, "num"),
    ("未知 action", {"action": "no_such_action", "args": {}}, "action"),
]


def run_bridge(payload: dict, cookie: str, timeout: float = 120.0) -> dict:
    """spawn 一次桥，返回 {ok_line, resp, elapsed, nlines, size}。"""
    cmd = [sys.executable, BRIDGE]
    if cookie:
        cmd += ["--cookie", cookie]
    cmd.append(json.dumps(payload, ensure_ascii=False))
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    elapsed = time.time() - t0
    out = proc.stdout.decode("utf-8", "replace")
    lines = [ln for ln in out.splitlines() if ln.strip()]
    err = proc.stderr.decode("utf-8", "replace").strip()
    resp = None
    if len(lines) == 1:
        try:
            resp = json.loads(lines[0])
        except json.JSONDecodeError:
            resp = None
    return {"resp": resp, "nlines": len(lines), "elapsed": elapsed,
            "size": len(lines[0].encode("utf-8")) if lines else 0,
            "stderr": err, "raw": lines[0] if lines else "",
            "returncode": proc.returncode}


def _get(node, path: str):
    cur = node
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return (False, None)
        cur = cur[part]
    return (True, cur)


def check_shape(action: str, resp: dict | None, nlines: int) -> list[str]:
    """协议层面的硬检查：单行、JSON、ok/data/error/code 结构。"""
    bad = []
    if nlines != 1:
        bad.append(f"stdout 有 {nlines} 行（必须恰好 1 行）")
    if not isinstance(resp, dict):
        bad.append("最后一行不是合法 JSON 对象")
        return bad
    if resp.get("action") != action:
        bad.append(f"action 回显不符：{resp.get('action')!r} != {action!r}")
    if "ok" not in resp:
        bad.append("缺 ok 字段")
    elif resp["ok"] is True:
        if "data" not in resp:
            bad.append("ok:true 但缺 data")
    else:
        if not resp.get("error"):
            bad.append("ok:false 但缺 error")
        if "code" not in resp:
            bad.append("ok:false 但缺 code 字段")
    return bad


def check_expect(resp: dict | None, expect: dict) -> list[str]:
    bad = []
    if not isinstance(resp, dict) or resp.get("ok") is not True:
        return bad
    data = resp.get("data") or {}
    for path in expect.get("must", []):
        found, _ = _get(data, path)
        if not found:
            bad.append(f"data 里缺 {path}")
    for path, want in (expect.get("eq") or {}).items():
        found, got = _get(data, path)
        if not found or got != want:
            bad.append(f"data.{path} = {got!r}，期望 {want!r}")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser(description="bili_bridge.py 自测（写操作只 dry-run）")
    ap.add_argument("--cookie", default=os.environ.get("FEIYU_COOKIE_FILE") or DEFAULT_COOKIE)
    ap.add_argument("--only", default="", help="只跑名字包含这些子串的用例（逗号分隔）")
    ap.add_argument("--writes", action="store_true", help="加上写动作 dry-run 用例")
    ap.add_argument("--bad", action="store_true", help="加上错参数用例")
    ap.add_argument("--all", action="store_true", help="读 + 写 dry-run + 错参数")
    ap.add_argument("--show", type=int, default=0, help="打印前 N 条原始输出（截断）")
    ap.add_argument("--json", action="store_true", help="只输出 JSON 结果")
    ap.add_argument("--timeout", type=float, default=120.0)
    args = ap.parse_args()

    do_writes = args.writes or args.all
    do_bad = args.bad or args.all
    only = [x.strip() for x in args.only.split(",") if x.strip()]

    def wanted(name: str) -> bool:
        return not only or any(k in name for k in only)

    cases: list[tuple[str, dict, dict, str]] = []  # (name, payload, expect, kind)
    for name, payload, expect in READ_CASES:
        if wanted(name):
            cases.append((name, payload, expect, "read"))
    if do_writes:
        for payload in WRITE_DRY_CASES:
            name = f"dry:{payload['action']}"
            if wanted(name):
                cases.append((name, payload, {"dry": True}, "write-dry"))
    if do_bad:
        for name, payload, keyword in BAD_CASES:
            name = f"bad:{name}"
            if wanted(name):
                cases.append((name, payload, {"keyword": keyword}, "bad"))

    rows, failed, shown = [], 0, 0
    for name, payload, expect, kind in cases:
        try:
            r = run_bridge(payload, args.cookie, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            rows.append((name, "TIMEOUT", args.timeout * 1000, 0, "桥超时没返回"))
            failed += 1
            continue
        resp = r["resp"]
        problems = check_shape(payload["action"], resp, r["nlines"])
        if r["stderr"]:
            problems.append(f"stderr 非空：{r['stderr'][:120]}")
        if resp is None:
            rows.append((name, "BADJSON", r["elapsed"] * 1000, r["size"],
                         "; ".join(problems)))
            failed += 1
            if shown < args.show:
                shown += 1
                print(f"\n--- {name} 原始输出 ---\n{r['raw'][:600]}")
            continue

        if kind == "read":
            problems += check_expect(resp, expect)
            if resp.get("ok") is not True:
                problems.append(f"读动作失败了：{resp.get('error')}")
        elif kind == "write-dry":
            data = resp.get("data") or {}
            if resp.get("ok") is not True:
                problems.append(f"dry-run 失败了：{resp.get('error')}")
            else:
                if data.get("dryRun") is not True:
                    problems.append("dry-run 响应里 dryRun 不是 true")
                if data.get("sent") is True or "sent" in json.dumps(data):
                    problems.append("⚠️ 响应里出现了 sent（可能真发了！）")
                if data.get("endpoint") is None:
                    problems.append("dry-run 响应里没有 endpoint")
        elif kind == "bad":
            if resp.get("ok") is not False:
                problems.append("错参数居然 ok:true")
            else:
                msg = f"{resp.get('error')} {resp.get('code')}"
                if expect["keyword"] not in msg:
                    problems.append(f"错误文案里没有 {expect['keyword']!r}：{msg[:100]}")

        ok = not problems
        failed += 0 if ok else 1
        rows.append((name, "ok" if ok else "FAIL", r["elapsed"] * 1000, r["size"],
                     "; ".join(problems)))
        if not ok and shown < args.show:
            shown += 1
            print(f"\n--- {name} 原始输出 ---\n{r['raw'][:600]}")

    if args.json:
        print(json.dumps({"passed": len(rows) - failed, "failed": failed,
                          "rows": [{"name": n, "status": s, "ms": round(ms),
                                    "bytes": b, "problems": p}
                                   for n, s, ms, b, p in rows]},
                         ensure_ascii=False, indent=2))
        return 0 if failed == 0 else 1

    print(f"\n{'用例':<34}{'结果':>7}{'毫秒':>9}{'字节':>8}  说明")
    print("-" * 78)
    for name, status, ms, size, problems in rows:
        flag = "✓" if status == "ok" else "✗"
        print(f"{name:<32}{flag} {status:<5}{ms:>8.0f}{size:>8}"
              + (f"  {problems}" if problems else ""))
    total_ms = sum(r[2] for r in rows)
    print("-" * 78)
    print(f"共 {len(rows)} 条：通过 {len(rows) - failed}，失败 {failed}，"
          f"总耗 {total_ms / 1000:.1f}s")
    if failed == 0 and do_writes:
        print("提示：写动作全部是 dryRun:true，没有发出任何真实写请求。")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
