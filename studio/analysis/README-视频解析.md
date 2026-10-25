# 大肥鱼 · 视频解析（独立版）

把一段视频按时间窗口切开、每窗口抽几帧画面，交给多模态模型（小米 MiMo，`mimo-v2.6-flash`），
输出**带时间轴的画面描述**：每一段在讲什么、什么时候发生了什么、画面里有什么字、有没有危险动作。

只做「看画面」，不做语音转写、不做字幕识别、不下载视频。

## 一、环境

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11（macOS / Linux 也能跑，`ffmpeg` 放 PATH 即可） |
| Python | 3.11 及以上 |
| ffmpeg | **必须有**（抽帧、读取时长）。没有就装一个，或把路径写进 `config.yaml` 的 `analyzer.ffmpeg` |
| 依赖 | `httpx`、`numpy`、`PyYAML`（`install.cmd` 会装好） |
| Key | `XIAOMI_API_KEY`（小米 MiMo 的 key），用来调多模态模型 |

## 二、装好

1. 解压到任意目录（建议纯英文路径，例如 `D:\video-analysis`）
2. 双击 `install.cmd`（建 `.venv` + 装依赖）
3. 配 key（三选一，推荐第一种）：

```powershell
setx XIAOMI_API_KEY "sk-你的key"     # 然后重开一个窗口
```

或写进 DSH 凭据文件 `C:\Users\你的用户名\.dsh\.credentials.yaml`：

```yaml
XIAOMI_API_KEY: sk-你的key
```

或直接填 `config.yaml` 里的 `llm.api_key`（不推荐，容易跟着文件泄漏）。

## 三、用

```bash
# 单个视频（输出到 out\ 目录，同时生成 .json 和 .md）
run_analyze.cmd "D:\videos\xxx.mp4"

# 一整个目录
run_analyze.cmd "D:\videos"

# 调整粒度：每 30 秒一段、每段抽 10 帧
run_analyze.cmd "D:\videos\xxx.mp4" --window 30 --frames 10

# 只看结果不写文件
run_analyze.cmd "D:\videos\xxx.mp4" --no-save

# 换模型 / 限量花多少钱
run_analyze.cmd "D:\videos\xxx.mp4" --model mimo-v2.6-pro --budget 0.05

# 忽略缓存重新分析
run_analyze.cmd "D:\videos\xxx.mp4" --fresh

# 直接打印整份 JSON（给程序用）
run_analyze.cmd "D:\videos\xxx.mp4" --json
```

没有装 `.venv` 也可以直接用系统 Python：

```bash
python analyze.py "D:\videos\xxx.mp4"
```

## 四、输出长什么样

`out\xxx.analysis.json`：

```json
{
  "video_id": "xxx",
  "duration": 243.5,
  "model": "mimo-v2.6-flash",
  "cost_cny": 0.012,
  "status": "done",
  "segments": [
    {"t0": 0.0, "t1": 60.0,
     "summary": "开场是人物特写，随后切到游戏画面：角色站在房间里，血条三颗红心。",
     "visual_notes": "00:12 撞到小怪掉了一颗心；00:35 打开宝箱拿到道具"}
  ]
}
```

`out\xxx.analysis.md` 是人读版：

```markdown
## 00:00 – 01:00
开场是人物特写，随后切到游戏画面：角色站在房间里，血条三颗红心。
- 事件：00:12 撞到小怪掉了一颗心；00:35 打开宝箱拿到道具
- 危险：无
- 画面文字：以撒的结合
```

## 五、花费与速度

- 一段（默认 60 秒、8 帧）约 **¥0.003**，4 分钟视频约 ¥0.01；
- 速度取决于网络：一段大约 5~20 秒，4 分钟视频通常 1 分钟内跑完；
- `budget_cny` 是**单条视频**的预算上限，超了会自动降级到本地亮度分段；
- 想更准就 `--frames 10`、`--window 30`（更贵更慢）；想更快就 `--window 120 --frames 4`。

## 六、config.yaml

```yaml
analyzer:
  prefer: vision              # vision=纯视觉直读（默认）；plugin=node 插件（本包不带，别选）
  llm_model: mimo-v2.6-flash  # 看画面用的模型
  llm_api_url: https://api.xiaomimimo.com/v1/chat/completions
  window_s: 60                # 每段多少秒
  vision_frames: 8            # 每段抽几帧（越多越准越贵）
  budget_cny: 0.06            # 单条视频预算上限
  fallback_local: true        # 视觉不可用时退化为亮度/能量分段（粗，但不出错）
  # ffmpeg: ""                # ffmpeg 不在 PATH 时填绝对路径
llm:
  api_key: ""                 # 建议留空，用 XIAOMI_API_KEY 环境变量
```

命令行参数会覆盖 `config.yaml` 里的同名项。

## 七、常见问题

| 现象 | 处理 |
| --- | --- |
| `没有可用的多模态 key` | 没配 `XIAOMI_API_KEY`，或 key 无效 |
| `抽帧失败` | ffmpeg 没装好；或视频编码不认识 |
| 输出里 model 是 `local` | 视觉调用失败了，退化成亮度分段：看日志里的 `视觉分析不可用` 一行 |
| 结果和视频对不上 | 多半命中了旧缓存；加 `--fresh` 重跑 |
| 中文乱码 | 用 PowerShell 5.1 看 `--json` 输出时，先 `chcp 65001` |
| 想省钱 | 加大 `--window`、减少 `--frames`，或降 `budget_cny` |

## 八、目录

```
analyze.py               命令行入口
video_analysis/          解析核心（analyzer / vision / llm / models / config）
config.yaml              配置（模型、窗口、帧数、预算）
requirements.txt         依赖
install.cmd              建 venv + 装依赖
run_analyze.cmd          双击即可跑（把视频拖到这上面也行）
data/                    运行时缓存（抽帧、单条分析结果）——可随时删
out/                     默认输出目录
```

## 九、和直播那套的关系

这套就是从直播包里抽出来的「画面解析」模块本身（同一份 `analyzer.py` / `vision.py`），
所以两边的画面描述口径完全一致；直播包里的「自动补片 → 分析 → 写讲稿」用的是同一个模块。
