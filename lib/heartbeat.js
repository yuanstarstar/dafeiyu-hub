import { randomUUID } from 'node:crypto'
import { inQuietHours, nowIso, stripMarkdown } from './util.js'

const TICK_MS = 60_000

// 心跳不是“到点问一句在不在”，而是给一个具体的好奇心题，逼着动手。
// 行动稿优先读 self/heartbeat.md（大肥鱼自己可以改）；这里只是底稿/兜底。
const CURIOSITIES = [
  '先收消息：messages_unread / messages_sessions；有人回、@ 或私信，先接这个。',
  '看一屏 home_feed 或 rank，挑一条没看过的；video_subtitle + video_comments 各一次。',
  '回一条有互动的楼：video_comments 拿 rpid，comment_add 挂原楼。',
  '巡一个直播房间半分钟，看弹幕在聊什么；记一条观察。',
  '看一眼素材库，挑一张图，想一个视频选题；把选题写进 plan。',
  '查账本、互动反馈和风控，找一条值得回应的互动。',
  '读一个关系档案，回想上次聊到哪；想一句下次能接的话。',
  '挑自己的一份文档（style/preferences/heartbeat）读一遍，删掉一条过时的话。',
]

/** 读大肥鱼自己写的心跳行动稿；没有就用内置底稿。 */
function readGuide(store) {
  try {
    const raw = String(store.readDoc('heartbeat') ?? '')
    const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
    return body.length > 2200 ? `${body.slice(0, 2200)}…` : body
  } catch {
    return ''
  }
}

/**
 * 可选心跳：到点且目标会话空闲时，用 agent.followup 唤醒一次自主行动。
 * 默认关闭；同一时间只允许一个 agent，线程未收尾时提醒收尾而不是开新坑。
 */
