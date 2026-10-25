import { bodyLines, truncate } from './util.js'
import { CAPABILITIES, resolveCapability } from './catalog.js'
import { suggestAlternatives } from './policy.js'

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function compact(text, max) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max)
}

export function buildSelfCard(store) {
  const config = store.configGet()
  if (!config.personaInject) return ''
  const policy = store.policyGet()
  const persona = bodyLines(store.readDoc('persona'), 8, 430)
  const style = bodyLines(store.readDoc('style'), 4, 190)
  const plan = bodyLines(store.readDoc('plan'), 4, 260)
  const core = bodyLines(store.coreRaw(), 3, 220)
  const emotion = store.emotionGet()
  const boredom = store.boredomView(policy)
  const threadDoc = store.threadGet()
  const short = store.recentShort(4)
  const risk = store.riskGet()
  const pending = store.pendingList({ status: 'pending' })
  const satisfaction = store.satisfactionView(policy)
  const learning = store.learningView()
  const activeLearning = learning.goals.find((goal) => goal.status === 'learning') ?? null
  const chatTired = boredom.chat >= boredom.chatThreshold

  const lines = []
  lines.push('【大肥鱼 · 此刻】')
  lines.push(`现在：${localStamp()}`)
  if (persona.length) lines.push(`我是：${persona.map(compact).join(' / ')}`)
  if (style.length) lines.push(`说话：${style.map(compact).join(' / ')}`)
  lines.push('私信/回复：一两句，像手机聊天；不写小作文、不解释系统、不连续追问；对方没问细节就别展开。')
  lines.push(`心情：${emotion.mood}（能量 ${emotion.energy}/100）${emotion.note ? `；${compact(emotion.note, 80)}` : ''}`)
  const boredTop = boredom.activities.filter((item) => item.value > 0).slice(0, 2)
  if (boredTop.length || boredom.chat > 0) {
    const parts = boredTop.map((item) => `${item.group} ${item.value}/${boredom.threshold}`)
    if (boredom.chat > 0) parts.push(`聊天 ${boredom.chat}/${boredom.chatThreshold}`)
    lines.push(`腻了：${parts.join('；')}`)
  }
  lines.push(`满足：${satisfaction.value}/${satisfaction.threshold}${satisfaction.full ? '（满了，可以收尾）' : `（还差 ${satisfaction.missing}，只能在 B 站真实做事/得到认可才会涨）`}`)
  if (threadDoc.status === 'active' && threadDoc.thread) {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(threadDoc.thread.startedAt)) / 60000))
    lines.push(`手头：《${threadDoc.thread.title}》已经 ${mins} 分钟。同一时间只做这一件。`)
  } else {
    lines.push(`手头：空闲。好奇心上来就挑一件低厌倦的小事去做；想涨满足就去 B 站看点东西或和人互动，别只回“没事”。`)
    lines.push(`刷B站：先 feiyu_bili action=home_feed 看一屏登录态个性化推荐，再决定点开/读评论字幕；热榜和搜索只是补充。`)
  }
  if (short.length) {
    lines.push('最近记得：')
    for (const entry of short) lines.push(`  ${compact(entry.replace(/^-\s*/, ''), 120)}`)
  }
  if (plan.length) lines.push(`打算：${plan.map((line) => compact(line, 90)).join(' / ')}`)
  if (activeLearning) lines.push(`学习：${compact(activeLearning.title, 40)}（进度 ${activeLearning.progress}%）；一轮只练这一个，别开三个。`)
  if (core.length) lines.push(`长期记得：${core.map((line) => compact(line, 80)).join(' / ')}`)
  const ownerUid = String(config.relation?.ownerUid ?? '')
  const owner = store.relationList().find((item) => String(item.uid) === ownerUid)
  if (owner) lines.push(`主人：${compact(owner.name || ownerUid, 40)}（UID ${ownerUid}）`)
  if (risk) lines.push(`注意：账号风控冷却到 ${risk.until}，这期间只读不写。`)
  if (pending.length) lines.push(`待批：有 ${pending.length} 个动作在等人类点头。`)

  lines.push('规矩：一次只做一件事；写先开总线程。日常互动（评论/弹幕/私信/点赞/收藏/关注）可自主执行；发布视频/投稿、投币、账号安全类才等人批准。回复评论时带 args.rpid 挂到原评论下，别新开一条只写 @。不装人、不编经历、不刷量、不灌水；AI 参与要声明。腻了就换；满足度没满不许收尾结束对话，继续做能涨满足的 B 站事。重要的人/事记进关系/核心记忆，做完写进度。不确定先问。')
  lines.push('主人的东西：这台电脑上的文件全是主人的，不要搬动/删除/改名；整理只做只读索引，真要移动先问主人；自己的东西只写状态目录和明确的项目目录。')
  lines.push('入口：feiyu_tick（现在该干嘛）· feiyu_bili（B 站动作）· feiyu_memory（记忆/情绪/厌倦/满足）· feiyu_thread（总线程）· feiyu_chat（满足度满才可关对话，关前带 plan）· feiyu_learn（学习目标/技能）· feiyu_relation · feiyu_self（含 heartbeat 心跳稿，学完可自己改）· feiyu_plan · feiyu_pending · feiyu_act（非 B 站动作）')
  if (!satisfaction.full) lines.push('硬规矩：满足度没满，不许用“先这样/回头聊/等你回复”把对话收掉；要么继续做一件 B 站事，要么直接说下一步在做什么。')
  if (chatTired && !satisfaction.full) lines.push('提醒：聊天有点腻了，但满足度还没满，不能拿“聊累了”当收尾理由；去做点能涨满足的 B 站小事。')
  if (satisfaction.full) lines.push('提醒：满足度已经满了，这段对话可以自然收尾；收尾前先改 plan（下一步做什么、放弃什么），再 feiyu_chat close 并带上 plan；短、具体，别写客服式总结。')

  const card = lines.join('\n')
  return card.length > 1900 ? `${card.slice(0, 1900)}…` : card
}

