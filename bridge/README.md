# 大肥鱼 B 站桥（bili_bridge.py）

给 DSH 插件「大肥鱼」用的 B 站桥。宿主 spawn 一个 Python 进程 → 传一行 JSON → 读回一行 JSON。
**纯标准库**；HTTP / WBI 签名 / cookie 载入 / buvid / 直播 / 评论 / 视频这些底层能力
全部复用 `D:\你的项目目录\bili-live-kit\bili_api`，这一层只负责「动作分发 + 字段裁剪 + 错误中文化」。

```
bridge/
├── bili_bridge.py   桥本体（约 1600 行）
├── selftest.py      宿主式自测（写操作只跑 dryRun）
├── README.md        本文件
└── .data/           自动生成：buvid 缓存等（可删，会重建）
```

## 一、调用方式

```bat
python bili_bridge.py --cookie "D:/你的工作目录/live/data/bili_cookie.json" "{\"action\":\"whoami\",\"args\":{}}"
```

* `--cookie` 可省略，顺序是：`--cookie` → 环境变量 `FEIYU_COOKIE_FILE` → 默认
  `D:/你的工作目录/live/data/bili_cookie.json`。
* **最后一个 argv** 是请求 JSON：`{"action":"…","args":{…}}`。
* stdout **恰好一行** UTF-8 JSON。桥内部直接写 `sys.stdout.buffer`，不受 Windows 本地编码影响；
  但宿主仍建议设 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 并**按 UTF-8 解码**。
* 辅助开关：`--version`、`--list-actions`、`--ipv6`（关掉强制 IPv4，见下）。
* 退出码：只要是「桥跑完了」都是 0（成功失败看 `ok`）；只有参数级错误才会非 0。

## 二、输出协议

```jsonc
{"ok": true,  "action": "whoami", "data": { … }}
{"ok": false, "action": "whoami", "error": "未登录：…", "code": -101}
```

* `code`：B 站错误码（`BiliError.code`）。**本地参数错误码为 `null`**（不是 B 站拒绝的，别当风控处理）。
* 任何异常都会被兜成 `ok:false`，不会抛栈、不会打第二行。
* **体积上限约 12KB**：超了会依次「砍最长的列表到 60%」→「把长字符串截到 120/60 字」，
  并在 `data.truncated = true` 里标出来。列表长度永远 ≤ 请求的 `limit`。
* 长文本默认截断：视频简介 300 字、评论/弹幕 200 字、单条字幕全文 1500 字。

### 常用错误码释义（桥已翻译成中文）

| code | 含义 | 桥里的提示 |
|---|---|---|
| -101 | 账号未登录 / 登录态失效 | 重新扫码登录 |
| -111 | csrf 校验失败 | cookie 里的 bili_jct 不对或没带上 |
| -352 | **风控** | 提示「隔几分钟再试 / 别高频」 |
| -400 | 请求错误（参数不合法） | 原样带回 |
| -403 | 权限不够（如别人的私密收藏夹） | 原样带回 |
| -412 | 请求被拦截（没 UA / 太频繁） | 原样带回 |
| -509 | 请求过于频繁 | 等一会儿 |
| -799 | 请求过于频繁 | 等一会儿 |
| 22001 / 22013 / 62002 / 62004 / 62012 / 87007 / 87008 | 评论/弹幕/私信/动态的业务错误 | 已翻成中文 |

## 三、读动作（23 个，全部实测通过）

