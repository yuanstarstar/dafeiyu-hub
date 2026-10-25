import { CAPABILITIES, resolveCapability, bridgeCapabilities, taskCapabilities } from './catalog.js'
import { check, riskFromResult, suggestAlternatives } from './policy.js'
import { runBridge } from './bridge.js'
import { buildPulse } from './prompt.js'
import { bodyLines, truncate, clamp, nowIso } from './util.js'

const SELF_DOCS = ['persona', 'style', 'preferences', 'plan', 'progress', 'heartbeat']
const MAX_RENDER = 24000

function renderValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text.length > MAX_RENDER ? `${text.slice(0, MAX_RENDER)}\n…（已截断）` : text }]
}

function defineTool(name, description, properties = {}, required = [], execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    execute,
  }
}

const docParam = {
  type: 'string',
  enum: SELF_DOCS,
  description: '文档：persona 人设 / style 说话风格 / preferences 偏好 / plan 规划 / progress 进度 / heartbeat 心跳提示词（可以自己改）',
}

function ok(data) {
  return { ok: true, ...data }
}

function fail(message, extra = {}) {
  return { ok: false, message, ...extra }
}

function ensureActiveThread(store) {
  const doc = store.threadGet()
  if (doc.status === 'active' && doc.thread) return doc.thread
  return null
}

