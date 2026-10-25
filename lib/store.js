import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendLine, bodyLines, clamp, dayKey, dshHome, ensureDir, formatBytes, hashArgs,
  inQuietHours, listFiles, localTime, monthKey, mtimeIso, nowIso, parseFrontMatter,
  readJson, readText, shortId, truncate, writeIfMissing, writeJson, writeText,
} from './util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES = path.resolve(HERE, '..', 'templates')

export const DOC_NAMES = ['persona', 'style', 'preferences', 'plan', 'progress', 'heartbeat']

const DEFAULT_POLICY = {
  version: 1,
  requireApproval: true,
  autonomy: 'high',
  autoApprove: [
    'bili.comment_add',
    'bili.dm_send',
    'bili.danmaku_send',
    'bili.live_danmaku',
    'bili.like',
    'bili.favorite',
    'bili.follow',
  ],
  overrides: {},
  limits: {
    writePerHour: 6,
    commentPerDay: 20,
    dmPerDay: 5,
    dmUnlimited: false,
    unlimited: false,
    publishPerDay: 2,
    danmakuPerHour: 12,
    likePerHour: 20,
  },
  quietHours: { enabled: true, start: '23:30', end: '08:30', allowRead: true },
  boredomThreshold: 70,
  chatBoredomThreshold: 65,
  satisfactionThreshold: 70,
  satisfactionDecayPerHour: 1,
  allowForceThread: false,
  persona: { allowTease: true, maxSentences: 4 },
  redlines: [
    '不刷量、不灌水、不引战、不搬运',
    '不冒充真人，不编造亲身经历',
    'AI 参与生成或发布的内容要声明',
    '涉及钱和账号安全只建议，不擅自做',
    '发布视频/投稿、投币、账号安全类动作必须人类批准；日常互动可自主执行',
  ],
}