| action | args | 说明 |
|---|---|---|
| `ping` | `{}` | 本地自检，**不发请求**。回 version/python/cookie_path/cookieExists/loggedIn/ipv4Only/actions |
| `whoami` | `{}` | nav：isLogin/uname/mid/vip + cookie 来源（**不回传 cookie 值**，只给字段名与来源） |
| `search` | `{keyword, limit=10, order?, page?}` | 视频搜索。`order`=`totalrank`/`click`/`pubdate`/`dm` |
| `video_info` | `{bvid}` | 标题/UP/播放/点赞/硬币/收藏/简介截断；也接受整条链接 |
| `video_comments` | `{bvid, limit=20}` | 热门评论（用户/内容/点赞/回复数），最多翻 3 页 |
| `video_danmaku` | `{bvid, limit=50, mode?}` | 弹幕文本。默认 `mode=spread`（整段等距抽样）；`mode=head` 按时间取头部 |
| `video_subtitle` | `{bvid}` | 字幕语言列表 + 第一条字幕正文（截断 1500 字） |
| `user_info` | `{uid?}` | 昵称/等级/粉丝/关注/签名（uid 省略 = 自己） |
| `user_videos` | `{uid?, limit=10}` | 最近投稿 |
| `user_dynamics` | `{uid?, limit=10}` | 空间动态（只回类型/文本/时间） |
| `following` | `{uid?, limit=20}` | 关注列表 |
| `favorites` | `{uid?}` | 收藏夹列表（id/标题/条数） |
| `favorite_content` | `{mediaId, limit=10}` | 收藏夹内容 |
| `hot` | `{limit=10}` | 热门视频 |
| `rank` | `{limit=10, rid?, type?}` | 排行榜 |
| `weekly` | `{limit=10, number?}` | 每周必看（不传 number 自动取最新一期） |
| `live_room` | `{roomId?, mid?}` | 直播间信息（两个都不传 = 自己的直播间） |
| `live_roam` | `{area="虚拟", limit=10, sort="online"}` | 分区乱逛 |
| `live_online` | `{roomId}` | 真实在线人数 |
| `messages_unread` | `{}` | 未读数（`totalAll` 是把各分类直接加总，口径与 B 站角标不同） |
| `messages_replies` | `{limit=10}` | 收到的回复 |
| `messages_at` | `{limit=10}` | 收到的 @ |
| `relation_status` | `{bvid}` | 我对该视频的赞/币/藏 + 是否关注 UP |

## 四、写动作（10 个）与安全闸

**`args.dryRun` 缺省就是 `true`。只有显式传 `"dryRun": false` 才会真的发请求。**

* dry-run **完全不联网**（连 bvid→aid 都不解析，参数里用 `<view(BV…).aid>` 占位），
  返回 `{dryRun:true, action, endpoint, params, loggedIn, hasCsrf, note}`，
  其中 `csrf`/`csrf_token` 一律打码成 `<bili_jct>`。
* 真发前会过 `require_csrf()`：没有 SESSDATA 或 bili_jct 直接报错，不发请求。
* 成功真发时返回 `{dryRun:false, sent:true, endpoint, …}`。
* 自测里 14 条写用例全部只走 dry-run，并断言响应中没有 `"sent": true`。

| action | args | 端点 | 状态 |
|---|---|---|---|
| `comment_add` | `{bvid, text, root?, parent?}` | POST `/x/v2/reply/add` | 已实现，**未真发** |
| `like` | `{bvid, like=true}` | POST `/x/web-interface/archive/like` | 已实现，**未真发** |
| `coin` | `{bvid, num=1, like=false}` | POST `/x/web-interface/coin/add` | 已实现，**未真发** |
| `favorite` | `{bvid, addFolderId?, removeFolderId?}` | POST `/x/v3/fav/resource/deal` | 已实现，**未真发** |
| `triple` | `{bvid, num=1, folderId?}` | 点赞 + 投币（+ 收藏） | 已实现；没给 folderId 时跳过收藏并在 `skipped` 里说明 |
| `follow` | `{uid, action="follow"\|"unfollow"}` | POST `/x/relation/modify` | 已实现，**未真发** |
| `danmaku_send` | `{bvid, text, time=1}` | POST `/x/v2/dm/post` | 已实现，**未真发**；`oid=cid`、`pid=aid` |
| `live_danmaku` | `{roomId, text}` | POST `api.live.bilibili.com/msg/send` | 已实现，**未真发** |
| `dm_send` | `{uid, text}` | POST `api.vc.bilibili.com/web_im/v1/web_im/send_msg` | 已实现，**未实测**（参数按 web_im 老接口写；如失败先看这个） |
| `dynamic_post` | `{text}` | POST `/x/dynamic/feed/create/dyn` | **未实现**（故意）：dry-run 只回形状，真发直接报「未实现」，不猜参数 |

## 五、踩过的坑（宿主可能想知道）

1. **这台机器 IPv6 通不了**：`api.bilibili.com` 的 AAAA 能解析但连接超时，
   urllib 每次都会先卡满 20s 再回落 IPv4（实测 view/popular 都是 20.1~20.3s）。
   桥在 `main()` 里给 `socket.getaddrinfo` 打了补丁，**只留 `AF_INET` 结果**；
   打完 0.2~0.9s/请求。要关掉：`--ipv6` 或 `FEIYU_IPV6=1`（`ping.data.ipv4Only` 可查）。