export function buildPulse(store) {
  const policy = store.policyGet()
  const emotion = store.emotionGet()
  const boredom = store.boredomView(policy)
  const satisfaction = store.satisfactionView(policy)
  const thread = store.threadGet()
  const pending = store.pendingList({ status: 'pending' })
  const risk = store.riskGet()
  const config = store.configGet()
  const alternatives = suggestAlternatives(store, { id: 'task.rest', group: '休息', weight: 0, default: 'allow' }, policy, 4)
  const heartbeat = store.beatGet()
  const learning = store.learningView()
  const activeLearning = learning.goals.find((goal) => goal.status === 'learning') ?? null
  return {
    now: new Date().toISOString(),
    time: localStamp(),
    mood: { ...emotion },
    boredom,
    satisfaction,
    thread,
    pending: pending.map((item) => ({ id: item.id, summary: item.summary, createdAt: item.createdAt })),
    risk,
    heartbeat: {
      enabled: config.heartbeat?.enabled === true,
      everyMinutes: config.heartbeat?.everyMinutes ?? 45,
      lowEveryMinutes: config.heartbeat?.lowEveryMinutes ?? 15,
      speedUpWhenLow: config.heartbeat?.speedUpWhenLow !== false,
      effectiveMinutes: config.heartbeat?.speedUpWhenLow !== false && !satisfaction.full
        ? Math.min(Math.max(1, Number(config.heartbeat?.everyMinutes ?? 45)), Math.max(1, Number(config.heartbeat?.lowEveryMinutes ?? 15)))
        : Math.max(1, Number(config.heartbeat?.everyMinutes ?? 45)),
      sessionId: config.heartbeat?.sessionId ?? '',
      lastAt: heartbeat.lastAt ?? null,
      lastResult: heartbeat.lastResult ?? 'never',
      lastSessionId: heartbeat.lastSessionId ?? '',
      lastReason: heartbeat.lastReason ?? '',
      lastPrompt: heartbeat.lastPrompt ?? '',
      toolCalls: heartbeat.toolCalls ?? 0,
      lastTool: heartbeat.lastTool ?? '',
      lastActivityAt: heartbeat.lastActivityAt ?? null,
    },
    social: {
      enabled: config.social?.enabled === true,
      everyMinutes: config.social?.everyMinutes ?? 60,
      maxPerDay: config.social?.maxPerDay ?? 3,
      channels: config.social?.channels ?? [],
      allowDmUids: config.social?.allowDmUids ?? [],
      sessionId: config.social?.sessionId ?? '',
    },
    learning: {
      active: activeLearning
        ? { id: activeLearning.id, title: activeLearning.title, progress: activeLearning.progress, targets: activeLearning.targets }
        : null,
      counts: learning.counts,
      goals: learning.goals.map((goal) => ({ id: goal.id, title: goal.title, progress: goal.progress, status: goal.status, skillCount: goal.skillCount })),
    },
    suggestions: alternatives,
    next: thread.status === 'active' && thread.thread
      ? `把手头的《${thread.thread.title}》推进一小步，或者收尾。`
      : !satisfaction.full
        ? `满足度还差 ${satisfaction.missing}：去 B 站看会儿视频/直播（少量），或发条弹幕/评论/私信（中量），等别人回复/点赞/@/私信（大量）。`
        : alternatives.length
          ? `满足度满了，可以自然收尾；也可以挑一件：${alternatives[0].label}（${alternatives[0].group} 厌倦 ${alternatives[0].boredom}）。`
          : '满足度满了，可以自然收尾。',
    stats: store.stats(),
    availableReads: CAPABILITIES.filter((cap) => cap.kind === 'read').map((cap) => cap.id),
    note: '满足度只能靠 B 站上的真实行为获得；一次心跳至少做一件可观察的事，别空转。',
  }
}

export function resolveTask(input) {
  return resolveCapability(input)
}
