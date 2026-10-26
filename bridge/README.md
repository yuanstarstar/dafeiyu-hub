# 大肥鱼 B 站桥（bili_bridge.py）

给 DSH 插件「大肥鱼」用的 B 站桥。宿主 spawn 一个 Python 进程 → 传一行 JSON → 读回一行 JSON。

**自包含，不依赖外部的 `bili-live-kit`。** 底层 `bili_api` 就在本目录里：

```text
bridge/
├── bili_bridge.py    桥本体
├── bili_api/         自带的纯标准库 B 站客户端（7 个 .py）
├── selftest.py       宿主式自测（写操作只走 dryRun）
└── README.md         本文件
```

`KIT_DIR` 已指向本目录，不再写死任何人的绝对路径。

## 一、调用方式

```bat
python bili_bridge.py --cookie "path/to/bili_cookie.json" "{\"action\":\"whoami\",\"args\":{}}"
```

- `--cookie` 可省略；顺序是：`--cookie` → 环境变量 `FEIYU_COOKIE_FILE` → 当前目录 `data/bili_cookie.json` → `%USERPROFILE%\.dsh\dafeiyu-login-live\secrets\bili_cookie.json`。
- 最后一个 argv 是请求 JSON：`{"action":"…","args":{…}}`。
- stdout 恰好一行 UTF-8 JSON；桥直接用 `sys.stdout.buffer` 写，不受 Windows 本地编码影响。
- 辅助开关：`--version`、`--list-actions`、`--ipv6`（关掉强制 IPv4）。
- 退出码：桥跑完都是 0（成功失败看 `ok`）；只有参数级错误才非 0。

## 二、输出协议

```jsonc
{"ok": true,  "action": "whoami", "data": { … }}
{"ok": false, "action": "whoami", "error": "未登录：…", "code": -101}
```

- `code`：B 站错误码（`BiliError.code`）；本机参数错误码为 `null`。
- 任何异常都会被兜成 `ok:false`，不会抛栈、不会打第二行。
- 体积上限约 12KB：超了会依次「砍最长的列表到 60%」「把长字符串截到 120/60 字」，并在 `data.truncated = true` 里标出来。

## 三、cookie 与登录

桥只读 cookie 文件，不写、不上传。扫码登录由插件的 `lib/login.js` 完成，登录后写到：

```text
%USERPROFILE%\.dsh\dafeiyu-login-live\secrets\bili_cookie.json
```

也可以自己传一个 cookie 文件路径。**不要把 cookie 提交到仓库。**

## 四、动作

只读动作包括：`ping`、`whoami`、`search`、`video_info`、`video_comments`、`video_danmaku`、`video_subtitle`、`user_info`、`user_videos`、`user_dynamics`、`following`、`relation_status`、`favorites`、`favorite_content`、`live_room`、`live_roam`、`live_online`、`messages_unread`、`messages_replies`、`messages_at`、`messages_sessions`、`home_feed`、`comment_state`、`video_zones`、`hot`、`rank`、`weekly`、`live_play`、`live_danmaku_list` 等。

写动作包括：`comment_add`、`like`、`coin`、`favorite`、`triple`、`follow`、`danmaku_send`、`live_danmaku`、`dm_send`。

- 写动作默认 `dryRun=true`，只校验参数；
- 真正发要显式 `dryRun:false`，并带 `bili_jct`（csrf）；
- 插件层还有权限闸、限额、审批和审计，不要绕过插件直接拿桥刷接口。

## 五、常见错误

| code | 含义 | 建议 |
|---|---|---|
| -101 | 未登录 / 登录态失效 | 重新扫码 |
| -111 | csrf 校验失败 | cookie 里的 `bili_jct` 不对 |
| -352 | 风控 | 停几分钟，别高频 |
| -412 | 请求被拦截 | 检查 UA / 频率 |
| -400 | 参数错误 | 看 `error` 原文 |
| -509/-799 | 请求过于频繁 | 等一会儿 |

## 六、自测

```bat
python selftest.py
```

只跑只读动作；写动作只走 dry-run，不会真的发评论/弹幕/私信。

## 七、关于 `bili_api`

`bili_api` 不是官方 SDK，也不是 PyPI 上的公开包，而是本项目自带的一套纯标准库适配层。它不内置账号、cookie 或 API Key；单独复用时请遵守 B 站条款，不要做刷量、灌评论等滥用。