const DEFAULT_CONFIG = {
  version: 1,
  personaInject: true,
  captureMemory: true,
  heartbeat: {
    enabled: false,
    everyMinutes: 45,
    speedUpWhenLow: true,
    lowEveryMinutes: 15,
    quietStart: '23:30',
    quietEnd: '08:30',
    sessionId: '',
  },
  feedback: {
    enabled: false,
    everyMinutes: 5,
    sessionId: '',
    maxPerPoll: 5,
  },
  social: {
    enabled: false,
    everyMinutes: 60,
    sessionId: '',
    channels: ['comment', 'danmaku'],
    interests: [],
    allowDmUids: [],
    maxPerDay: 3,
    quietStart: '',
    quietEnd: '',
  },
  relation: {
    ownerUid: '',
    ownerName: '',
    chatEvery: 4,
    maxCloseness: 10,
  },
  bili: {
    cookieFile: path.join(dshHome(), 'dafeiyu', 'secrets', 'bili_cookie.json'),
    pythonPath: '',
    bridgeTimeoutMs: 90000,
  },
  studio: {
    enabled: false,
    autoPublish: false,
    heartbeatCreate: false,
    setup: {
      pythonPath: '',
      pluginPath: path.join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-video-understand', 'dsh', 'index.js'),
      ffmpegPath: path.join(dshHome(), 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    },
    analysis: {
      level: 'l1',
      budgetCny: 0.06,
      model: 'mimo-v2.6-flash',
      apiUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
      apiKey: '',
    },
    text: { baseUrl: '', apiKey: '', model: '', temperature: 0.8 },
    tts: { provider: 'sapi', baseUrl: '', apiKey: '', model: '', voice: 'zh-CN-XiaoxiaoNeural', format: 'mp3' },
    image: { baseUrl: '', apiKey: '', model: '', size: '1280x720' },
    assetDirs: [],
    projectsDir: 'D:/你的工作目录/projects',
    legacyWorkDir: 'D:/你的工作目录/work',
    pipeline: {
      editDir: 'D:/你的工作目录/work/edit',
      genLine: '%USERPROFILE%/Documents/deepseek-harness/default-workspace/dafeiyu-voice/gen_line.py',
      rootDir: 'D:/你的项目目录/.dafeiyu-studio',
      voice: '撒娇学妹',
      pitch: 2,
      bgm: '',
      sfxDir: 'D:/你的工作目录/work/research/sfx',
    },
    video: { width: 1280, height: 720, fps: 25, ffmpegPath: '', outputDir: '' },
    publish: { tid: 21, tags: ['AI'], declareAI: true, dynamic: '' },
  },
  live: {
    enabled: false,
    autoStart: false,
    livehimePath: '',
    roomId: 0,
    areaId: 0,
    title: '',
    mode: 'livehime',
    rtmpUrl: '',
    streamKey: '',
  },
}

function findCookieFile() {
  const candidates = [
    process.env.DAFEIYU_COOKIE,
    'D:/你的工作目录/live/data/bili_cookie.json',
    path.join(dshHome(), 'dafeiyu', 'secrets', 'bili_cookie.json'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return candidates[1]
}

function defaultEmotion() {
  return { mood: '平静', valence: 10, energy: 60, note: '刚上线', updatedAt: nowIso() }
}

function defaultBoredom() {
  return { version: 1, activities: {}, chat: { value: 0, lastAt: nowIso(), count: 0 } }
}

function defaultSatisfaction() {
  return { version: 1, value: 0, lastAt: nowIso(), events: [], closedAt: null }
}

function defaultThread() {
  return { version: 1, status: 'idle', thread: null, last: null }
}

function defaultLearning() {
  const at = nowIso()
  return {
    version: 1,
    goals: [
      {
        id: 'lg_talk', title: '学习人类说话方式', why: '少一点客服腔，像人在聊天',
        status: 'learning', progress: 0, targets: ['短句', '接话', '少解释'], note: '',
        createdAt: at, updatedAt: at,
      },
      {
        id: 'lg_slang', title: '学习人类黑话', why: '看懂评论区梗，不硬凹',
        status: 'learning', progress: 0, targets: ['常见梗', '语境', '别乱用'], note: '',
        createdAt: at, updatedAt: at,
      },
      {
        id: 'lg_video', title: '学习 up 主怎么做视频', why: '能独立选题、写脚本、出片',
        status: 'learning', progress: 0, targets: ['选题', '结构', '封面'], note: '',
        createdAt: at, updatedAt: at,
      },
    ],
    skills: [],
    updatedAt: at,
  }
}

function defaultRelations() {
  return { version: 1, items: {} }
}

export class Store {
  constructor(options = {}) {
    this.rootDir = options.rootDir ?? path.resolve(HERE, '..')
    this.templatesDir = options.templatesDir ?? TEMPLATES
    this.stateDir = options.stateDir ?? path.join(dshHome(), 'dafeiyu')
    this.paths = {
      self: path.join(this.stateDir, 'self'),
      memory: path.join(this.stateDir, 'memory'),
      short: path.join(this.stateDir, 'memory', 'short'),
      relations: path.join(this.stateDir, 'relations'),
      pending: path.join(this.stateDir, 'pending'),
      ledger: path.join(this.stateDir, 'ledger'),
      state: path.join(this.stateDir, 'state'),
      core: path.join(this.stateDir, 'memory', 'core.md'),
      emotion: path.join(this.stateDir, 'memory', 'emotion.json'),
      boredom: path.join(this.stateDir, 'memory', 'boredom.json'),
      satisfaction: path.join(this.stateDir, 'memory', 'satisfaction.json'),
      learning: path.join(this.stateDir, 'self', 'learning.json'),
      relationsIndex: path.join(this.stateDir, 'relations', 'index.json'),
      thread: path.join(this.stateDir, 'thread.json'),
      policy: path.join(this.stateDir, 'policy.json'),
      config: path.join(this.stateDir, 'config.json'),
      risk: path.join(this.stateDir, 'state', 'risk.json'),
      login: path.join(this.stateDir, 'state', 'login.json'),
      beat: path.join(this.stateDir, 'state', 'heartbeat.json'),
    }
    this.init()
  }

  init() {
    for (const dir of [
      this.stateDir, this.paths.self, this.paths.memory, this.paths.short,
      this.paths.relations, this.paths.pending, this.paths.ledger, this.paths.state,
    ]) ensureDir(dir)

    const templateMap = {
      persona: path.join(this.templatesDir, 'persona.md'),
      style: path.join(this.templatesDir, 'style.md'),
      preferences: path.join(this.templatesDir, 'preferences.md'),
      plan: path.join(this.templatesDir, 'plan.md'),
      progress: path.join(this.templatesDir, 'progress.md'),
      heartbeat: path.join(this.templatesDir, 'heartbeat.md'),
    }
    for (const [name, template] of Object.entries(templateMap)) {
      writeIfMissing(this.docPath(name), readText(template, `# ${name}\n`))
    }
    writeIfMissing(this.paths.core, readText(path.join(this.templatesDir, 'core.md'), '# 核心记忆\n'))
    writeIfMissing(this.paths.relationsIndex, JSON.stringify(defaultRelations(), null, 2) + '\n')
    writeIfMissing(this.paths.thread, JSON.stringify(defaultThread(), null, 2) + '\n')
    writeIfMissing(this.paths.emotion, JSON.stringify(defaultEmotion(), null, 2) + '\n')
    writeIfMissing(this.paths.boredom, JSON.stringify(defaultBoredom(), null, 2) + '\n')
    writeIfMissing(this.paths.satisfaction, JSON.stringify(defaultSatisfaction(), null, 2) + '\n')
    writeIfMissing(this.paths.learning, JSON.stringify(defaultLearning(), null, 2) + '\n')
    writeIfMissing(this.paths.policy, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n')
    const config = { ...structuredClone(DEFAULT_CONFIG) }
    config.bili.cookieFile = findCookieFile()
    writeIfMissing(this.paths.config, JSON.stringify(config, null, 2) + '\n')
    this.ensureOwnerRelation()
  }

  docPath(name) {
    if (!DOC_NAMES.includes(name)) throw new Error(`未知文档：${name}（可用：${DOC_NAMES.join(', ')}）`)
    return path.join(this.paths.self, `${name}.md`)
  }

  readDoc(name) {
    const file = this.docPath(name)
    return readText(file, '')
  }

  writeDoc(name, content) {
    const file = this.docPath(name)
    writeText(file, String(content ?? ''))
    return this.docInfo(name)
  }

  appendDoc(name, line) {
    const file = this.docPath(name)
    appendLine(file, String(line ?? '').replace(/\r?\n/g, ' '))
    return this.docInfo(name)
  }

  learningGet() {
    const raw = readJson(this.paths.learning, null)
    if (!raw || typeof raw !== 'object') return defaultLearning()
    const cleanList = (value, max) => (Array.isArray(value) ? value : [])
      .map((item) => truncate(String(item ?? '').replace(/\s+/g, ' ').trim(), 60))
      .filter(Boolean).slice(0, max)
    const goals = (Array.isArray(raw.goals) ? raw.goals : []).slice(0, 12).map((goal) => ({
      id: String(goal.id || shortId('lg')),
      title: truncate(String(goal.title ?? '没命名').trim(), 120) || '没命名',
      why: truncate(String(goal.why ?? '').trim(), 240),
      status: ['learning', 'paused', 'done'].includes(goal.status) ? goal.status : 'learning',
      progress: clamp(Number(goal.progress ?? 0), 0, 100),
      targets: cleanList(goal.targets, 8),
      note: truncate(String(goal.note ?? '').trim(), 300),
      createdAt: goal.createdAt || nowIso(),
      updatedAt: goal.updatedAt || nowIso(),
    }))
    const skills = (Array.isArray(raw.skills) ? raw.skills : []).slice(0, 60).map((skill) => ({
      id: String(skill.id || shortId('ls')),
      name: truncate(String(skill.name ?? '没命名').trim(), 120) || '没命名',
      goalId: String(skill.goalId ?? ''),
      level: ['入门', '会用', '熟练'].includes(skill.level) ? skill.level : '入门',
      summary: truncate(String(skill.summary ?? '').trim(), 300),
      evidence: cleanList(skill.evidence, 8),
      source: truncate(String(skill.source ?? '').trim(), 120),
      learnedAt: skill.learnedAt || nowIso(),
      lastUsedAt: skill.lastUsedAt || null,
    }))
    return { version: 1, goals, skills, updatedAt: raw.updatedAt || nowIso() }
  }

  learningSave(doc) {
    const next = {
      version: 1,
      goals: Array.isArray(doc?.goals) ? doc.goals.slice(0, 12) : [],
      skills: Array.isArray(doc?.skills) ? doc.skills.slice(0, 60) : [],
      updatedAt: nowIso(),
    }
    writeJson(this.paths.learning, next)
    return this.learningGet()
  }

  learningView() {
    const doc = this.learningGet()
    const byId = new Map(doc.goals.map((goal) => [goal.id, goal]))
    const skills = doc.skills.map((skill) => ({
      ...skill,
      goalTitle: byId.get(skill.goalId)?.title ?? '',
    }))
    return {
      goals: doc.goals.map((goal) => ({
        ...goal,
        skillCount: skills.filter((skill) => skill.goalId === goal.id).length,
      })),
      skills,
      counts: {
        goals: doc.goals.length,
        learning: doc.goals.filter((goal) => goal.status === 'learning').length,
        done: doc.goals.filter((goal) => goal.status === 'done').length,
        skills: skills.length,
      },
      updatedAt: doc.updatedAt,
    }
  }

  learningGoalAdd({ title, why, targets } = {}) {
    const doc = this.learningGet()
    if (doc.goals.length >= 12) throw new Error('学习目标最多 12 个，先收掉一个再建。')
    const cleanTitle = truncate(String(title ?? '').trim(), 120)
    if (!cleanTitle) throw new Error('目标标题不能为空')
    const goal = {
      id: shortId('lg'),
      title: cleanTitle,
      why: truncate(String(why ?? '').trim(), 240),
      status: 'learning',
      progress: 0,
      targets: (Array.isArray(targets) ? targets : String(targets ?? '').split(/[,，、\s]+/))
        .map((item) => truncate(String(item ?? '').trim(), 60)).filter(Boolean).slice(0, 8),
      note: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    doc.goals.push(goal)
    this.learningSave(doc)
    return goal
  }

  learningGoalUpdate(id, patch = {}) {
    const doc = this.learningGet()
    const goal = doc.goals.find((item) => item.id === String(id))
    if (!goal) throw new Error('找不到这个学习目标')
    if (patch.title !== undefined) goal.title = truncate(String(patch.title).trim(), 120) || goal.title
    if (patch.why !== undefined) goal.why = truncate(String(patch.why).trim(), 240)
    if (patch.note !== undefined) goal.note = truncate(String(patch.note).trim(), 300)
    if (patch.status !== undefined) {
      if (!['learning', 'paused', 'done'].includes(patch.status)) throw new Error('status 只能是 learning/paused/done')
      goal.status = patch.status
    }
    if (patch.progress !== undefined) {
      goal.progress = clamp(Number(patch.progress) || 0, 0, 100)
      if (goal.progress >= 100 && patch.status === undefined) goal.status = 'done'
    }
    if (patch.targets !== undefined) {
      goal.targets = (Array.isArray(patch.targets) ? patch.targets : String(patch.targets).split(/[,，、\s]+/))
        .map((item) => truncate(String(item ?? '').trim(), 60)).filter(Boolean).slice(0, 8)
    }
    goal.updatedAt = nowIso()
    this.learningSave(doc)
    return goal
  }

  learningSkillAdd({ name, goalId, level, summary, evidence, source } = {}) {
    const doc = this.learningGet()
    if (doc.skills.length >= 60) throw new Error('技能最多 60 条，先清掉不再用的。')
    const cleanName = truncate(String(name ?? '').trim(), 120)
    if (!cleanName) throw new Error('技能名不能为空')
    const cleanGoalId = String(goalId ?? '').trim()
    if (cleanGoalId && !doc.goals.some((goal) => goal.id === cleanGoalId)) throw new Error('goalId 对不上学习目标')
    const skill = {
      id: shortId('ls'),
      name: cleanName,
      goalId: cleanGoalId,
      level: ['入门', '会用', '熟练'].includes(level) ? level : '入门',
      summary: truncate(String(summary ?? '').trim(), 300),
      evidence: (Array.isArray(evidence) ? evidence : String(evidence ?? '').split(/[,，、]/))
        .map((item) => truncate(String(item ?? '').trim(), 120)).filter(Boolean).slice(0, 8),
      source: truncate(String(source ?? '').trim(), 120),
      learnedAt: nowIso(),
      lastUsedAt: null,
    }
    doc.skills.push(skill)
    this.learningSave(doc)
    return skill
  }

  learningSkillUpdate(id, patch = {}) {
    const doc = this.learningGet()
    const skill = doc.skills.find((item) => item.id === String(id))
    if (!skill) throw new Error('找不到这条技能')
    if (patch.name !== undefined) skill.name = truncate(String(patch.name).trim(), 120) || skill.name
    if (patch.goalId !== undefined) {
      const cleanGoalId = String(patch.goalId).trim()
      if (cleanGoalId && !doc.goals.some((goal) => goal.id === cleanGoalId)) throw new Error('goalId 对不上学习目标')
      skill.goalId = cleanGoalId
    }
    if (patch.level !== undefined) {
      if (!['入门', '会用', '熟练'].includes(patch.level)) throw new Error('level 只能是 入门/会用/熟练')
      skill.level = patch.level
    }
    if (patch.summary !== undefined) skill.summary = truncate(String(patch.summary).trim(), 300)
    if (patch.evidence !== undefined) {
      skill.evidence = (Array.isArray(patch.evidence) ? patch.evidence : String(patch.evidence).split(/[,，、]/))
        .map((item) => truncate(String(item ?? '').trim(), 120)).filter(Boolean).slice(0, 8)
    }
    if (patch.source !== undefined) skill.source = truncate(String(patch.source).trim(), 120)
    if (patch.lastUsedAt !== undefined) skill.lastUsedAt = patch.lastUsedAt ? String(patch.lastUsedAt) : null
    this.learningSave(doc)
    return skill
  }

  docInfo(name) {
    const file = this.docPath(name)
    const raw = readText(file, '')
    const { meta, body } = parseFrontMatter(raw)
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name
    const firstLine = body.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#'))?.trim() ?? ''
    return {
      name,
      title,
      path: file,
      summary: meta.summary || truncate(firstLine, 120),
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      chars: raw.length,
      lines: raw.split(/\r?\n/).length,
      updatedAt: mtimeIso(file),
    }
  }

  listDocs() {
    return DOC_NAMES.map((name) => this.docInfo(name))
  }

  coreRaw() {
    return readText(this.paths.core, '')
  }

  coreAdd(text) {
    const clean = String(text ?? '').replace(/\r?\n/g, ' ').trim()
    if (!clean) throw new Error('要记的内容不能为空')
    const raw = this.coreRaw()
    if (raw.includes(clean)) return { added: false, duplicate: true }
    const line = clean.startsWith('-') ? clean : `- ${clean}`
    appendLine(this.paths.core, line)
    const lines = readText(this.paths.core, '').split(/\r?\n/).filter((l) => l.trim().startsWith('-'))
    if (lines.length > 80) {
      const head = readText(this.paths.core, '').split(/\r?\n/).slice(0, 12)
      writeText(this.paths.core, `${head.join('\n')}\n${lines.slice(-60).join('\n')}\n`)
    }
    return { added: true }
  }

  coreSet(content) {
    const clean = String(content ?? '').trim()
    if (!clean) throw new Error('核心记忆不能清空')
    writeText(this.paths.core, clean.endsWith('\n') ? clean : `${clean}\n`)
    return { written: true, lines: clean.split(/\r?\n/).length }
  }

  shortFile(day = dayKey()) {
    return path.join(this.paths.short, `${day}.md`)
  }

  shortAdd(who, text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) return false
    const file = this.shortFile()
    writeIfMissing(file, `# ${dayKey()} 短记忆\n`)
    const entry = `- ${localTime()} ${who}: ${truncate(clean, 240)}`
    const lines = readText(file, '').split(/\r?\n/)
    if (lines.at(-1) === entry) return false
    appendLine(file, entry)
    const body = readText(file, '').split(/\r?\n/).filter((l) => l.startsWith('- '))
    if (body.length > 60) {
      writeText(file, `# ${dayKey()} 短记忆\n${body.slice(-60).join('\n')}\n`)
    }
    return true
  }

  recentShort(limit = 4) {
    for (let offset = 0; offset >= -3; offset -= 1) {
      const file = this.shortFile(dayKey(offset))
      const lines = readText(file, '').split(/\r?\n/).filter((line) => line.startsWith('- '))
      if (lines.length) return lines.slice(-limit)
    }
    return []
  }

  searchAll(query, limit = 8) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return []
    const files = [
      ...DOC_NAMES.map((name) => ({ label: `self/${name}.md`, file: this.docPath(name) })),
      { label: 'memory/core.md', file: this.paths.core },
      ...listFiles(this.paths.short, '.md').sort().slice(-14).map((file) => ({ label: `memory/short/${path.basename(file)}`, file })),
      ...listFiles(this.paths.relations, '.md').map((file) => ({ label: `relations/${path.basename(file)}`, file })),
    ]
    const hits = []
    for (const item of files) {
      const lines = readText(item.file, '').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (hits.length >= limit * 3) return
        if (!line.toLowerCase().includes(q)) return
        hits.push({ file: item.label, line: index + 1, text: truncate(line.trim(), 220) })
      })
      if (hits.length >= limit * 3) break
    }
    return hits.slice(0, limit)
  }

  emotionGet() {
    return readJson(this.paths.emotion, defaultEmotion())
  }

  emotionSet(patch = {}) {
    const cur = this.emotionGet()
    const next = { ...cur, ...patch, updatedAt: nowIso() }
    next.valence = clamp(Number(next.valence ?? 0), -100, 100)
    next.energy = clamp(Number(next.energy ?? 50), 0, 100)
    next.mood = String(next.mood ?? cur.mood).slice(0, 40)
    next.note = truncate(next.note ?? cur.note, 200)
    writeJson(this.paths.emotion, next)
    return next
  }

  emotionBump({ valence = 0, energy = 0, mood, note } = {}) {
    const cur = this.emotionGet()
    const patch = { valence: cur.valence + valence, energy: cur.energy + energy }
    if (mood) patch.mood = mood
    if (note) patch.note = note
    return this.emotionSet(patch)
  }

  boredomDecayed() {
    const doc = readJson(this.paths.boredom, defaultBoredom())
    const now = Date.now()
    let changed = false
    const decay = (rec, rate) => {
      const last = Date.parse(rec.lastAt ?? 0) || now
      const hours = Math.max(0, (now - last) / 3600000)
      return Math.max(0, Number(rec.value ?? 0) - hours * rate)
    }
    for (const [key, rec] of Object.entries(doc.activities ?? {})) {
      const next = decay(rec, 4)
      if (Math.abs(next - Number(rec.value ?? 0)) > 0.5) changed = true
      rec.value = Math.round(next * 10) / 10
      rec.lastAt = rec.lastAt ?? nowIso()
    }
    const chat = doc.chat ?? { value: 0, lastAt: nowIso(), count: 0 }
    const chatNext = decay(chat, 3)
    if (Math.abs(chatNext - Number(chat.value ?? 0)) > 0.5) changed = true
    chat.value = Math.round(chatNext * 10) / 10
    doc.chat = chat
    if (changed) writeJson(this.paths.boredom, doc)
    return doc
  }

  boredomValue(group) {
    return Number(this.boredomDecayed().activities?.[group]?.value ?? 0)
  }

  recordActivity(cap) {
    const weight = Number(cap?.weight ?? 0)
    if (!cap || weight <= 0) return this.boredomDecayed()
    const doc = this.boredomDecayed()
    const group = cap.group ?? '其它'
    for (const [key, rec] of Object.entries(doc.activities ?? {})) {
      if (key === group) continue
      rec.value = Math.max(0, Math.round((Number(rec.value ?? 0) - 8) * 10) / 10)
    }
    const cur = doc.activities[group] ?? { value: 0, count: 0 }
    cur.value = Math.min(100, Math.round((Number(cur.value ?? 0) + weight) * 10) / 10)
    cur.count = Number(cur.count ?? 0) + 1
    cur.lastAt = nowIso()
    cur.label = group
    doc.activities[group] = cur
    writeJson(this.paths.boredom, doc)
    return doc
  }

  recordChat(hasTool) {
    const doc = this.boredomDecayed()
    const chat = doc.chat ?? { value: 0, count: 0 }
    if (hasTool) chat.value = Math.max(0, Number(chat.value ?? 0) - 12)
    else chat.value = Math.min(100, Number(chat.value ?? 0) + 5)
    chat.count = Number(chat.count ?? 0) + 1
    chat.lastAt = nowIso()
    doc.chat = chat
    writeJson(this.paths.boredom, doc)
    return doc
  }

  boredomReset(group) {
    const doc = this.boredomDecayed()
    if (group === 'chat' || !group) doc.chat = { value: 0, lastAt: nowIso(), count: 0 }
    if (!group) doc.activities = {}
    else if (group !== 'chat') delete doc.activities[group]
    writeJson(this.paths.boredom, doc)
    return doc
  }

  boredomView(policy) {
    const doc = this.boredomDecayed()
    const threshold = Number(policy?.boredomThreshold ?? 70)
    const activities = Object.entries(doc.activities ?? {})
      .map(([group, rec]) => ({
        group,
        value: Math.round(Number(rec.value ?? 0)),
        count: Number(rec.count ?? 0),
        lastAt: rec.lastAt ?? null,
        level: Number(rec.value ?? 0) >= threshold ? 'high' : Number(rec.value ?? 0) >= threshold * 0.6 ? 'warm' : 'low',
      }))
      .sort((a, b) => b.value - a.value)
    return {
      threshold,
      chatThreshold: Number(policy?.chatBoredomThreshold ?? 65),
      chat: Math.round(Number(doc.chat?.value ?? 0)),
      top: activities[0] ?? null,
      activities,
    }
  }

  satisfactionDecayed() {
    const doc = readJson(this.paths.satisfaction, defaultSatisfaction())
    const policy = this.policyGet()
    const decay = clamp(Number(policy.satisfactionDecayPerHour ?? 1), 0, 10)
    const now = Date.now()
    const last = Date.parse(doc.lastAt ?? 0) || now
    const hours = Math.max(0, (now - last) / 3600000)
    const next = Math.max(0, Math.min(100, Number(doc.value ?? 0) - hours * decay))
    if (Math.abs(next - Number(doc.value ?? 0)) > 0.05) {
      doc.value = Math.round(next * 10) / 10
      doc.lastAt = nowIso()
      writeJson(this.paths.satisfaction, doc)
    }
    return doc
  }

  satisfactionGet() {
    const doc = this.satisfactionDecayed()
    return { ...defaultSatisfaction(), ...doc }
  }

  satisfactionAdd(amount, source = 'bili', note = '') {
    const add = Number(amount)
    if (!Number.isFinite(add) || add <= 0) return this.satisfactionGet()
    const doc = this.satisfactionDecayed()
    doc.value = Math.min(100, Math.round((Number(doc.value ?? 0) + add) * 10) / 10)
    doc.lastAt = nowIso()
    doc.events = Array.isArray(doc.events) ? doc.events : []
    doc.events.push({ at: doc.lastAt, amount: add, source: String(source || 'bili'), note: truncate(note, 160) })
    if (doc.events.length > 30) doc.events = doc.events.slice(-30)
    writeJson(this.paths.satisfaction, doc)
    return doc
  }

  satisfactionReset() {
    const doc = defaultSatisfaction()
    writeJson(this.paths.satisfaction, doc)
    return doc
  }

  satisfactionMarkClosed(note = '') {
    const doc = this.satisfactionGet()
    doc.closedAt = nowIso()
    doc.lastAt = doc.closedAt
    doc.note = truncate(note, 300)
    writeJson(this.paths.satisfaction, doc)
    return doc
  }

  satisfactionView(policy) {
    const doc = this.satisfactionDecayed()
    const threshold = Math.max(1, Math.min(100, Number(policy?.satisfactionThreshold ?? 70)))
    const value = Math.round(Number(doc.value ?? 0))
    const sources = {}
    for (const event of doc.events ?? []) {
      const key = event.source || 'bili'
      sources[key] = (sources[key] || 0) + Number(event.amount || 0)
    }
    return {
      value,
      threshold,
      full: value >= threshold,
      missing: Math.max(0, threshold - value),
      decayPerHour: clamp(Number(policy?.satisfactionDecayPerHour ?? 1), 0, 10),
      lastAt: doc.lastAt ?? null,
      sources,
      events: (doc.events ?? []).slice(-8),
    }
  }

  relationsGet() {
    const doc = readJson(this.paths.relationsIndex, defaultRelations())
    if (!doc.items) doc.items = {}
    return doc
  }

  relationList() {
    const doc = this.relationsGet()
    return Object.values(doc.items).sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
  }

  relationPath(uid) {
    const safe = String(uid).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 48) || 'unknown'
    return path.join(this.paths.relations, `${safe}.md`)
  }

  relationGet(uid) {
    const doc = this.relationsGet()
    const item = doc.items[String(uid)]
    const file = this.relationPath(uid)
    return {
      uid: String(uid),
      meta: item ?? null,
      exists: fs.existsSync(file),
      raw: readText(file, ''),
      path: file,
    }
  }

  relationNote(input = {}) {
    const uid = String(input.uid ?? '').trim()
    if (!uid) throw new Error('uid 不能为空')
    const file = this.relationPath(uid)
    const idx = this.relationsGet()
    const prev = idx.items[uid] ?? { uid, name: input.name || uid, closeness: 0, tags: [], summary: '' }
    const name = String(input.name || prev.name || uid).slice(0, 60)
    const closenessDelta = Number(input.closenessDelta ?? 0)
    const closeness = clamp(Number(prev.closeness ?? 0) + closenessDelta, -100, 100)
    const tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : (prev.tags ?? [])
    const note = String(input.event ?? input.impression ?? '').replace(/\r?\n/g, ' ').trim()
    let raw = readText(file, '')
    if (!raw) {
      raw = [
        '---',
        `uid: ${uid}`,
        `name: ${name}`,
        'closeness: 0',
        'tags: []',
        `updated: ${nowIso()}`,
        '---',
        `# 对 ${name} 的印象`,
        '',
        `- ${note || '先观察，还没有定论。'}`,
        '',
        '## 互动',
        '',
      ].join('\n')
    }
    raw = raw
      .replace(/^name:.*$/m, `name: ${name}`)
      .replace(/^updated:.*$/m, `updated: ${nowIso()}`)
      .replace(/^closeness:.*$/m, `closeness: ${closeness}`)
    if (!/^closeness:/m.test(raw)) raw = raw.replace(/^---$/m, `closeness: ${closeness}\n---`)
    if (!/^name:/m.test(raw)) raw = raw.replace(/^---$/m, `name: ${name}\n---`)
    if (note) {
      const line = `- ${dayKey()} ${localTime()} ${note}`
      raw = raw.includes('## 互动') ? `${raw.trimEnd()}\n${line}\n` : `${raw.trimEnd()}\n\n## 互动\n${line}\n`
    }
    const lines = raw.split(/\r?\n/)
    const interactAt = lines.findIndex((line) => line.trim() === '## 互动')
    if (interactAt >= 0 && lines.length - interactAt > 45) {
      raw = [...lines.slice(0, interactAt + 1), ...lines.slice(-40)].join('\n')
    }
    writeText(file, raw)
    const summary = truncate(input.impression || prev.summary || note || '还不熟', 160)
    idx.items[uid] = {
      ...prev,
      uid,
      name,
      closeness,
      tags,
      summary,
      updatedAt: nowIso(),
      lastAt: nowIso(),
    }
    writeJson(this.paths.relationsIndex, idx)
    return idx.items[uid]
  }

  // 主人是固定的关系位：控制台里显示具体 B 站昵称，亲近度直接拉满。
  ensureOwnerRelation() {
    const relation = this.configGet().relation || {}
    const uid = String(relation.ownerUid || '').trim()
    if (!uid) return null
    const name = String(relation.ownerName || '主人').trim() || uid
    const idx = this.relationsGet()
    const prev = idx.items[uid]
    const tags = Array.isArray(prev?.tags) ? prev.tags : []
    if (prev && prev.name === name && tags.includes('主人') && Number(prev.closeness ?? 0) >= 10) return prev
    return this.relationNote({
      uid,
      name,
      tags: Array.from(new Set([...tags, '主人'])),
      event: prev ? '确认主人关系；电脑上的文件都归主人，不搬不删。' : '主人；这台电脑上的文件全归主人，不要乱搬、乱删。',
      closenessDelta: Math.max(0, 10 - Number(prev?.closeness ?? 0)),
      impression: '主人；电脑和文件都归主人，别乱搬。',
    })
  }

  relationBump(uid, { amount = 1, event = '', name = '' } = {}) {
    const delta = clamp(Number(amount) || 0, -10, 10)
    if (!delta) return this.relationGet(uid)
    return this.relationNote({ uid, name, closenessDelta: delta, event })
  }

  // 和本人聊天也会慢慢变熟：每 N 条真人消息 +1 亲近度，封顶 maxCloseness。
  // 只记真人根会话；心跳、子代理、系统提示不计。
  relationChatTick(sessionId, { uid, every = 4, max = 10 } = {}) {
    const target = String(uid ?? '').trim()
    if (!target) return { bumped: false, count: 0, closeness: 0 }
    const file = path.join(this.paths.state, 'relation-chat.json')
    const doc = readJson(file, { version: 1, sessions: {} })
    if (!doc.sessions || typeof doc.sessions !== 'object') doc.sessions = {}
    const key = String(sessionId || 'unknown').slice(0, 120)
    const record = doc.sessions[key] ?? { count: 0, lastAt: null }
    record.count = Number(record.count ?? 0) + 1
    const need = Math.max(1, Number(every) || 4)
    let bumped = false
    const current = Number(this.relationGet(target).meta?.closeness ?? 0)
    const cap = Math.max(1, Number(max) || 10)
    if (record.count >= need) {
      if (current < cap) {
        this.relationBump(target, {
          amount: 1,
          event: `和本人聊到第 ${record.count} 句，熟了 1 点`,
        })
        bumped = true
      }
      record.count = 0
    }
    record.lastAt = nowIso()
    doc.sessions[key] = record
    writeJson(file, doc)
    return {
      bumped,
      count: record.count,
      closeness: Number(this.relationGet(target).meta?.closeness ?? 0),
    }
  }

  threadGet() {
    return readJson(this.paths.thread, defaultThread())
  }

  threadStart({ title, capability, note } = {}) {
    const doc = this.threadGet()
    if (doc.status === 'active' && doc.thread) {
      return { ok: false, busy: true, thread: doc.thread, message: `手头还有「${doc.thread.title}」没做完，先收尾或放弃。` }
    }
    const cleanTitle = truncate(String(title ?? '').trim() || '没命名的事', 80)
    const thread = {
      id: shortId('t'),
      title: cleanTitle,
      capability: String(capability ?? ''),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      steps: note ? [{ at: nowIso(), note: truncate(note, 300) }] : [],
    }
    const next = { ...doc, status: 'active', thread }
    writeJson(this.paths.thread, next)
    return { ok: true, thread }
  }

  threadStep(note) {
    const doc = this.threadGet()
    if (doc.status !== 'active' || !doc.thread) return { ok: false, message: '现在没有进行中的线程。' }
    const thread = doc.thread
    thread.steps = [...(thread.steps ?? []), { at: nowIso(), note: truncate(String(note ?? '').trim(), 300) }].slice(-20)
    thread.updatedAt = nowIso()
    writeJson(this.paths.thread, { ...doc, thread })
    return { ok: true, thread }
  }

  threadFinish({ result, outcome = 'done' } = {}) {
    const doc = this.threadGet()
    if (doc.status !== 'active' || !doc.thread) return { ok: false, message: '现在没有进行中的线程。' }
    const thread = doc.thread
    const resultText = truncate(String(result ?? '').replace(/\r?\n/g, ' ').trim(), 300)
    const finishedAt = nowIso()
    const last = { ...thread, finishedAt, result: resultText, outcome }
    const line = `- ${dayKey().slice(5)} ${localTime()} 完成《${thread.title}》${resultText ? `：${resultText}` : ''}`
    appendLine(this.docPath('progress'), line)
    writeJson(this.paths.thread, { ...doc, status: 'idle', thread: null, last })
    return { ok: true, last }
  }

  threadAbandon(reason) {
    const doc = this.threadGet()
    if (doc.status !== 'active' || !doc.thread) return { ok: false, message: '现在没有进行中的线程。' }
    const last = { ...doc.thread, finishedAt: nowIso(), outcome: 'abandoned', result: truncate(String(reason ?? ''), 300) }
    writeJson(this.paths.thread, { ...doc, status: 'idle', thread: null, last })
    return { ok: true, last }
  }

  policyGet() {
    const stored = readJson(this.paths.policy, {})
    return deepMergePolicy(structuredClone(DEFAULT_POLICY), stored)
  }

  policySet(patch = {}) {
    const source = { ...(patch ?? {}) }
    const replaceOverrides = source.__replaceOverrides === true
    delete source.__replaceOverrides
    const next = deepMergePolicy(this.policyGet(), source)
    if (replaceOverrides) next.overrides = { ...(source.overrides ?? {}) }
    for (const [id, value] of Object.entries(next.overrides ?? {})) {
      if (!['allow', 'ask', 'deny'].includes(value)) throw new Error(`overrides.${id} 只能是 allow/ask/deny`)
    }
    next.satisfactionThreshold = clamp(Number(next.satisfactionThreshold ?? 70), 1, 100)
    next.satisfactionDecayPerHour = clamp(Number(next.satisfactionDecayPerHour ?? 1), 0, 10)
    next.boredomThreshold = clamp(Number(next.boredomThreshold ?? 70), 20, 100)
    next.chatBoredomThreshold = clamp(Number(next.chatBoredomThreshold ?? 65), 20, 100)
    next.limits = next.limits ?? {}
    for (const key of ['writePerHour', 'commentPerDay', 'dmPerDay', 'publishPerDay', 'danmakuPerHour', 'likePerHour']) {
      if (next.limits[key] !== undefined) next.limits[key] = clamp(Number(next.limits[key]), 0, 1000)
    }
    writeJson(this.paths.policy, next)
    return next
  }

  configGet() {
    return deepMergePolicy(structuredClone(DEFAULT_CONFIG), readJson(this.paths.config, {}))
  }

  configSet(patch = {}) {
    const next = deepMergePolicy(this.configGet(), patch ?? {})
    next.heartbeat.everyMinutes = clamp(Number(next.heartbeat.everyMinutes ?? 45), 1, 1440)
    next.heartbeat.lowEveryMinutes = clamp(Number(next.heartbeat.lowEveryMinutes ?? 15), 1, 1440)
    next.heartbeat.speedUpWhenLow = next.heartbeat.speedUpWhenLow !== false
    if (next.feedback) {
      next.feedback.everyMinutes = clamp(Number(next.feedback.everyMinutes ?? 5), 1, 60)
      next.feedback.maxPerPoll = clamp(Number(next.feedback.maxPerPoll ?? 5), 1, 10)
    }
    if (next.social) {
      next.social.everyMinutes = clamp(Number(next.social.everyMinutes ?? 60), 15, 1440)
      next.social.maxPerDay = clamp(Number(next.social.maxPerDay ?? 3), 1, 10)
      next.social.channels = Array.isArray(next.social.channels)
        ? next.social.channels.filter((key) => ['comment', 'danmaku', 'dm', 'live'].includes(key))
        : ['comment', 'danmaku']
      next.social.interests = Array.isArray(next.social.interests) ? next.social.interests.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : []
      next.social.allowDmUids = Array.isArray(next.social.allowDmUids) ? next.social.allowDmUids.map((item) => String(item).trim()).filter(Boolean).slice(0, 50) : []
    }
    if (next.relation) {
      next.relation.ownerUid = String(next.relation.ownerUid ?? '').trim().slice(0, 32)
      next.relation.ownerName = String(next.relation.ownerName ?? '主人').trim().slice(0, 40)
      next.relation.chatEvery = clamp(Number(next.relation.chatEvery ?? 4), 1, 100)
      next.relation.maxCloseness = clamp(Number(next.relation.maxCloseness ?? 10), 1, 100)
    }
    writeJson(this.paths.config, next)
    if (next.relation) this.ensureOwnerRelation()
    return next
  }

  pendingCreate({ capability, args, summary, reason } = {}) {
    const hash = hashArgs(args)
    for (const item of this.pendingList({ status: 'pending' })) {
      if (item.capability === capability && item.argsHash === hash && Date.now() - Date.parse(item.createdAt) < 10 * 60000) {
        return { ...item, duplicate: true }
      }
    }
    const id = shortId('a')
    const record = {
      id,
      capability,
      args: args ?? {},
      argsHash: hash,
      summary: truncate(summary || capability, 200),
      reason: truncate(reason || '需要人类点头', 300),
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      expiresAt: null,
      note: '',
    }
    writeJson(path.join(this.paths.pending, `${id}.json`), record)
    return record
  }

  pendingGet(id) {
    const file = path.join(this.paths.pending, `${String(id).replace(/[^0-9A-Za-z_-]/g, '')}.json`)
    if (!fs.existsSync(file)) return null
    return readJson(file, null)
  }

  pendingList({ status } = {}) {
    const items = listFiles(this.paths.pending, '.json')
      .map((file) => readJson(file, null))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return status ? items.filter((item) => item.status === status) : items
  }

  pendingDecide(id, decision, note = '') {
    const record = this.pendingGet(id)
    if (!record) return { ok: false, error: '审批项不存在' }
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: 'decision 只能是 approved/rejected' }
    if (record.status !== 'pending') return { ok: false, error: `这一项已经 ${record.status}` }
    record.status = decision
    record.decidedAt = nowIso()
    record.note = truncate(note, 300)
    if (decision === 'approved') record.expiresAt = new Date(Date.now() + 30 * 60000).toISOString()
    writeJson(path.join(this.paths.pending, `${record.id}.json`), record)
    return { ok: true, pending: record }
  }

  pendingConsume(id, capability, argsHash) {
    const record = this.pendingGet(id)
    if (!record) return { ok: false, error: '审批项不存在' }
    if (record.status !== 'approved') return { ok: false, error: `审批项状态是 ${record.status}，还没批准` }
    if (record.capability !== capability) return { ok: false, error: '审批项的动作对不上' }
    if (record.argsHash !== argsHash) return { ok: false, error: '审批项的参数和这次不一致，请重新申请' }
    if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) return { ok: false, error: '批准已过期（30 分钟），请重新申请' }
    record.status = 'executed'
    record.executedAt = nowIso()
    writeJson(path.join(this.paths.pending, `${record.id}.json`), record)
    return { ok: true, pending: record }
  }

  logAction(entry) {
    const record = { ts: nowIso(), ...entry }
    appendLine(path.join(this.paths.ledger, `${monthKey()}.jsonl`), JSON.stringify(record))
    return record
  }

  recentLedger(limit = 50) {
    const files = [monthKey(), monthKey(-1)].map((key) => path.join(this.paths.ledger, `${key}.jsonl`))
    const entries = []
    for (const file of files) {
      const lines = readText(file, '').split(/\r?\n/).filter(Boolean)
      for (const line of lines) {
        try { entries.push(JSON.parse(line)) } catch {}
      }
    }
    return entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit)
  }

  countSince(sinceMs, predicate = () => true) {
    return this.recentLedger(500).filter((entry) => Date.parse(entry.ts) >= sinceMs && predicate(entry)).length
  }

  riskGet() {
    const risk = readJson(this.paths.risk, null)
    if (!risk) return null
    if (risk.until && Date.parse(risk.until) <= Date.now()) return null
    return risk
  }

  riskSet(hours = 24, reason = '触发账号风控', code = '') {
    const risk = {
      until: new Date(Date.now() + hours * 3600000).toISOString(),
      reason,
      code: String(code ?? ''),
      createdAt: nowIso(),
    }
    writeJson(this.paths.risk, risk)
    return risk
  }

  riskClear() {
    try { fs.unlinkSync(this.paths.risk) } catch {}
    return true
  }

  loginGet() {
    return readJson(this.paths.login, null)
  }

  loginSet(data) {
    const record = { checkedAt: nowIso(), ...data }
    writeJson(this.paths.login, record)
    return record
  }

  beatGet() {
    return readJson(this.paths.beat, { lastAt: null, lastResult: 'never', sessionId: '', count: 0, toolCalls: 0 })
  }

  beatSet(patch) {
    const record = { ...this.beatGet(), ...patch, updatedAt: nowIso() }
    writeJson(this.paths.beat, record)
    return record
  }

  stats() {
    const ledger = this.recentLedger(500)
    const today = dayKey()
    const todayEntries = ledger.filter((entry) => String(entry.ts).startsWith(today))
    return {
      todayTotal: todayEntries.length,
      todayWrites: todayEntries.filter((entry) => entry.kind === 'write' || entry.kind === 'publish').length,
      todayReads: todayEntries.filter((entry) => entry.kind === 'read').length,
      todayErrors: todayEntries.filter((entry) => entry.status === 'error').length,
      pending: this.pendingList({ status: 'pending' }).length,
    }
  }

  bootstrap(policy) {
    return {
      version: 1,
      now: nowIso(),
      stateDir: this.stateDir,
      config: this.configGet(),
      policy: policy ?? this.policyGet(),
      emotion: this.emotionGet(),
      boredom: this.boredomView(policy ?? this.policyGet()),
      satisfaction: this.satisfactionView(policy ?? this.policyGet()),
      thread: this.threadGet(),
      docs: this.listDocs().map((doc) => ({ ...doc, body: this.readDoc(doc.name) })),
      learning: this.learningView(),
      memory: { core: this.coreRaw(), recent: this.recentShort(12) },
      relations: this.relationList(),
      pending: this.pendingList(),
      ledger: this.recentLedger(30),
      recentShort: this.recentShort(8),
      risk: this.riskGet(),
      login: this.loginGet(),
      heartbeat: this.beatGet(),
      stats: this.stats(),
      cookie: cookieInfo(this.configGet().bili.cookieFile),
    }
  }
}

function deepMergePolicy(base, patch) {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMergePolicy(out[key], value)
  }
  return out
}

function cookieInfo(file) {
  try {
    const stat = fs.statSync(file)
    return {
      path: file,
      exists: true,
      bytes: stat.size,
      size: formatBytes(stat.size),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    }
  } catch {
    return { path: file, exists: false, bytes: 0, size: '0 B', updatedAt: null }
  }
}

export { DEFAULT_POLICY, DEFAULT_CONFIG, cookieInfo }
