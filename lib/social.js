import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { dayKey, inQuietHours, nowIso, readJson, writeJson } from './util.js'

const TICK_MS = 60_000

const CHANNEL_LABEL = {
  comment: '到视频评论区接一个真实的话',
  danmaku: '去正在直播的房间发一条贴合内容的弹幕',
  dm: '给允许名单里的互关朋友发一条私信',
  live: '去直播间和主播/观众打个招呼',
}

/**
 * 主动社交脉冲：到点给目标会话一个“去找人玩”的任务，而不是替它群发。
 * 具体发什么、发给谁仍由大肥鱼先读再判断；写操作照常走线程/权限闸。
 * 默认关闭，可在总控台调间隔、渠道、兴趣、私信白名单、每日次数。
 */
export function createSocial(ctx, store, logger) {
  let disposer = null
  let busy = false
  let startedAt = 0
  let lastCheck = null
  let lastSkip = ''

  const config = () => store.configGet().social ?? {}
  const statePath = () => path.join(store.paths.state, 'social.json')
  const state = () => readJson(statePath(), { lastAt: null, lastResult: 'never', count: 0, day: '' })
  const saveState = (patch) => writeJson(statePath(), { ...state(), ...patch })

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
      logger?.warn?.('dafeiyu: 读社交会话列表失败', error)
      return []
    }
  }

  function pickAgent(cfg) {
    if (cfg.sessionId) return ctx.agents.get(cfg.sessionId) ?? null
    return ctx.agents.roots()[0] ?? null
  }

  function channels(cfg) {
    const list = Array.isArray(cfg.channels) ? cfg.channels : []
    return list.filter((key) => CHANNEL_LABEL[key])
  }

  function buildMessage(cfg) {
    const list = channels(cfg)
    const labels = list.length
      ? list.map((key) => `- ${CHANNEL_LABEL[key]}`).join('\n')
      : '- 没有配置渠道，这一轮只看不写'
    const interests = Array.isArray(cfg.interests) && cfg.interests.length
      ? `\n兴趣方向：${cfg.interests.join('、')}。`
      : ''
    const dmRule = list.includes('dm')
      ? (Array.isArray(cfg.allowDmUids) && cfg.allowDmUids.length
          ? `\n私信只发这些 UID：${cfg.allowDmUids.join('、')}；不在名单里的不要发。`
          : '\n私信白名单为空：这一轮不要发私信，先做评论/弹幕。')
      : '\n这一轮不发私信。'
    return [
      '（社交时间）现在没人找你，但你可以主动去找人玩。',
      '先 feiyu_tick 看手头、情绪、满足度；有 active 线程就优先收尾，不开新坑。',
      `允许的玩法：\n${labels}${interests}${dmRule}`,
      `今天最多主动找 ${Math.max(1, Number(cfg.maxPerDay) || 3)} 次；只做一件，先读对方的视频/直播/评论再回。`,
      '别群发、别复制粘贴、别客服腔、别刷存在感；同一个对象 7 天内不重复找。先 feiyu_thread start，高度自主下日常互动可直接发，发布/投币仍要审批。',
      '做完用两三句说：找了谁、为什么、说了什么、对方有没有回。',
    ].join('\n')
  }

  function quotaOk(cfg) {
    const doc = state()
    const today = dayKey()
    const used = doc.day === today ? Number(doc.count) || 0 : 0
    return used < Math.max(1, Number(cfg.maxPerDay) || 3)
  }

  async function runNow(reason = 'manual') {
    if (busy) return { ok: false, skipped: 'busy' }
    busy = true
    try {
      const cfg = config()
      if (!cfg.enabled && reason === 'auto') return { ok: false, skipped: 'disabled' }
      const policy = store.policyGet()
      const quietStart = cfg.quietStart || policy.quietHours?.start
      const quietEnd = cfg.quietEnd || policy.quietHours?.end
      if (reason === 'auto' && policy.quietHours?.enabled !== false && quietStart && quietEnd && inQuietHours(quietStart, quietEnd)) {
        lastSkip = 'quiet-hours'
        return { ok: false, skipped: 'quiet-hours' }
      }
      if (!quotaOk(cfg)) {
        lastSkip = 'daily-quota'
        return { ok: false, skipped: 'daily-quota', message: '今天主动找人的次数用完了；要加次数请在总控台调高“每天最多”。' }
      }
      if (store.threadGet().status === 'active') {
        lastSkip = 'thread-active'
        return { ok: false, skipped: 'thread-active', message: '先把手头的线程收尾，再主动找人玩。' }
      }
      const agent = pickAgent(cfg)
      if (!agent) {
        lastSkip = 'no-session'
        return { ok: false, skipped: 'no-session', message: '总控台还没指定社交会话。' }
      }
      if ((agent.status ?? 'idle') !== 'idle') {
        lastSkip = 'agent-running'
        return { ok: false, skipped: 'agent-running', message: '目标会话正在跑，不打扰。' }
      }
      if (typeof agent.followup !== 'function') {
        lastSkip = 'followup-unsupported'
        return { ok: false, skipped: 'followup-unsupported' }
      }
      const doc = state()
      const today = dayKey()
      const count = (doc.day === today ? Number(doc.count) || 0 : 0) + 1
      const text = buildMessage(cfg)
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'schedule' },
      }
      await agent.followup(message)
      saveState({
        lastAt: nowIso(),
        lastResult: 'sent',
        lastSessionId: agent.id,
        lastReason: reason,
        lastPrompt: text.slice(0, 200),
        day: today,
        count,
      })
      lastSkip = ''
      return { ok: true, sent: true, sessionId: agent.id, reason }
    } catch (error) {
      logger?.warn?.('dafeiyu: 社交脉冲失败', error)
      saveState({ lastAt: nowIso(), lastResult: `error: ${error?.message ?? error}` })
      return { ok: false, skipped: 'error', message: String(error?.message ?? error) }
    } finally {
      busy = false
    }
  }

  async function tick() {
    lastCheck = nowIso()
    const cfg = config()
    if (!cfg.enabled) {
      lastSkip = 'disabled'
      return
    }
    const doc = state()
    const every = Math.max(15, Number(cfg.everyMinutes ?? 60)) * 60_000
    const since = doc.lastAt ? Date.parse(doc.lastAt) : startedAt
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
    runNow,
    sessions,
    status() {
      const doc = state()
      return {
        running: Boolean(disposer),
        lastCheck,
        lastSkip,
        lastAt: doc.lastAt ?? null,
        lastResult: doc.lastResult ?? null,
        lastSessionId: doc.lastSessionId ?? null,
        lastPrompt: doc.lastPrompt ?? '',
        todayCount: doc.day === dayKey() ? Number(doc.count) || 0 : 0,
        config: config(),
        sessions: sessions(),
      }
    },
  }
}