export function registerTools(ctx, store, rootDir, extras = {}) {
  const { studio, live, feedback, assets, library } = extras
  const disposers = []
  const add = (tool) => {
    disposers.push(ctx.effect(() => ctx.tools.register(tool), `dafeiyu: ${tool.name}`))
  }

  add(defineTool(
    'feiyu_self',
    '读写大肥鱼自己的短文档：人设 persona、说话风格 style、偏好 preferences、规划 plan、进度 progress、心跳提示词 heartbeat。heartbeat 是每次自主心跳的行动稿，学完东西可以自己改，但改完仍要过总控台权限/风控。这些文件人类也能在总控台直接改。先 list 看有哪些、get 读全文，改的时候只改需要的那一段，别把文档写长。',
    {
      action: { type: 'string', enum: ['list', 'get', 'set', 'append'], description: 'list 列表 / get 读 / set 覆盖 / append 追加一行' },
      doc: docParam,
      content: { type: 'string', description: 'set 或 append 的内容（set 最多 12000 字，append 一行）' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'list') {
        return ok({
          docs: store.listDocs().filter((doc) => SELF_DOCS.includes(doc.name)),
          hint: '文档都带 summary，先看 summary 再决定要不要 get 全文。',
        })
      }
      if (!SELF_DOCS.includes(String(args.doc))) return fail(`doc 只能是 ${SELF_DOCS.join(' / ')}`)
      const doc = String(args.doc)
      if (action === 'get') {
        const info = store.docInfo(doc)
        return ok({ doc, ...info })
      }
      const content = String(args.content ?? '')
      if (action === 'set') {
        if (!content.trim()) return fail('content 不能为空')
        if (content.length > 12000) return fail('这份文档太长了（>12000 字），删减后再写。')
        store.writeDoc(doc, content)
        return ok({ doc, written: true, summary: store.docInfo(doc).summary ?? '' })
      }
      if (action === 'append') {
        const line = truncate(content.replace(/\r?\n/g, ' ').trim(), 300)
        if (!line) return fail('content 不能为空')
        store.appendDoc(doc, line.startsWith('-') ? line : `- ${line}`)
        return ok({ doc, appended: line })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_memory',
    '大肥鱼的记忆入口：recall 按关键词检索长期记忆/最近对话，core_add 写一条核心记忆，recent 看最近聊过什么；mood_get/mood_set 读写即时情绪；boredom_get 看厌倦度，boredom_reset 把某项清零；satisfaction_get 看满足度（只有 B 站上的真实动作/别人认可才会涨），satisfaction_reset 只在本人明确要求时手动清零。刚说过的话会自动进入短时记忆，这里不用重复记。',
    {
      action: {
        type: 'string',
        enum: ['recall', 'core_add', 'recent', 'mood_get', 'mood_set', 'boredom_get', 'boredom_reset', 'satisfaction_get', 'satisfaction_reset'],
        description: '要做的记忆操作',
      },
      query: { type: 'string', description: 'recall 的检索词' },
      limit: { type: 'integer', description: 'recent 返回条数，默认 8' },
      text: { type: 'string', description: 'core_add 的记忆内容（一句话）' },
      mood: { type: 'string', description: 'mood_set 的情绪名，如 平静/好奇/有点累/兴奋/烦' },
      energy: { type: 'integer', description: 'mood_set 的能量 0-100，默认 60' },
      note: { type: 'string', description: 'mood_set 的补充说明' },
      group: { type: 'string', description: 'boredom_reset 的分组名，省略则全部清零' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'recall') {
        const query = String(args.query ?? '').trim()
        if (query) {
          const hits = store.searchAll(query, 8)
          return ok({ query, hits, hint: hits.length ? '这些是匹配到的片段。' : '没翻到相关的，可能还没记过。' })
        }
        return ok({ core: bodyLines(store.coreRaw(), 20, 4000), recent: store.recentShort(12) })
      }
      if (action === 'core_add') {
        const text = String(args.text ?? '').replace(/\r?\n/g, ' ').trim()
        if (!text) return fail('text 不能为空')
        store.coreAdd(text)
        return ok({ added: truncate(text, 300), where: 'memory/core.md' })
      }
      if (action === 'recent') return ok({ recent: store.recentShort(clamp(Number(args.limit ?? 8), 1, 30)) })
      if (action === 'mood_get') return ok({ emotion: store.emotionGet() })
      if (action === 'mood_set') {
        const mood = String(args.mood ?? '').trim()
        if (!mood) return fail('mood 不能为空')
        return ok({ emotion: store.emotionSet({ mood, energy: clamp(Number(args.energy ?? 60), 0, 100), note: String(args.note ?? '') }) })
      }
      if (action === 'boredom_get') {
        const policy = store.policyGet()
        return ok({ boredom: store.boredomView(policy), rule: '接近阈值就该换事；换一件别的事会让这项自然回落。' })
      }
      if (action === 'boredom_reset') {
        return ok({ boredom: store.boredomReset(args.group ? String(args.group) : undefined) })
      }
      if (action === 'satisfaction_get') {
        return ok({
          satisfaction: store.satisfactionView(store.policyGet()),
          rule: '满足度只能在 B 站上真实做事获得：刷视频/直播少量，发弹幕/评论/私信中量，别人回复/点赞/@/私信等认可大量；满了才允许收尾关对话。',
        })
      }
      if (action === 'satisfaction_reset') {
        return ok({
          satisfaction: store.satisfactionView(store.policyGet()),
          reset: store.satisfactionReset(),
          rule: '只在本人明确要求时清零；不要拿它绕过“满足度满了才收尾”。',
        })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_relation',
    '对 B 站上具体账号的印象和关系：list 看所有认识的人，get 看某人的档案，note 记一次互动或改印象。印象写具体（他关心什么、说话什么风格、上次聊到哪），别写空话。',
    {
      action: { type: 'string', enum: ['list', 'get', 'note'], description: '操作' },
      uid: { type: 'string', description: '对方 UID（note/get 必填）' },
      name: { type: 'string', description: '对方昵称' },
      impression: { type: 'string', description: '印象 / 这次互动的观察' },
      event: { type: 'string', description: '这次发生了什么（会追加到互动记录）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 8 个' },
      closeness: { type: 'integer', description: '关系变化 -2 到 +2，默认 0' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'list') return ok({ relations: store.relationList(), count: store.relationList().length })
      if (action === 'get') {
        const uid = String(args.uid ?? '').trim()
        if (!uid) return fail('uid 不能为空')
        return ok({ relation: store.relationGet(uid) })
      }
      if (action === 'note') {
        const uid = String(args.uid ?? '').trim()
        if (!uid) return fail('uid 不能为空')
        const meta = store.relationNote({
          uid,
          name: args.name,
          impression: args.impression,
          event: args.event ?? args.impression,
          tags: args.tags,
          closenessDelta: clamp(Number(args.closeness ?? 0), -2, 2),
        })
        return ok({ relation: meta, file: store.relationPath(uid) })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_thread',
    '总线程：同一时间只做一件事。current 看手头；start 开一件（已经有活会拒绝，必须先 finish/abandon）；step 记进展；finish 收尾并写进度；abandon 放弃并写原因。B 站写操作之前必须有 active 线程。',
    {
      action: { type: 'string', enum: ['current', 'start', 'step', 'finish', 'abandon'], description: '操作' },
      title: { type: 'string', description: 'start 的线程标题，具体一点' },
      capability: { type: 'string', description: 'start 的能力 id，如 task.research / task.create / task.social' },
      note: { type: 'string', description: 'start 的备注或 step 的进展' },
      result: { type: 'string', description: 'finish 的结果 / abandon 的原因' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'current') {
        const doc = store.threadGet()
        return ok({ thread: doc.thread ?? null, status: doc.status, last: doc.last ?? null })
      }
      if (action === 'start') {
        const title = String(args.title ?? '').trim()
        if (!title) return fail('title 不能为空')
        const capability = String(args.capability ?? 'task.research')
        const resolved = resolveCapability(capability)
        if (!resolved || resolved.kind !== 'task') {
          return fail('capability 要用任务类 id：task.research / task.create / task.review / task.social / task.explore / task.rest')
        }
        const result = store.threadStart({ title, capability: resolved.id, note: args.note })
        if (!result.ok) return fail(result.message, { busy: true, thread: result.thread })
        return ok({ thread: result.thread, note: '一次只推这一件。做完记得 finish。' })
      }
      if (action === 'step') {
        const result = store.threadStep(String(args.note ?? args.result ?? ''))
        if (!result.ok) return fail(result.message)
        return ok({ thread: result.thread })
      }
      if (action === 'finish') {
        const result = store.threadFinish({ result: args.result ?? args.note ?? '' })
        if (!result.ok) return fail(result.message)
        return ok({ finished: result.last, note: '已写入 progress.md' })
      }
      if (action === 'abandon') {
        const result = store.threadAbandon(args.result ?? args.note ?? '')
        if (!result.ok) return fail(result.message)
        return ok({ abandoned: result.last })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_plan',
    '规划与进度：get 读 plan + progress；set 重写规划（保持短）；add 加一条待办；done 把某条待办打勾并写进进度。规划一次只留 1 件进行中，别列一堆。',
    {
      action: { type: 'string', enum: ['get', 'set', 'add', 'done'], description: '操作' },
      content: { type: 'string', description: 'set 的完整规划正文' },
      item: { type: 'string', description: 'add 的待办内容，或 done 要打勾的那条（包含关键词即可）' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'get') {
        return ok({ plan: store.readDoc('plan'), progress: store.readDoc('progress') })
      }
      if (action === 'set') {
        const content = String(args.content ?? '')
        if (!content.trim()) return fail('content 不能为空')
        if (bodyLines(content, 100, 10000).length > 12) return fail('规划太长了，压到 12 行以内。')
        store.writeDoc('plan', content)
        return ok({ plan: store.readDoc('plan') })
      }
      if (action === 'add') {
        const item = truncate(String(args.item ?? '').replace(/\r?\n/g, ' ').trim(), 160)
        if (!item) return fail('item 不能为空')
        store.appendDoc('plan', `- [ ] ${item}`)
        return ok({ added: item })
      }
      if (action === 'done') {
        const item = String(args.item ?? '').trim()
        const current = store.readDoc('plan')
        const lines = current.split(/\r?\n/)
        let hit = null
        if (item) {
          for (let i = 0; i < lines.length; i += 1) {
            if (/^-\s*\[ \]/.test(lines[i]) && lines[i].toLowerCase().includes(item.toLowerCase())) {
              hit = i
              break
            }
          }
        }
        if (hit === null) {
          const open = lines.filter((line) => /^-\s*\[ \]/.test(line))
          return fail(item ? `没找到包含「${item}」的待办。` : '要给 item 才直到勾哪条。', { open })
        }
        lines[hit] = lines[hit].replace('[ ]', '[x]')
        store.writeDoc('plan', lines.join('\n'))
        const doneText = lines[hit].replace(/^-\s*\[x\]\s*/, '')
        store.appendDoc('progress', `- 完成：${truncate(doneText, 120)}`)
        return ok({ done: doneText })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_learn',
    '学习模式：管理学习目标和已经学会的技能。status 看目标/技能；goal_add 加目标（title/why/targets）；goal_update 改进度/状态；skill_add 记录新技能（name/goalId/level/summary/evidence/source）；skill_update 改技能。学习目标要短、能落到具体动作，别写成口号。',
    {
      action: { type: 'string', enum: ['status', 'goal_add', 'goal_update', 'skill_add', 'skill_update'], description: '操作' },
      goalId: { type: 'string', description: '目标 id（goal_update 用）' },
      skillId: { type: 'string', description: '技能 id（skill_update 用）' },
      title: { type: 'string', description: '目标标题（goal_add）' },
      why: { type: 'string', description: '为什么要学（goal_add）' },
      targets: { type: 'string', description: '拆成几个可练的小点，用逗号分隔（goal_add/goal_update）' },
      progress: { type: 'number', description: '进度 0-100（goal_update）' },
      goalStatus: { type: 'string', enum: ['learning', 'paused', 'done'], description: '目标状态（goal_update）' },
      name: { type: 'string', description: '技能名（skill_add/skill_update）' },
      level: { type: 'string', enum: ['入门', '会用', '熟练'], description: '技能熟练度' },
      summary: { type: 'string', description: '一句话说清学会了什么、怎么用' },
      evidence: { type: 'string', description: '证据/例子，用逗号分隔' },
      source: { type: 'string', description: '从哪学的，如某个视频/评论区/自己试出来的' },
    },
    ['action'],
    async (args = {}) => {
      try {
        const action = String(args.action)
        if (action === 'status') return ok(store.learningView())
        if (action === 'goal_add') return ok({ goal: store.learningGoalAdd(args) })
        if (action === 'goal_update') {
          const patch = { ...args }
          if (args.goalStatus !== undefined) patch.status = args.goalStatus
          return ok({ goal: store.learningGoalUpdate(args.goalId, patch) })
        }
        if (action === 'skill_add') return ok({ skill: store.learningSkillAdd(args) })
        if (action === 'skill_update') return ok({ skill: store.learningSkillUpdate(args.skillId, args) })
        return fail('未知 action')
      } catch (error) {
        return fail(String(error.message || error))
      }
    },
  ))

  add(defineTool(
    'feiyu_act',
    '非 B 站动作的总闸：check 查某个任务能不能做（会看权限、安静时段、厌倦度和限额）；begin 开始一件事（会开总线程，已经有活会拒绝）；end 收尾。B 站动作不要用这个，用 feiyu_bili。',
    {
      action: { type: 'string', enum: ['check', 'begin', 'end'], description: '操作' },
      capability: { type: 'string', description: '任务能力 id，如 task.research / task.create / task.review / task.social / task.explore / task.rest' },
      note: { type: 'string', description: 'begin 的标题 / end 的结果' },
    },
    ['action'],
    async (args) => {
      const action = String(args.action)
      if (action === 'check') {
        const cap = resolveCapability(args.capability)
        if (!cap) return fail('未知能力')
        return ok({ capability: cap.id, ...check(store, cap, {}, { dryRun: true }) })
      }
      if (action === 'begin') {
        const cap = resolveCapability(args.capability)
        if (!cap) return fail('未知能力')
        if (cap.bridge) return fail('B 站动作请用 feiyu_bili。')
        if (ensureActiveThread(store)) {
          return fail('手头还有事没做完，先 feiyu_thread finish 或 abandon。', { thread: ensureActiveThread(store) })
        }
        const verdict = check(store, cap, {}, { dryRun: true })
        if (verdict.decision !== 'allow') return fail(verdict.reason, { decision: verdict.decision, alternatives: verdict.alternatives })
        const started = store.threadStart({ title: String(args.note ?? cap.label), capability: cap.id, note: args.note })
        store.recordActivity(cap)
        store.logAction({ capability: cap.id, kind: 'task', status: 'started', summary: truncate(String(args.note ?? cap.label), 160) })
        return ok({ thread: started.thread, decision: 'allow' })
      }
      if (action === 'end') {
        const doc = store.threadGet()
        if (doc.status !== 'active') return fail('现在没有进行中的线程。')
        const result = store.threadFinish({ result: args.note ?? '' })
        store.logAction({ capability: doc.thread.capability, kind: 'task', status: 'done', summary: truncate(String(args.note ?? ''), 160) })
        return ok({ finished: result.last })
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_bili',
    '统一 B 站动作入口。刷 B 站先看 `home_feed`（登录态个性化首页推荐），再看 `hot`/`rank`/`weekly` 补；读：直接执行并返回数据；写：先 feiyu_thread start 开总线程。高度自主下评论/弹幕/私信/点赞/收藏/关注直接执行（仍受限额、风控、安静时段约束）；发布视频/投稿、投币等高风险动作才生成审批项，人类批准后带 approvalId 重调。action 用能力 id（home_feed / search / video_info / video_comments / user_dynamics / live_roam / comment_add / dm_send …），action="limits" 只读查看剩余额度；action="catalog" 看全部可用动作和参数说明；评论和私信可在 args.pic 传素材 id 或图片路径。回复某条评论要带 args.rpid，才会在那条评论下回复；不传 rpid 才会新开顶层评论，别自己在正文里补 @。dryRun=true 只查权限不执行；没开线程也能用 dryRun 探测限额。dm_send 只写一两句像聊天，不写小作文；发完会进入 waitForMessage，对方回私信会直接叫醒当前会话。',
    {
      action: { type: 'string', description: '能力 id，如 home_feed、search、video_info、comment_add；或 catalog' },
      args: { type: 'object', description: '动作参数，如 {keyword:"…", page:1}、{bvid:"BV…"}、{bvid:"BV…", text:"…", pic:"素材id"}', additionalProperties: true },
      approvalId: { type: 'string', description: '审批项 id（人类批准后带上）' },
      dryRun: { type: 'boolean', description: '只看权限和限额，不执行' },
    },
    ['action'],
    async (input) => {
      const action = String(input.action ?? '').trim()
      if (action === 'catalog') {
        return ok({
          read: bridgeCapabilities().filter((cap) => cap.kind === 'read').map((cap) => ({ id: cap.id, label: cap.label, group: cap.group, args: ARG_HINTS[cap.action] ?? '' })),
          write: bridgeCapabilities().filter((cap) => cap.kind !== 'read').map((cap) => ({ id: cap.id, label: cap.label, kind: cap.kind, args: ARG_HINTS[cap.action] ?? '', limit: cap.limit ?? null })),
        })
      }
      if (action === 'limits') {
        const policy = store.policyGet()
        const now = Date.now()
        const hourAgo = now - 3600000
        const dayAgo = now - 86400000
        const count = (capId, since) => store.countSince(since, (entry) => entry.capability === capId && entry.status === 'done')
        const writes = store.countSince(hourAgo, (entry) => ['write', 'publish'].includes(entry.kind) && entry.status === 'done')
        const limits = policy.limits || {}
        const used = {
          writePerHour: writes,
          dmPerDay: count('bili.dm_send', dayAgo),
          commentPerDay: count('bili.comment_add', dayAgo),
          danmakuPerHour: count('bili.danmaku_send', hourAgo) + count('bili.live_danmaku', hourAgo),
          likePerHour: count('bili.like', hourAgo),
          publishPerDay: count('bili.video_publish', dayAgo),
        }
        return ok({
          autonomy: policy.autonomy,
          unlimited: limits.unlimited === true,
          dmUnlimited: limits.dmUnlimited === true,
          limits,
          used,
          note: limits.unlimited === true
            ? '六条数量限额全部不限：写/小时、评论/天、私信/天、投稿/天、弹幕/小时、点赞/小时都跳过；风控、安静时段、厌倦度仍生效。'
            : '这是只读探测，不消耗次数。要探测某个动作是否会被限额，也可以用 feiyu_bili action=<动作> dryRun=true。',
        })
      }
      const cap = resolveCapability(action)
      if (!cap || !cap.bridge) return fail(`未知的 B 站动作「${action}」。action="catalog" 看清单。`)
      const args = (input.args && typeof input.args === 'object') ? { ...input.args } : {}
      delete args.approvalId
      // 顶层 dryRun 是“只演练”的硬开关：必须一路传到桥，不能被高度自主/审批放行后改成真发。
      if (input.dryRun === true) args.dryRun = true
      if (assets && (cap.id === 'bili.comment_add' || cap.id === 'bili.dm_send')) {
        const pic = String(args.pic || args.image || '').trim()
        if (pic) {
          const file = assets.resolve(pic)
          if (!file) return fail('找不到这张图：素材 id 或路径无效（先在总控台「素材」页确认）', { code: 'BAD_IMAGE' })
          args.pic = file
          delete args.image
        }
      }
      const isWrite = cap.kind !== 'read' && cap.kind !== 'task'
      // dryRun 不应因为没开线程就停在 NO_THREAD：让它继续到权限/限额检查，才能探测“正式发会不会被拦”。
      if (isWrite && input.dryRun !== true && !ensureActiveThread(store)) {
        return fail('写操作之前先开总线程：feiyu_thread start（status 会绑在这件事上），再回来。', { code: 'NO_THREAD', capability: cap.id })
      }
      const verdict = check(store, cap, args, { dryRun: input.dryRun === true, approvalId: input.approvalId })
      if (verdict.decision === 'deny') {
        store.logAction({
          capability: cap.id,
          kind: cap.kind,
          status: 'denied',
          argsHash: hash(args),
          error: String(verdict.reason ?? '拒绝').slice(0, 500),
          summary: verdict.limit ? `限额 ${verdict.limit.used}/${verdict.limit.limit}（${verdict.limit.window}）` : '',
        })
        return fail(verdict.reason, { decision: 'deny', capability: cap.id, alternatives: verdict.alternatives ?? [], limit: verdict.limit ?? null })
      }
      if (verdict.decision === 'ask') return fail(verdict.reason, { decision: 'ask', capability: cap.id })
      if (verdict.decision === 'pending') {
        return fail(verdict.reason, {
          decision: 'pending',
          capability: cap.id,
          pendingId: verdict.pendingId,
          summary: verdict.summary,
          duplicate: verdict.duplicate === true,
        })
      }
      if (verdict.decision === 'approved' && input.dryRun !== true) {
        const consumed = store.pendingConsume(verdict.approvalId, cap.id, verdict.argsHash)
        if (!consumed.ok) return fail(consumed.error)
      }

      const startedAt = Date.now()
      // 人类批准，或高度自主直接放行：这时才把桥的安全默认 dryRun 关掉。
      // 显式传 dryRun:true 的调用仍然只做演练。
      const realWriteAllowed = isWrite && (verdict.decision === 'approved' || verdict.decision === 'allow')
      const bridgeArgs = realWriteAllowed && args.dryRun !== true ? { ...args, dryRun: false } : args
      const result = await runBridge(rootDir, store.configGet(), cap.action, bridgeArgs)
      const ms = Date.now() - startedAt
      const risk = riskFromResult(result)
      if (risk.hit) {
        const record = store.riskSet(24, risk.reason, risk.code)
        store.logAction({ capability: cap.id, kind: cap.kind, status: 'error', argsHash: hash(args), error: risk.reason, summary: truncate(JSON.stringify(result).slice(0, 300), 300) })
        return fail(`触发风控：${risk.reason}。已停止写操作 24 小时（到 ${record.until}），这期间只读。`, { decision: 'risk', risk: record, detail: result })
      }
      if (!result.ok) {
        store.logAction({ capability: cap.id, kind: cap.kind, status: 'error', argsHash: hash(args), error: String(result.error ?? '执行失败'), summary: truncate(JSON.stringify(result).slice(0, 300), 300) })
        return fail(String(result.error ?? '桥执行失败'), { code: result.code ?? 'BRIDGE_ERROR', detail: result })
      }
      if (cap.action === 'whoami') store.loginSet({ ok: true, ...(result.data ?? {}) })
      if (cap.weight > 0 && input.dryRun !== true) store.recordActivity(cap)
      const gain = satisfactionGainFor(cap)
      if (gain > 0 && input.dryRun !== true) {
        store.satisfactionAdd(gain, cap.id, cap.label)
      }
      let watch = null
      if (cap.id === 'bili.dm_send' && input.dryRun !== true && feedback?.watch) {
        const targetUid = args.uid ?? args.receiver ?? args.to ?? ''
        if (String(targetUid).trim()) watch = feedback.watch(targetUid, { minutes: 10 })
      }
      store.logAction({
        capability: cap.id,
        kind: cap.kind,
        // dry-run 不能算进限额/账本完成数，否则“探测一次”就等于真的用掉一次。
        status: input.dryRun === true ? 'dry_run' : 'done',
        argsHash: hash(args),
        summary: summarizeResult(cap, result.data),
        ms,
      })
      return ok({
        capability: cap.id,
        label: cap.label,
        data: result.data,
        watch,
        meta: {
          ms,
          boredom: store.boredomView(store.policyGet()).activities.find((item) => item.group === cap.group)?.value ?? 0,
          satisfaction: store.satisfactionView(store.policyGet()).value,
          thread: store.threadGet().thread?.title ?? null,
        },
      })
    },
  ))

  add(defineTool(
    'feiyu_pending',
    '看审批队列：list 列出等待人类点头的动作（可在总控台批准/拒绝），get 看单项详情。注意：你只能申请和查看，不能自己批准自己。',
    {
      action: { type: 'string', enum: ['list', 'get'], description: '操作' },
      id: { type: 'string', description: '审批项 id（get 必填）' },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'executed'], description: 'list 的状态过滤，默认 pending' },
    },
    ['action'],
    async (args) => {
      if (String(args.action) === 'list') {
        const status = args.status ? String(args.status) : 'pending'
        return ok({ status, items: store.pendingList({ status }) })
      }
      if (String(args.action) === 'get') {
        const record = store.pendingGet(String(args.id ?? ''))
        return record ? ok({ item: record }) : fail('没有这个审批项')
      }
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_tick',
    '自主行动脉冲：把此刻的情绪、厌倦度、总线程、待审批、风控、心跳状态和建议的下一步一次给你。想找事做、或不确定现在该干嘛时调它。返回建议只是建议，可以什么都不做。',
    {
      note: { type: 'string', description: '可选备注，会记进心跳记录' },
    },
    [],
    async () => {
      const pulse = buildPulse(store)
      return ok({ pulse, rule: '一次只挑一件事；写操作先 feiyu_thread start；做了就记。' })
    },
  ))

  add(defineTool(
    'feiyu_feedback',
    '看 B 站互动反馈：status 看开关、上次检查、未读数；check 立即查一次有没有新回复/@/赞/私信；watch 监听某个人的私信回复（不结束会话，收到就 followup 叫醒当前会话）；unwatch 取消监听。有新的会同步成一条消息发到当前会话；高度自主下可以自己判断回不回，日常互动自动执行，发布/投币仍审批。',
    {
      action: { type: 'string', enum: ['status', 'check', 'watch', 'unwatch'], description: '操作' },
      uid: { type: 'string', description: 'watch 时要监听的对方 UID' },
      minutes: { type: 'number', description: 'watch 监听多少分钟，默认 10，最大 120' },
    },
    ['action'],
    async (args = {}) => {
      if (!feedback) return fail('互动反馈模块没装好')
      if (args.action === 'status') return ok({ feedback: feedback.status() })
      if (args.action === 'check') return ok({ result: await feedback.poll({ manual: true }) })
      if (args.action === 'watch') return ok(feedback.watch(args.uid, { minutes: args.minutes ?? 10 }))
      if (args.action === 'unwatch') return ok(feedback.clearWatch())
      return fail('未知 action')
    },
  ))

  add(defineTool(
    'feiyu_studio',
    '视频创作与投稿入口。status 看环境；assets 看素材库；analyze 解析本地参考视频（source 可空，空则自动造一段 6 秒参考片）；produce 用解析结果/主题生成口播、配音、画面并合成 mp4（source/analysisId 都可空：空则按主题用本地草稿自己写；assetIds 可指定素材图，按场景轮换，coverAssetId 指定封面）；pipeline 走大肥鱼自己的七步流水线：lines 台词数组 → 豆包逐句配音 → PIL 卡片 → ffmpeg 底板 → build.py 烧字幕/混音/母带 → 联系表，text 可传多行台词，shotlistPath 可读分镜文件；image 生成剪辑素材图；publish 提交投稿审批（必须已有总线程，人类批准后带 approvalId 执行）。没有配置文本/画面/语音 API 时会用本地草稿和占位画面，别假装画面很精美。',
    {
      action: { type: 'string', enum: ['status', 'assets', 'asset_import', 'analyze', 'produce', 'pipeline', 'job', 'publish', 'clean', 'image'], description: '要做的动作' },
      source: { type: 'string', description: '本地视频路径（analyze/produce，可空：analyze 会自动造参考片，produce 会按主题自己写）' },
      topic: { type: 'string', description: '主题（produce/pipeline）' },
      text: { type: 'string', description: '多行台词（pipeline；每行一句，可写 [情绪] 台词）' },
      lines: { type: 'array', items: { type: 'object' }, description: '台词数组（pipeline）：[{seg?,name?,instr?,gap?,text,video?,crop?}]；video 给本地录屏片段时该段用录屏而不是卡片' },
      shotlistPath: { type: 'string', description: '分镜/台词文件路径（pipeline 可选，Markdown 每行一句）' },
      voice: { type: 'string', description: '豆包音色（pipeline，默认撒娇学妹）' },
      prompt: { type: 'string', description: '图片描述（image）' },
      path: { type: 'string', description: '要导入的图片路径（asset_import）' },
      name: { type: 'string', description: '导入后的文件名（asset_import 可选）' },
      analysisId: { type: 'string', description: '已有解析任务 id（produce 可选，可空）' },
      assetIds: { type: 'array', items: { type: 'string' }, description: '素材 id 列表（produce 可选）' },
      coverAssetId: { type: 'string', description: '封面素材 id（produce 可选）' },
      jobId: { type: 'string', description: '任务 id（job/publish）' },
      approvalId: { type: 'string', description: '人类批准后的审批项 id（publish 执行）' },
      title: { type: 'string', description: '投稿标题（publish 可选）' },
      desc: { type: 'string', description: '投稿简介（publish 可选）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签（publish 可选）' },
      tid: { type: 'number', description: '分区 id（publish 可选）' },
    },
    ['action'],
    async (args = {}) => {
      if (!studio) return fail('创作模块没装好')
      try {
        if (args.action === 'status') return ok({ status: await studio.status() })
        if (args.action === 'assets') return ok({ assets: assets ? assets.publicList({ force: true }) : [] })
        if (args.action === 'asset_import') {
          if (!assets) return fail('素材模块没装好')
          if (!args.path) return fail('要给图片路径')
          const item = assets.importFile(args.path, args.name)
          return ok({ asset: { ...item, url: `/dafeiyu/api/assets/file?id=${item.id}` } })
        }
        if (args.action === 'analyze') {
          return ok({ job: await studio.analyze(args.source) })
        }
        if (args.action === 'produce') {
          return ok({ job: await studio.produce({
            source: args.source, topic: args.topic, analysisId: args.analysisId,
            assetIds: args.assetIds, coverAssetId: args.coverAssetId,
          }) })
        }
        if (args.action === 'pipeline') {
          return ok({ job: await studio.pipeline({
            title: args.title, topic: args.topic, text: args.text, lines: args.lines,
            voice: args.voice, shotlistPath: args.shotlistPath,
            assetIds: args.assetIds, coverAssetId: args.coverAssetId,
          }) })
        }
        if (args.action === 'job') {
          if (!args.jobId) return fail('要给 jobId')
          return ok({ job: studio.getJob(args.jobId) })
        }
        if (args.action === 'clean') return ok({ clean: await studio.cleanCache() })
        if (args.action === 'image') {
          if (!args.prompt) return fail('要给图片描述 prompt')
          return ok({ image: await studio.createImage({ prompt: args.prompt }) })
        }
        if (args.action === 'publish') {
          if (!args.jobId) return fail('要给要发布的 jobId')
          const thread = ensureActiveThread(store)
          if (!thread) return fail('投稿前先开总线程：feiyu_thread start', { code: 'NO_THREAD' })
          const payload = studio.publishPayload(args.jobId, { title: args.title, desc: args.desc, tags: args.tags, tid: args.tid })
          const verdict = check(store, 'bili.video_publish', payload, { approvalId: args.approvalId })
          if (verdict.decision === 'deny') return fail(verdict.reason, { alternatives: verdict.alternatives })
          if (verdict.decision === 'pending' || verdict.decision === 'ask') {
            return ok({ status: 'pending', pendingId: verdict.pendingId, message: verdict.reason || '等你批准' })
          }
          if (verdict.decision === 'approved') {
            const result = await studio.executePublish({ approvalId: args.approvalId })
            store.recordActivity('task.create')
            return ok({ status: 'published', result })
          }
          return fail(verdict.reason || '发布被拦住了')
        }
        return fail(`未知 action：${args.action}`)
      } catch (error) {
        return fail(String(error.message || error))
      }
    },
  ))

  add(defineTool(
    'feiyu_library',
    '素材与项目库：把一部片子当成一个项目，按 manifest 管理卡片/立绘/配音/底板/QC，而不是到处散着。list 看现有项目和素材索引；project 看一个项目的 manifest；create 建新项目空目录；add 把外部图片/音频/视频复制进项目并登记；materialize 只建 projects/<项目>/manifest.json 和空目录，不移动原文件；plan 看把旧 work 目录迁到 projects 的预览；scan 重扫。所有操作都不删除、不覆盖成片。',
    {
      action: { type: 'string', enum: ['list', 'project', 'create', 'add', 'materialize', 'plan', 'scan'], description: '要做的动作' },
      name: { type: 'string', description: '项目名/目录名（project/add/materialize）' },
      file: { type: 'string', description: '源文件绝对路径（add）' },
      role: { type: 'string', description: '素材角色：card 卡片 / character 立绘 / cover 封面 / watermark 水印 / sticker 贴纸 / ref 参考 / vo 配音 / base 底板 / qc 验片 / sfx 音效 / bgm 音乐' },
      assetName: { type: 'string', description: '导入后的文件名（add 可选）' },
      all: { type: 'boolean', description: 'materialize 时给所有未建清单的项目建清单' },
    },
    ['action'],
    async (args = {}) => {
      if (!library) return fail('素材库模块没装好')
      try {
        if (args.action === 'list' || args.action === 'scan') {
          const data = library.status()
          return ok({
            ...data,
            projects: data.projects.map(({ assets: _assets, ...rest }) => rest),
          })
        }
        if (args.action === 'project') {
          if (!args.name) return fail('要给项目名')
          const project = library.project(args.name)
          return ok({ project, manifest: library.projectManifest(project) })
        }
        if (args.action === 'create') {
          if (!args.name) return fail('要给项目名')
          return ok({ created: library.createProject({ name: args.name }) })
        }
        if (args.action === 'add') {
          if (!args.name) return fail('要给项目名')
          if (!args.file) return fail('要给源文件路径')
          return ok({ added: library.addAsset({ project: args.name, file: args.file, role: args.role, name: args.assetName }) })
        }
        if (args.action === 'materialize') {
          if (args.all) return ok({ materialized: library.materializeAll() })
          if (!args.name) return fail('要给项目名，或传 all:true')
          return ok({ materialized: library.materialize(args.name) })
        }
        if (args.action === 'plan') return ok({ plan: library.plan() })
        return fail(`未知 action：${args.action}`)
      } catch (error) {
        return fail(String(error.message || error))
      }
    },
  ))

  add(defineTool(
    'feiyu_chat',
    '聊天收尾闸。status 看满足度；只有满足度满了（value >= threshold）才能用 close 结束这段对话。close 前必须先在 plan 参数里给出更新后的规划（下一步做什么、放弃什么），插件会写回 plan.md。满足度只能靠 B 站上的真实行为上涨：刷视频/直播少量，发弹幕/评论/私信中量，别人回复/点赞/@/私信等认可大量。没满就继续聊或去做能涨满足的事，不要用“我累了/没事了”空心收尾。',
    {
      action: { type: 'string', enum: ['status', 'close'], description: 'status 看满足度 / close 申请结束对话' },
      note: { type: 'string', description: 'close 时的收尾语或原因（可选）' },
      plan: { type: 'string', description: 'close 时更新后的 plan.md 正文：下一步做什么、放弃什么；最多 2000 字' },
    },
    ['action'],
    async (args = {}) => {
      const policy = store.policyGet()
      const view = store.satisfactionView(policy)
      if (args.action === 'status') {
        return ok({ satisfaction: view, canClose: view.full, planRequired: true, currentPlan: store.readDoc('plan'), rule: '满足度满了才有资格关对话；关之前先改 plan，并把新 plan 传给 close。' })
      }
      if (args.action !== 'close') return fail(`未知 action：${args.action}`)
      if (!view.full) {
        return fail(`满足度还没满（${view.value}/${view.threshold}，还差 ${view.missing}），先别关对话。可以刷视频/直播、发弹幕/评论/私信，或等别人的回复/点赞/@/私信。`, {
          code: 'NOT_SATISFIED',
          satisfaction: view,
        })
      }
      const closing = {
        closedAt: nowIso(),
        satisfaction: view.value,
        note: truncate(String(args.note ?? ''), 300),
      }
      const plan = truncate(String(args.plan ?? '').trim(), 2000)
      if (!plan) {
        return fail('收尾前先把规划改了：在 close 的 plan 参数里写下一步做什么、放弃什么，再关对话。', {
          code: 'PLAN_REQUIRED',
          currentPlan: store.readDoc('plan'),
        })
      }
      store.writeDoc('plan', plan)
      store.satisfactionMarkClosed(closing.note)
      store.appendDoc('progress', `- ${closing.closedAt.slice(0, 16).replace('T', ' ')} 满足度满（${view.value}/${view.threshold}），收尾关对话。${closing.note ? ` ${closing.note}` : ''}`)
      return ok({
        ...closing,
        planUpdated: true,
        satisfaction: store.satisfactionView(store.policyGet()),
        message: '满足度已满，规划已更新，可以收尾了。收尾语要短、具体，别写客服式总结。',
      })
    },
  ))

  add(defineTool(
    'feiyu_live',
    '直播入口。status 看直播姬是否安装/运行、直播间信息；launch 启动直播姬；check 只读检查直播间；start 在打开“自动开播”后尝试用 UI Automation 点开始直播，失败会如实返回按钮列表，不假装成功。',
    {
      action: { type: 'string', enum: ['status', 'launch', 'check', 'start'], description: '要做的动作' },
    },
    ['action'],
    async (args = {}) => {
      if (!live) return fail('直播模块没装好')
      try {
        if (args.action === 'status') return ok({ status: await live.status() })
        if (args.action === 'launch') return ok({ launch: await live.launch() })
        if (args.action === 'check') return ok({ check: await live.check() })
        if (args.action === 'start') return ok({ start: await live.start() })
        return fail(`未知 action：${args.action}`)
      } catch (error) {
        return fail(String(error.message || error))
      }
    },
  ))

  return () => {
    for (const disposer of disposers.reverse()) {
      try { disposer?.() } catch {}
    }
  }
}

function hash(args) {
  try {
    return JSON.stringify(args ?? {}).length.toString(36).slice(0, 4)
  } catch {
    return ''
  }
}

function summarizeResult(cap, data) {
  try {
    if (cap.id === 'bili.search') {
      const items = data?.items ?? data?.list ?? data?.data?.list ?? []
      return `搜到 ${items.length ?? 0} 条：${(items[0]?.title ?? '').slice(0, 60)}`
    }
    if (cap.id === 'bili.whoami') return `登录身份：${data?.uname ?? data?.name ?? '未知'}`
    if (cap.id === 'bili.video_info') return `看了视频：${(data?.title ?? data?.bvid ?? '').slice(0, 60)}`
    if (cap.id === 'bili.live_roam') return `巡了 ${(data?.rooms ?? data?.items ?? []).length ?? 0} 个直播间`
    if (cap.id === 'bili.comment_add') {
      if (data?.visible === false) return `评论已提交，但 B 站 state=${data?.state ?? '?'}：审核中/仅自己可见`
      if (data?.visible === true) return '发了一条评论，已公开可见'
      return '发了一条评论（可见性未确认）'
    }
    if (cap.id === 'bili.comment_state') {
      return data?.visible === true ? '评论已公开可见' : `评论不可见：state=${data?.state ?? '?'}`
    }
    if (cap.id === 'bili.dm_send') return '发了一条私信'
    if (cap.id === 'bili.dynamic_post') return '发了一条动态'
    return truncate(JSON.stringify(data ?? {}), 160)
  } catch {
    return cap.label
  }
}

const ARG_HINTS = {
  home_feed: '{limit?, freshType?}',
  search: '{keyword, page?, order?}',
  hot: '{page?}',
  rank: '{day?}',
  weekly: '{}',
  video_info: '{bvid}',
  video_comments: '{bvid, page?}',
  video_danmaku: '{bvid}',
  video_subtitle: '{bvid}',
  user_info: '{uid}',
  user_videos: '{uid, page?}',
  user_dynamics: '{uid, page?}',
  following: '{page?}',
  relation_status: '{uid}',
  favorites: '{uid?}',
  favorite_content: '{mediaId, page?}',
  live_room: '{roomId}',
  live_roam: '{page?, pageSize?}',
  live_online: '{roomId}',
  messages_unread: '{}',
  messages_sessions: '{}',
  messages_replies: '{page?}',
  messages_at: '{page?}',
  comments: '{bvid, limit?}',
  comment_add: '{bvid, text, pic?, rpid?（回复某条评论时传，挂在该评论下；不要自己加 @）, root?（回楼中楼时传该楼根评论 rpid）}',
  comment_state: '{bvid, rpid, root?（回楼时传根评论 rpid；不传会自动搜最近楼）}',
  like: '{bvid, action?}',
  coin: '{bvid, count?}',
  favorite: '{bvid, add?}',
  triple: '{bvid}',
  follow: '{uid, action?}',
  danmaku_send: '{bvid, text, time?（秒）}',
  live_danmaku: '{roomId, text（≤20字）}',
  dm_send: '{uid, text（一两句，像聊天）, pic?}',
}

/**
 * 满足度只能从 B 站真实行为里涨：
 * 刷/看少量，发弹幕/评论/私信中量，点赞/投币/收藏/关注是轻互动；
 * 别人给的回复/赞/@/私信走 feedback.js 的大额“认可”。
 */
function satisfactionGainFor(cap) {
  const action = cap?.action
  if (!action || action === 'whoami') return 0
  if (action === 'comment_add' || action === 'dm_send' || action === 'danmaku_send' || action === 'live_danmaku') return 8
  if (action === 'like' || action === 'coin' || action === 'favorite' || action === 'triple' || action === 'follow') return 5
  if (action.startsWith('messages_')) return 1
  if (cap.kind === 'read') return 2
  return 0
}

export { defineTool }
