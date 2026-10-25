import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DOC_NAMES } from './store.js'
import { bridgeInfo, pingBridge, runBridge } from './bridge.js'
import { createLoginQr, pollLogin, saveCredential } from './login.js'
import { resolveCapability, CAPABILITIES } from './catalog.js'
import { check } from './policy.js'
import { clamp, nowIso, truncate } from './util.js'

const PREFIX = '/dafeiyu/api'
const MAX_BODY = 1024 * 1024
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const MEDIA_TYPES = {
  ...IMAGE_TYPES,
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

function sendFile(req, res, file, contentType) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    sendJson(res, 404, { ok: false, error: '文件不存在（可能已被缓存清理）' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: '不是文件' })
    return
  }
  const size = stat.size
  const range = String(req.headers.range || '')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(file))}"`)
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    if (!match) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    let start = match[1] === '' ? null : Number(match[1])
    let end = match[2] === '' ? null : Number(match[2])
    if (start === null && end === null) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    if (start === null) {
      start = Math.max(0, size - end)
      end = size - 1
    } else if (end === null || end >= size) {
      end = size - 1
    }
    if (start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(end - start + 1))
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Length', String(size))
  fs.createReadStream(file).pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大（>1MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function cleanDocName(name) {
  const value = String(name ?? '').trim()
  if (value === 'core') return 'core'
  if (!DOC_NAMES.includes(value)) throw new Error(`未知文档：${value}`)
  return value
}

const SECRET_PATHS = [
  ['studio', 'analysis', 'apiKey'],
  ['studio', 'text', 'apiKey'],
  ['studio', 'tts', 'apiKey'],
  ['studio', 'image', 'apiKey'],
]

function maskSecrets(config) {
  const clone = structuredClone(config || {})
  const flags = {}
  for (const [section, sub, key] of SECRET_PATHS) {
    const value = clone?.[section]?.[sub]?.[key]
    flags[`${section}.${sub}.${key}`] = Boolean(value)
    if (value) clone[section][sub][key] = ''
  }
  clone.secretFlags = flags
  return clone
}

function stripMaskedSecrets(patch) {
  const clone = structuredClone(patch || {})
  for (const [section, sub, key] of SECRET_PATHS) {
    const target = clone?.[section]?.[sub]
    if (!target || !(key in target)) continue
    const value = String(target[key] ?? '')
    if (!value || value.includes('•') || value === '***') delete target[key]
  }
  return clone
}