2. **弹幕 XML 是 raw deflate**（`Content-Encoding: deflate` 但其实是裸 deflate 流）：
   必须 `zlib.decompress(raw, -15)`，普通 `wbits=15` 会 `Error -3 ... incorrect header check`。
3. **弹幕 0 秒层是垃圾场**：某视频 1200 条里有 91 条 `t=0`（反诈/引流弹幕集中刷），
   按时间取前 N 条会全是它们。所以默认 `mode=spread` 等距抽样，并把剔除条数记在 `droppedZero`。
4. **收藏夹分页的偏移是按 `ps` 算的**：翻页过程中改 `ps` 会重叠（实测 ps=20 翻到第三页
   改成 ps=11，结果重复 17 条）；且 `ps` 上限 40（50 直接 -400）。
   桥里固定每页 `ps=20`、最多 3 页，并按 bvid 去重。
5. **直播分区列表要绕两层坑**：`second/getListByArea` 对该账号**恒回空列表**（不是报错），
   `second/getList` 恒 -352；SDK 的 `list_by_area` 兜底逻辑是「首页流里按 `parent_area_id` 筛，
   筛不到就原样返回首页全量」→ 会串区（「虚拟」里冒出单机/电台）。
   桥改用老的 `/room/v1/area/getRoomList?parent_area_id=&area_id=0&page=&page_size=30&sort_type=`，
   实测 0.2s 回 30 个房间、分区正确（`source` 字段会标 `area/getRoomList` 还是备胎 `live.list_by_area`）。
   ⚠️ 该接口的 `online` 是**人气值**（可到几十万），不是 `live_online` 的真实人数 → 桥标 `onlineIsHeat:true`。
6. **PowerShell 直接敲命令的引号坑**：`'{"action":"ping"}'` 传给原生 exe 时双引号会被吃掉
   → 报「请求不是合法 JSON … 收到 '{action:ping,args:{}}'」。pwsh 里要么写成
   `'{\"action\":\"ping\",\"args\":{}}'`，要么用 `subprocess` 列表参数（宿主就是这么调的，无此问题）。
7. **cookie 文件不只有 cookie 值**：`bili_cookie.json` 是 `{"cookie":"SESSDATA=…; bili_jct=…", …}`，
   由 `bili_api.load_cookie(client, cfg)` 解析；`whoami` 只回「来源 + 字段名」，不回值。
8. `video_subtitle` 的 `subtitle_url` 以 `//` 开头，桥会补 `https:`；`subtitle_url_v2` 是乱码，别用。

## 六、自测

```bat
python selftest.py            :: 只测读动作（24 条）
python selftest.py --writes   :: 加写动作 dry-run（14 条）
python selftest.py --bad      :: 加错参数用例（8 条）
python selftest.py --all      :: 全都要（46 条，约 16s）
python selftest.py --only search,video_info --show 2
python selftest.py --json     :: 机器可读
```

自测做的事：像宿主一样 `subprocess` 调桥、断言 **stdout 恰好一行**、JSON 结构、
`action` 回显、`ok:false` 必须带 `code`、写用例必须 `dryRun:true` 且不含 `"sent": true`。

**最近一次全量结果：46/46 通过，总耗时 15.6s，单条 216~853ms。**

## 七、未完成 / 已知限制

* `dynamic_post`：**未实现**。B 站发动态的 `dyn_req` 结构没有可靠参考实现可抄，
  按「不猜参数」的原则只返回 dry-run 形状 + `implemented:false`。
* `dm_send`：端点与参数按 `web_im/v1/web_im/send_msg` 写，**未实测**（任务要求不做写操作）。
  若日后真发失败，优先核对 `msg[sender_uid]`/`msg[dev_id]` 与 `csrf`。
* `live_roam`：已换成 `area/getRoomList`，能稳定回满（`虚拟` 8/8、`网游` 3/3）。
  只有该分区真的没人开播、或接口降级时才少于 limit，此时 `data.note` 会说明。
* `messages_unread.totalAll`：把 at/chat/coin/danmu/favorite/like/recv_like/recv_reply/reply/sys_msg/up
  直接加总，与 B 站红点口径不同，只适合判断「有没有新东西」。