export function createHeartbeat(ctx, store, logger) {
  let disposer = null
  let startedAt = 0
  let lastCheck = null
  let lastSkip = ''
  let busy = false

  const config = () => store.configGet().heartbeat ?? {}

  const sessions = () => {
    try {
      return ctx.agents.roots().map((agent) => {
        let title = ''
        try {
          title = ctx.sessionProjections?.stateOf?.(agent.session, 'title') ?? ''
        } catch {}
        return {
          id: agent.id,
          status: agent.status ?? 'unknown',
          title: title || (agent.session?.header?.title ?? ''),
        }
      })
    } catch (error) {
      logger?.warn?.('dafeiyu: 读会话列表失败', error)
      return []
    }
  }

  function pickAgent(cfg) {
    if (cfg.sessionId) {
      const exact = ctx.agents.get(cfg.sessionId)
      if (exact) return exact
    }
    const roots = ctx.agents.roots()
    if (!roots.length) return null
    if (cfg.sessionId) return null
    return roots[0]
  }

  function pickCuriosity(beat) {
    const count = Number(beat.count) || 0
    let curiosity = CURIOSITIES[count % CURIOSITIES.length]
    if (beat.lastPrompt && curiosity === beat.lastPrompt) {
      curiosity = CURIOSITIES[(count + 1) % CURIOSITIES.length]
    }
    return curiosity
  }

  /** 满足度没满时缩短间隔：默认 45 分钟 -> 15 分钟；最低 1 分钟，可关掉加速或改值。 */
  function effectiveMinutes(cfg = config()) {
    const normal = Math.max(1, Number(cfg.everyMinutes ?? 45))
    if (cfg.speedUpWhenLow === false) return normal
    const satisfaction = store.satisfactionView(store.policyGet())
    if (satisfaction.full) return normal
    const low = Math.max(1, Number(cfg.lowEveryMinutes ?? 15))
    return Math.min(normal, low)
  }

  function pickLearning(beat) {
    try {
      const goals = (store.learningView()?.goals ?? []).filter((goal) => goal.status === 'learning')
      if (!goals.length) return null
      const last = String(beat.lastLearningId ?? '')
      let index = goals.findIndex((goal) => goal.id === last)
      if (index < 0) index = -1
      const goal = goals[(index + 1) % goals.length]
      return {
        id: goal.id,
        title: goal.title,
        progress: goal.progress,
        targets: goal.targets ?? [],
        skillCount: goal.skillCount ?? 0,
      }
    } catch {
      return null
    }
  }

  function buildMessage(thread, curiosity, beat, satisfaction, effective, learning) {
    const tools = Number(beat.toolCalls) || 0
    const last = beat.lastAt
      ? (tools > 0
          ? `上次心跳：你调用了 ${tools} 个工具${beat.lastTool ? `（最后是 ${beat.lastTool}）` : ''}。`
          : '上次心跳：一个工具都没调用，只回了话。')
      : '上次心跳：还没跑过。'
    const satisfied = satisfaction?.full === true
    const guide = readGuide(store)
    const digest = (name, max) => {
      try {
        return stripMarkdown(store.readDoc(name)).trim().slice(0, max)
      } catch {
        return ''
      }
    }
    const plan = digest('plan', 460)
    const progress = digest('progress', 280)
    const studio = store.configGet().studio ?? {}
    const creation = studio.heartbeatCreate === true
      ? (studio.enabled === true
          ? '创作：心跳已允许做视频。如果规划里有具体选题，可以 feiyu_studio action=produce；做完把成片/封面交投稿审批，不要直接发。'
          : '创作：心跳允许做视频，但创作总开关还没开；这轮先在 plan 里记选题，不要硬做。')
      : '创作：心跳没开创作。这轮只记选题/素材，不要调用 feiyu_studio 做视频。'
    const learningLine = learning
      ? `本轮学习目标（只挑这一个）：${learning.title}（进度 ${learning.progress}%${learning.targets?.length ? `；练：${learning.targets.slice(0, 3).join(' / ')}` : ''}）。先找一条能练它的材料（视频字幕/评论/直播弹幕/同行视频），看完记一条 skill 或把进度 +5~10；不要三个目标一起学，也不要只收藏不记。`
      : '学习目标：还没有进行中的学习目标。先从 feiyu_learn 里挑一个，或者在观察里记一条新技能。'
    const common = [
      `现在规划（先看再决定，别只按惯性刷）：\n${plan || '（空）'}`,
      `最近进度：\n${progress || '（空）'}`,
      guide
        ? `我给自己写的心跳行动稿（可以边学边改）：\n${guide}`
        : '我这轮还没写自己的心跳行动稿；按底稿来：先收消息，再看视频/评论，有想法才留言。',
      learningLine,
      `本轮小方向：${curiosity}`,
      creation,
      `满足度：${satisfaction?.value ?? 0}/${satisfaction?.threshold ?? 100}${satisfied ? '（满了，这轮可以自然收尾）' : `（没满，还差 ${satisfaction?.missing ?? 0}；心跳已按 ${effective} 分钟加速）`}`,
      last,
      '先 feiyu_tick 看情绪、厌倦、满足度、待批和风控。一轮至少做 3 件可观察的事：先收消息，再看一条 B 站内容，能留言就留一条有内容的；不要只读一个文件。',
      '满足度只能靠 B 站上的真实行为涨：刷视频/直播少量，评论/私信/回复中量，被回复/点赞/@/私信大量。点赞/收藏/弹幕别拿来冲满足度，实测 0 分。',
      '评论/私信要看过内容再写，最多 2 条评论/小时；能回楼就带 rpid 回原楼，不写“真好”这类空话。没满就别拿“聊累了/没事了”收尾。',
      '同一类事做腻了就换一类；B 站写操作必须先 feiyu_thread start。日常互动可自主执行，发布/投币等才等人批准；别为了刷量而刷，也别空转。',
      '做完用两三句说：做了什么、看到什么、下一步；如果结束一段对话，先用 feiyu_self 改 plan，再 feiyu_chat close。',
    ]
    if (thread) {
      return [
        '（自主心跳）现在没人找你，但手头还有没做完的事。这一轮至少推进一小步。',
        `手头：《${thread.title}》。`,
        ...common,
        '推进用 feiyu_thread step；做完就 finish，卡住就 abandon，别开新坑。',
      ].join('\n')
    }
    return [
      '（自主心跳）现在没人找你。这一轮不是让你汇报“没事”，是让你真的动手做一件小事，顺便涨一点满足度。',
      ...common,
      satisfied ? '满足度满了，做完这轮可以收尾；不用硬找活。' : '满足度没满，挑一件能涨满足的小事，或者至少读点东西。',
    ].join('\n')
  }

  async function runNow(reason = 'manual') {
    if (busy) return { ok: false, skipped: 'busy' }
    busy = true
    try {
      const cfg = config()
      if (!cfg.enabled && reason === 'auto') return { ok: false, skipped: 'disabled' }
      if (reason === 'auto' && cfg.quietStart && cfg.quietEnd && inQuietHours(cfg.quietStart, cfg.quietEnd)) {
        lastSkip = 'quiet-hours'
        return { ok: false, skipped: 'quiet-hours' }
      }
      const agent = pickAgent(cfg)
      if (!agent) {
        lastSkip = 'no-session'
        return { ok: false, skipped: 'no-session', message: '总控台还没指定心跳会话。' }
      }
      if ((agent.status ?? 'idle') !== 'idle') {
        lastSkip = 'agent-running'
        return { ok: false, skipped: 'agent-running', message: '目标会话正在跑，不打扰。' }
      }
      const beat = store.beatGet()
      const doc = store.threadGet()
      const thread = doc.status === 'active' ? doc.thread : null
      const satisfaction = store.satisfactionView(store.policyGet())
      const curiosity = pickCuriosity(beat)
      const learning = pickLearning(beat)
      const effective = effectiveMinutes(cfg)
      const nextCount = (Number(beat.count) || 0) + 1
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildMessage(thread, curiosity, beat, satisfaction, effective, learning) }],
        source: { kind: 'schedule' },
      }
      if (typeof agent.followup !== 'function') {
        lastSkip = 'followup-unsupported'
        return { ok: false, skipped: 'followup-unsupported', message: '这个运行时没有 followup，心跳发不出去。' }
      }
      await agent.followup(message)
      store.beatSet({
        lastAt: nowIso(),
        lastResult: 'sent',
        lastSessionId: agent.id,
        lastReason: reason,
        count: nextCount,
        lastPrompt: curiosity,
        lastLearningId: learning?.id ?? null,
        toolCalls: 0,
        lastTool: null,
        lastActivityAt: null,
      })
      lastSkip = ''
      return { ok: true, sent: true, sessionId: agent.id, reason, curiosity, learning }
    } catch (error) {
      logger?.warn?.('dafeiyu: 心跳失败', error)
      store.beatSet({ lastAt: nowIso(), lastResult: `error: ${error?.message ?? error}` })
      return { ok: false, skipped: 'error', message: String(error?.message ?? error) }
    } finally {
      busy = false
    }
  }

  /** 心跳回合里每调一次工具就记一笔，下轮心跳能看见“上次到底动没动手”。 */
  function noteTool(sessionId, name) {
    try {
      const beat = store.beatGet()
      if (beat.lastSessionId !== sessionId || !beat.lastAt) return
      const age = Date.now() - Date.parse(beat.lastAt)
      if (!Number.isFinite(age) || age > 30 * 60_000) return
      store.beatSet({
        toolCalls: (Number(beat.toolCalls) || 0) + 1,
        lastTool: String(name || '').slice(0, 80),
        lastActivityAt: nowIso(),
      })
    } catch {}
  }

  async function tick() {
    lastCheck = nowIso()
    const cfg = config()
    if (!cfg.enabled) {
      lastSkip = 'disabled'
      return
    }
    const beat = store.beatGet()
    const every = effectiveMinutes(cfg) * 60_000
    const since = beat.lastAt ? Date.parse(beat.lastAt) : startedAt
    if (Number.isFinite(since) && Date.now() - since < every) return
    await runNow('auto')
  }

  return {
    start() {
      if (disposer) return
      startedAt = Date.now()
      disposer = ctx.timer.interval(() => { void tick() }, TICK_MS)
    },
    stop() {
      try { disposer?.() } catch {}
      disposer = null
    },
    reload() {},
    runNow,
    noteTool,
    sessions,
    status() {
      const beat = store.beatGet()
      const cfg = config()
      const satisfaction = store.satisfactionView(store.policyGet())
      return {
        running: Boolean(disposer),
        lastCheck,
        lastSkip,
        lastAt: beat.lastAt ?? null,
        lastResult: beat.lastResult ?? null,
        toolCalls: Number(beat.toolCalls) || 0,
        lastTool: beat.lastTool || '',
        lastPrompt: beat.lastPrompt || '',
        lastLearningId: beat.lastLearningId || '',
        nextLearning: pickLearning(beat),
        promptSource: 'self/heartbeat.md',
        promptChars: readGuide(store).length,
        effectiveMinutes: effectiveMinutes(cfg),
        satisfactionLow: !satisfaction.full,
        sessions: sessions(),
      }
    },
  }
}