export function createHttpHandler({ store, rootDir, heartbeat, webServer, studio, live, feedback, social, assets, library }) {
  const allowedOrigin = () => {
    try {
      return webServer.getOrigin()
    } catch {
      return ''
    }
  }

  function guard(req, res) {
    const origin = req.headers.origin
    if (origin && allowedOrigin() && origin !== allowedOrigin()) {
      sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' })
      return false
    }
    if (req.method !== 'GET' && req.headers['x-dafeiyu'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 x-dafeiyu 请求头' })
      return false
    }
    return true
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(PREFIX)) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (!guard(req, res)) return
      const sub = url.pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/'
      const query = url.searchParams
      const method = req.method ?? 'GET'

      if (method === 'GET') {
        if (sub === '/status') {
          const policy = store.policyGet()
          const config = store.configGet()
          const bridge = bridgeInfo(rootDir, config)
          return sendJson(res, 200, {
            ok: true,
            now: nowIso(),
            stateDir: store.stateDir,
            stats: store.stats(),
            emotion: store.emotionGet(),
            boredom: store.boredomView(policy),
            satisfaction: store.satisfactionView(policy),
            thread: store.threadGet(),
            risk: store.riskGet(),
            login: store.loginGet(),
            bridge,
            heartbeat: { ...store.beatGet(), ...(heartbeat?.status?.() ?? {}), config: config.heartbeat },
            feedback: { ...(feedback?.status?.() ?? {}), config: config.feedback },
            social: { ...(social?.status?.() ?? {}), config: config.social },
            policy: {
              requireApproval: policy.requireApproval,
              autonomy: policy.autonomy,
              autoApprove: policy.autoApprove,
              limits: policy.limits,
              quietHours: policy.quietHours,
              boredomThreshold: policy.boredomThreshold,
              chatBoredomThreshold: policy.chatBoredomThreshold,
              satisfactionThreshold: policy.satisfactionThreshold,
              satisfactionDecayPerHour: policy.satisfactionDecayPerHour,
            },
          })
        }
        if (sub === '/feed') {
          const limit = clamp(Number(query.get('limit')) || 12, 1, 20)
          const result = await runBridge(rootDir, store.configGet(), 'home_feed', { limit },
            { timeoutMs: store.configGet().bili?.bridgeTimeoutMs })
          return sendJson(res, 200, result)
        }
        if (sub === '/bootstrap') return sendJson(res, 200, { ok: true, ...store.bootstrap() })
        if (sub === '/docs') {
          return sendJson(res, 200, {
            ok: true,
            docs: store.listDocs(),
            memory: { core: store.coreRaw(), recent: store.recentShort(12) },
          })
        }
        if (sub === '/doc') {
          const name = cleanDocName(query.get('name'))
          if (name === 'core') return sendJson(res, 200, { ok: true, name, raw: store.coreRaw() })
          return sendJson(res, 200, { ok: true, name, ...store.docInfo(name), body: store.readDoc(name) })
        }
        if (sub === '/relations') return sendJson(res, 200, { ok: true, relations: store.relationList() })
        if (sub === '/learning') return sendJson(res, 200, { ok: true, learning: store.learningView() })
        if (sub === '/relation') {
          const uid = String(query.get('uid') ?? '').trim()
          if (!uid) return sendJson(res, 400, { ok: false, error: '缺 uid' })
          return sendJson(res, 200, { ok: true, ...store.relationGet(uid) })
        }
        if (sub === '/pending') {
          const status = query.get('status') || undefined
          return sendJson(res, 200, { ok: true, items: store.pendingList({ status }) })
        }
        if (sub === '/ledger') {
          return sendJson(res, 200, { ok: true, entries: store.recentLedger(clamp(Number(query.get('limit') ?? 50), 1, 500)) })
        }
        if (sub === '/config') return sendJson(res, 200, { ok: true, config: maskSecrets(store.configGet()) })
        if (sub === '/catalog') return sendJson(res, 200, { ok: true, capabilities: CAPABILITIES })
        if (sub === '/policy') return sendJson(res, 200, { ok: true, policy: store.policyGet() })
        if (sub === '/login') return sendJson(res, 200, { ok: true, login: store.loginGet() })
        if (sub === '/bridge/ping') {
          const ping = await pingBridge(rootDir, store.configGet())
          return sendJson(res, 200, { ok: ping.ok, ping })
        }
        if (sub === '/assets') {
          if (!assets) return sendJson(res, 503, { ok: false, error: '素材模块未加载' })
          return sendJson(res, 200, { ok: true, ...assets.status(), assets: assets.publicList({ force: query.get('scan') === '1' }) })
        }
        if (sub === '/assets/file') {
          if (!assets) return sendJson(res, 503, { ok: false, error: '素材模块未加载' })
          const item = assets.find(String(query.get('id') ?? ''))
          if (!item) return sendJson(res, 404, { ok: false, error: '没有这张素材' })
          return sendFile(req, res, item.path, IMAGE_TYPES[item.ext] || 'application/octet-stream')
        }
        if (sub === '/library') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          const data = library.status()
          return sendJson(res, 200, {
            ok: true,
            ...data,
            projects: data.projects.map(({ assets, ...rest }) => ({ ...rest, preview: assets.slice(0, 4) })),
          })
        }
        if (sub === '/library/project') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          const name = String(query.get('name') ?? '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: '缺 name' })
          try {
            const project = library.project(name)
            return sendJson(res, 200, { ok: true, project, manifest: library.projectManifest(project) })
          } catch (error) {
            return sendJson(res, 404, { ok: false, error: error.message })
          }
        }
        if (sub === '/library/file') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          const name = String(query.get('name') ?? query.get('project') ?? '').trim()
          const id = String(query.get('id') ?? '').trim()
          if (!name || !id) return sendJson(res, 400, { ok: false, error: '缺 project/name 和 id' })
          try {
            const project = library.project(name)
            const asset = project.assets.find((item) => item.id === id)
            if (!asset) return sendJson(res, 404, { ok: false, error: '项目里没有这个素材' })
            const allowedRoots = [project.path, project.contentPath].filter(Boolean).map((item) => path.resolve(item))
            const resolved = path.resolve(asset.path)
            if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
              return sendJson(res, 403, { ok: false, error: '素材不在项目目录里' })
            }
            return sendFile(req, res, resolved, MEDIA_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream')
          } catch (error) {
            return sendJson(res, 404, { ok: false, error: error.message })
          }
        }
        if (sub === '/studio/status') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          return sendJson(res, 200, { ok: true, status: await studio.status(), config: maskSecrets(store.configGet()) })
        }
        if (sub === '/studio/job') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          const job = studio.getJob(String(query.get('id') ?? ''))
          if (!job) return sendJson(res, 404, { ok: false, error: '没有这个任务' })
          return sendJson(res, 200, { ok: true, job })
        }
        if (sub === '/studio/video' || sub === '/studio/cover') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          const job = studio.getJob(String(query.get('id') ?? ''))
          if (!job?.result) return sendJson(res, 404, { ok: false, error: '任务没有产物' })
          const file = String(sub.endsWith('cover') ? job.result.coverPath ?? '' : job.result.videoPath ?? '')
          if (!file) return sendJson(res, 404, { ok: false, error: '产物路径为空' })
          const root = path.resolve(studio.outDir || '')
          const resolved = path.resolve(file)
          if (!root || !resolved.startsWith(root + path.sep)) {
            return sendJson(res, 403, { ok: false, error: '只允许读取创作输出目录里的文件' })
          }
          return sendFile(req, res, resolved, sub.endsWith('cover') ? 'image/png' : 'video/mp4')
        }
        if (sub === '/studio/jobs') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          return sendJson(res, 200, { ok: true, jobs: studio.listJobs(clamp(Number(query.get('limit') ?? 20), 1, 100)) })
        }
        if (sub === '/live/status') {
          if (!live) return sendJson(res, 503, { ok: false, error: '直播模块未加载' })
          return sendJson(res, 200, { ok: true, status: await live.status(), config: store.configGet().live })
        }
        if (sub === '/feedback/status') {
          if (!feedback) return sendJson(res, 503, { ok: false, error: '互动反馈模块未加载' })
          return sendJson(res, 200, { ok: true, status: feedback.status(), config: store.configGet().feedback })
        }
        if (sub === '/social/status') {
          if (!social) return sendJson(res, 503, { ok: false, error: '主动社交模块未加载' })
          return sendJson(res, 200, { ok: true, status: social.status(), config: store.configGet().social })
        }
        return sendJson(res, 404, { ok: false, error: `未知接口 GET ${sub}` })
      }

      if (method === 'POST') {
        const body = await readBody(req)

        if (sub === '/doc') {
          const name = cleanDocName(body.name)
          const content = String(body.content ?? '')
          if (!content.trim()) return sendJson(res, 400, { ok: false, error: 'content 不能为空' })
          if (content.length > 20000) return sendJson(res, 400, { ok: false, error: '单份文档最多 20000 字' })
          if (name === 'core') {
            const result = store.coreSet(content)
            return sendJson(res, 200, { ok: true, name, ...result })
          }
          store.writeDoc(name, content)
          return sendJson(res, 200, { ok: true, name, ...store.docInfo(name) })
        }

        if (sub === '/learning') {
          try {
            const action = String(body.action ?? '')
            if (action === 'status') return sendJson(res, 200, { ok: true, learning: store.learningView() })
            if (action === 'goal_add') return sendJson(res, 200, { ok: true, goal: store.learningGoalAdd(body) })
            if (action === 'goal_update') return sendJson(res, 200, { ok: true, goal: store.learningGoalUpdate(body.goalId, body) })
            if (action === 'skill_add') return sendJson(res, 200, { ok: true, skill: store.learningSkillAdd(body) })
            if (action === 'skill_update') return sendJson(res, 200, { ok: true, skill: store.learningSkillUpdate(body.skillId, body) })
            return sendJson(res, 400, { ok: false, error: '未知学习操作' })
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String(error.message || error) })
          }
        }

        if (sub === '/memory') {
          const action = String(body.action ?? '')
          if (action === 'core_add') {
            const result = store.coreAdd(body.text)
            return sendJson(res, 200, { ok: true, ...result })
          }
          if (action === 'core_set') {
            return sendJson(res, 200, { ok: true, ...store.coreSet(body.content) })
          }
          if (action === 'mood') {
            return sendJson(res, 200, { ok: true, emotion: store.emotionSet({ mood: body.mood, energy: clamp(Number(body.energy ?? 60), 0, 100), note: body.note }) })
          }
          if (action === 'boredom_reset') {
            return sendJson(res, 200, { ok: true, boredom: store.boredomReset(body.group ? String(body.group) : undefined) })
          }
          if (action === 'satisfaction_reset') {
            return sendJson(res, 200, { ok: true, satisfaction: store.satisfactionView(store.policyGet()), reset: store.satisfactionReset() })
          }
          if (action === 'short_add') {
            const added = store.shortAdd(body.who || '大肥鱼', body.text)
            return sendJson(res, 200, { ok: true, added })
          }
          return sendJson(res, 400, { ok: false, error: `未知 memory action：${action}` })
        }

        if (sub === '/relation') {
          if (!body.uid) return sendJson(res, 400, { ok: false, error: '缺 uid' })
          const meta = store.relationNote({
            uid: body.uid,
            name: body.name,
            impression: body.impression,
            event: body.event ?? body.impression,
            tags: body.tags,
            closenessDelta: clamp(Number(body.closeness ?? 0), -2, 2),
          })
          return sendJson(res, 200, { ok: true, relation: meta })
        }

        if (sub === '/thread') {
          const action = String(body.action ?? '')
          if (action === 'start') {
            const result = store.threadStart({ title: body.title, capability: body.capability, note: body.note })
            return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, ...result })
          }
          if (action === 'step') return sendJson(res, 200, { ok: true, ...store.threadStep(body.note) })
          if (action === 'finish') return sendJson(res, 200, { ok: true, ...store.threadFinish({ result: body.result }) })
          if (action === 'abandon') return sendJson(res, 200, { ok: true, ...store.threadAbandon(body.result) })
          return sendJson(res, 400, { ok: false, error: `未知 thread action：${action}` })
        }

        if (sub === '/policy') {
          const policy = store.policySet(body.patch ?? body)
          return sendJson(res, 200, { ok: true, policy })
        }

        if (sub === '/config') {
          const patch = stripMaskedSecrets(body.patch ?? body)
          const config = store.configSet(patch)
          heartbeat?.reload?.()
          return sendJson(res, 200, { ok: true, config: maskSecrets(config) })
        }

        if (sub === '/pending') {
          const result = store.pendingDecide(String(body.id ?? ''), String(body.decision ?? ''), body.note ?? '')
          return sendJson(res, result.ok ? 200 : 400, result)
        }

        if (sub === '/heartbeat') {
          if (body.runNow === true) {
            const result = await heartbeat?.runNow?.('manual')
            return sendJson(res, 200, { ok: result?.ok !== false, result })
          }
          const config = store.configSet({ heartbeat: body.patch ?? body })
          heartbeat?.reload?.()
          return sendJson(res, 200, { ok: true, config: config.heartbeat })
        }

        if (sub === '/feedback') {
          if (body.watch === true || body.action === 'watch') {
            const result = feedback?.watch?.(body.uid, { minutes: body.minutes ?? 10 })
            return sendJson(res, 200, { ok: result?.ok !== false, result, status: feedback?.status?.() })
          }
          if (body.unwatch === true || body.action === 'unwatch') {
            const result = feedback?.clearWatch?.()
            return sendJson(res, 200, { ok: true, result, status: feedback?.status?.() })
          }
          if (body.runNow === true) {
            const result = await feedback?.poll?.({ manual: true })
            return sendJson(res, 200, { ok: result?.ok !== false, result, status: feedback?.status?.() })
          }
          const config = store.configSet({ feedback: body.patch ?? body })
          return sendJson(res, 200, { ok: true, config: config.feedback, status: feedback?.status?.() })
        }

        if (sub === '/social') {
          if (body.runNow === true) {
            const result = await social?.runNow?.('manual')
            return sendJson(res, 200, { ok: result?.ok !== false, result, status: social?.status?.() })
          }
          const config = store.configSet({ social: body.patch ?? body })
          return sendJson(res, 200, { ok: true, config: config.social, status: social?.status?.() })
        }

        if (sub === '/login/check') {
          const result = await runBridge(rootDir, store.configGet(), 'whoami', {}, { timeoutMs: 20000 })
          if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error ?? '读取登录状态失败', detail: result })
          const login = store.loginSet({ ok: true, ...(result.data ?? {}) })
          return sendJson(res, 200, { ok: true, login })
        }

        if (sub === '/login/qr') {
          try {
            const qr = await createLoginQr()
            return sendJson(res, 200, { ok: true, ...qr })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
          }
        }

        if (sub === '/login/poll') {
          try {
            const result = await pollLogin(String(body.key ?? ''))
            if (result.state !== 'ok') return sendJson(res, 200, { ok: true, ...result })
            const cookiePath = saveCredential(result.cookie, store.configGet())
            const who = await runBridge(rootDir, store.configGet(), 'whoami', {}, { timeoutMs: 30000 })
            const account = who.ok ? who.data : null
            if (account) store.loginSet({ ok: true, ...account })
            return sendJson(res, 200, {
              ok: true,
              state: 'ok',
              message: '登录成功，凭证已写入 ' + cookiePath,
              account,
              cookiePath,
            })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
          }
        }

        if (sub === '/risk/clear') {
          store.riskClear()
          return sendJson(res, 200, { ok: true })
        }

        if (sub === '/bridge/read') {
          const cap = resolveCapability(body.action)
          if (!cap || !cap.bridge || cap.kind !== 'read') return sendJson(res, 400, { ok: false, error: '只允许只读动作' })
          const result = await runBridge(rootDir, store.configGet(), cap.action, body.args ?? {})
          if (result.ok && cap.action === 'whoami') store.loginSet({ ok: true, ...(result.data ?? {}) })
          return sendJson(res, 200, result)
        }

        if (sub === '/studio/analyze') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const job = await studio.analyze(body.source, { level: body.level })
            return sendJson(res, 200, { ok: true, job })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/produce') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const job = await studio.produce({
              source: body.source,
              topic: body.topic,
              analysisId: body.analysisId,
              assetIds: body.assetIds,
              coverAssetId: body.coverAssetId,
            })
            return sendJson(res, 200, { ok: true, job })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/pipeline') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const job = await studio.pipeline({
              title: body.title,
              topic: body.topic,
              lines: body.lines,
              text: body.text,
              voice: body.voice,
              shotlistPath: body.shotlistPath,
              assetIds: body.assetIds,
              coverAssetId: body.coverAssetId,
            })
            return sendJson(res, 200, { ok: true, job })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/publish') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const thread = store.threadGet()
            if (thread?.status !== 'active' || !thread.thread) {
              return sendJson(res, 200, { ok: false, error: '投稿前先开总线程：让大肥鱼用 feiyu_thread 或你在总览里开一个' })
            }
            const payload = studio.publishPayload(body.jobId, body.meta ?? body)
            const verdict = check(store, 'bili.video_publish', payload, { checkOnly: true })
            if (verdict.decision === 'deny') return sendJson(res, 200, { ok: false, error: verdict.reason, alternatives: verdict.alternatives })
            const pending = await studio.createPublishPending({ jobId: body.jobId, meta: body.meta ?? body })
            return sendJson(res, 200, { ok: true, pending })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/publish/execute') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const result = await studio.executePublish({ approvalId: body.approvalId })
            return sendJson(res, 200, { ok: true, result })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/image') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            const image = await studio.createImage({ prompt: body.prompt, filename: body.filename })
            return sendJson(res, 200, { ok: true, image })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/library/scan') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          const data = library.status()
          return sendJson(res, 200, { ok: true, ...data })
        }

        if (sub === '/library/create') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          try {
            return sendJson(res, 200, { ok: true, created: library.createProject({ name: body.name }) })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/library/add') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          try {
            return sendJson(res, 200, {
              ok: true,
              added: library.addAsset({ project: body.name, file: body.file, role: body.role, name: body.assetName }),
            })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/library/materialize') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          try {
            const result = body.all ? library.materializeAll() : library.materialize(body.name)
            return sendJson(res, 200, { ok: true, materialized: result })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/library/plan') {
          if (!library) return sendJson(res, 503, { ok: false, error: '素材库模块未加载' })
          return sendJson(res, 200, { ok: true, plan: library.plan() })
        }

        if (sub === '/library/open') {
          if (process.platform !== 'win32') return sendJson(res, 400, { ok: false, error: '只支持 Windows' })
          try {
            const target = body.name ? library?.project(body.name)?.path : library?.projectsRoot()
            if (!target || !fs.existsSync(target)) return sendJson(res, 404, { ok: false, error: '目录不存在' })
            spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
            return sendJson(res, 200, { ok: true, path: target })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/assets/scan') {
          if (!assets) return sendJson(res, 503, { ok: false, error: '素材模块未加载' })
          return sendJson(res, 200, { ok: true, ...assets.status(), assets: assets.publicList({ force: true }) })
        }

        if (sub === '/assets/import') {
          if (!assets) return sendJson(res, 503, { ok: false, error: '素材模块未加载' })
          try {
            const item = assets.importFile(body.path, body.name)
            return sendJson(res, 200, { ok: true, asset: { ...item, url: `/dafeiyu/api/assets/file?id=${item.id}` } })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/assets/open') {
          if (process.platform !== 'win32') return sendJson(res, 400, { ok: false, error: '只支持 Windows' })
          const dir = assets?.dir || path.join(store.stateDir, 'assets')
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
          return sendJson(res, 200, { ok: true, path: dir })
        }

        if (sub === '/studio/clean') {
          if (!studio) return sendJson(res, 503, { ok: false, error: '创作模块未加载' })
          try {
            return sendJson(res, 200, await studio.cleanCache())
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/studio/open-video') {
          if (process.platform !== 'win32') return sendJson(res, 400, { ok: false, error: '只支持 Windows' })
          const job = studio?.getJob(String(body.jobId ?? ''))
          const file = String(job?.result?.videoPath ?? '')
          const root = path.resolve(studio?.outDir || '')
          const resolved = path.resolve(file)
          if (!file || !root || !resolved.startsWith(root + path.sep)) {
            return sendJson(res, 404, { ok: false, error: '没有可打开的视频' })
          }
          if (!fs.existsSync(resolved)) return sendJson(res, 404, { ok: false, error: '视频文件已被清理' })
          spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref()
          return sendJson(res, 200, { ok: true, path: resolved })
        }

        if (sub === '/studio/open') {
          if (process.platform !== 'win32') return sendJson(res, 400, { ok: false, error: '只支持 Windows' })
          const dir = studio?.outDir || store.stateDir
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
          return sendJson(res, 200, { ok: true, path: dir })
        }

        if (sub === '/live/launch') {
          if (!live) return sendJson(res, 503, { ok: false, error: '直播模块未加载' })
          try {
            return sendJson(res, 200, { ok: true, launch: await live.launch() })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/live/check') {
          if (!live) return sendJson(res, 503, { ok: false, error: '直播模块未加载' })
          try {
            return sendJson(res, 200, { ok: true, check: await live.check() })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/live/start') {
          if (!live) return sendJson(res, 503, { ok: false, error: '直播模块未加载' })
          try {
            return sendJson(res, 200, { ok: true, start: await live.start() })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: truncate(error?.message ?? String(error), 800) })
          }
        }

        if (sub === '/open-folder') {
          if (process.platform !== 'win32') return sendJson(res, 400, { ok: false, error: '只支持 Windows' })
          spawn('explorer.exe', [store.stateDir], { detached: true, stdio: 'ignore' }).unref()
          return sendJson(res, 200, { ok: true, path: store.stateDir })
        }

        return sendJson(res, 404, { ok: false, error: `未知接口 POST ${sub}` })
      }

      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      try {
        sendJson(res, 500, { ok: false, error: truncate(error?.message ?? String(error), 500) })
      } catch {
        try { sendText(res, 500, 'internal error') } catch {}
      }
    }
  }
}
