import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  clamp, dshHome, ensureDir, nowIso, readJson, readText, shortId, truncate, writeJson, writeText,
} from './util.js'

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.flv', '.avi', '.ts'])

function exists(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

function quote(value) {
  return JSON.stringify(String(value ?? ''))
}

function tail(text, max = 1200) {
  const value = String(text || '').trim()
  return value.length > max ? value.slice(-max) : value
}

function pickJson(text) {
  const value = String(text || '').trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`没有 JSON：${tail(value, 300)}`)
  return JSON.parse(value.slice(start, end + 1))
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const limit = options.limit ?? 4 * 1024 * 1024
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: `超时 ${options.timeoutMs ?? 120000}ms\n${stderr}` })
    }, options.timeoutMs ?? 120000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > limit) stdout = stdout.slice(-limit)
      options.onStdout?.(stdout)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > limit) stderr = stderr.slice(-limit)
      options.onStderr?.(stderr)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr })
    })
  })
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 120000),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || text.slice(0, 500)
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  if (!data) throw new Error(`接口没有返回 JSON：${text.slice(0, 300)}`)
  return data
}

function endpoint(base, suffix) {
  const clean = String(base || '').trim().replace(/\/+$/, '')
  if (!clean) return ''
  if (clean.endsWith(suffix)) return clean
  if (clean.endsWith('/v1')) return clean + suffix
  return clean + suffix
}

function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const ms = Math.round((total % 1) * 1000)
  const whole = Math.floor(total)
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0')
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0')
  const ss = String(whole % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`
}

export class Studio {
  constructor({ store, rootDir, logger, assets = null }) {
    this.store = store
    this.rootDir = rootDir
    this.logger = logger
    this.assets = assets
    this.dir = path.join(store.stateDir, 'studio')
    this.jobsDir = path.join(this.dir, 'jobs')
    this.dataDir = path.join(this.dir, 'data')
    this.workDir = path.join(this.dir, 'work')
    this.outDir = path.join(this.dir, 'output')
    this.jobs = new Map()
    ensureDir(this.jobsDir)
    ensureDir(this.dataDir)
    ensureDir(this.workDir)
    ensureDir(this.outDir)
  }

  assetPool(ids) {
    const list = Array.isArray(ids) ? ids : String(ids || '').split(/[,，\s]+/)
    const files = []
    for (const item of list) {
      const id = String(item || '').trim()
      if (!id) continue
      const file = this.assets?.resolve(id)
      if (file && !files.includes(file)) files.push(file)
    }
    return files
  }

  resolveAsset(id) {
    return String(id || '').trim() ? this.assets?.resolve(String(id).trim()) || '' : ''
  }

  config() {
    return this.store.configGet().studio || {}
  }

  configured() {
    const cfg = this.config()
    return {
      text: Boolean(cfg.text?.baseUrl && cfg.text?.model),
      tts: cfg.tts?.provider === 'sapi' || Boolean(cfg.tts?.baseUrl && cfg.tts?.model),
      image: Boolean(cfg.image?.baseUrl && cfg.image?.model),
      publish: Boolean(cfg.text?.baseUrl),
    }
  }

  resolvePython() {
    const cfg = this.config()
    const candidates = [
      cfg.setup?.pythonPath,
      process.env.DAFEIYU_STUDIO_PYTHON,
      path.join(dshHome(), 'bili-duty', '.venv', 'Scripts', 'python.exe'),
      path.join(dshHome(), 'dsh-runtimes', 'dsh-plugin-desktop-primary-runtime', 'dependencies', 'python', 'python.exe'),
    ].filter(Boolean)
    return candidates.find(exists) || 'python'
  }

  resolveNode() {
    const candidates = [
      process.env.DAFEIYU_NODE,
      path.join(dshHome(), 'dsh-runtimes', 'dsh-plugin-desktop-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    ].filter(Boolean)
    return candidates.find(exists) || 'node'
  }

  resolveFfmpeg() {
    const cfg = this.config()
    const candidates = [
      cfg.setup?.ffmpegPath,
      cfg.video?.ffmpegPath,
      path.join(dshHome(), 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ].filter(Boolean)
    return candidates.find(exists) || 'ffmpeg'
  }

  resolveFfprobe() {
    const ffmpeg = this.resolveFfmpeg()
    const probe = path.join(path.dirname(ffmpeg), 'ffprobe.exe')
    return exists(probe) ? probe : 'ffprobe'
  }

  pluginPath() {
    return this.config().setup?.pluginPath || ''
  }

  cookiePath() {
    return this.store.configGet().bili?.cookieFile || ''
  }

  async probeEnvironment() {
    const python = this.resolvePython()
    const node = this.resolveNode()
    const ffmpeg = this.resolveFfmpeg()
    const probe = await run(python, ['-c', 'import numpy, httpx, yaml, soundfile, PIL; print("ok")'], { timeoutMs: 20000 })
    const pcfg = this.config().pipeline || {}
    const editDir = String(pcfg.editDir || 'D:/你的工作目录/work/edit')
    return {
      python,
      pythonOk: probe.ok,
      pythonDetail: probe.ok ? 'numpy/httpx/yaml/soundfile/Pillow 就绪' : tail(probe.stderr || probe.stdout, 500),
      node,
      nodeExists: exists(node),
      plugin: this.pluginPath(),
      pluginExists: exists(this.pluginPath()),
      ffmpeg,
      ffmpegExists: exists(ffmpeg),
      cookie: this.cookiePath(),
      cookieExists: exists(this.cookiePath()),
      analysisZip: path.join(this.rootDir, 'studio', 'analysis', 'analyze.py'),
      analysisExists: exists(path.join(this.rootDir, 'studio', 'analysis', 'analyze.py')),
      pipeline: {
        editDir,
        buildPy: path.join(editDir, 'build.py'),
        buildExists: exists(path.join(editDir, 'build.py')),
        genLine: String(pcfg.genLine || ''),
        genLineExists: exists(String(pcfg.genLine || '')),
        rootDir: String(pcfg.rootDir || 'D:/你的项目目录/.dafeiyu-studio'),
      },
    }
  }

  async status() {
    const env = await this.probeEnvironment()
    const cfg = this.config()
    return {
      enabled: cfg.enabled === true,
      autoPublish: cfg.autoPublish === true,
      heartbeatCreate: cfg.heartbeatCreate === true,
      configured: this.configured(),
      environment: env,
      jobs: this.listJobs(12),
      lastJob: this.listJobs(1)[0] || null,
      live: null,
    }
  }

  writeAnalysisConfig() {
    const cfg = this.config()
    const analysis = cfg.analysis || {}
    const file = path.join(this.dir, 'analysis.yaml')
    const lines = [
      'analyzer:',
      '  enabled: true',
      `  level: ${quote(analysis.level || 'l1')}`,
      `  budget_cny: ${Number(analysis.budgetCny || 0.06)}`,
      '  prefer: vision',
      `  llm_model: ${quote(analysis.model || 'mimo-v2.6-flash')}`,
      `  llm_api_url: ${quote(analysis.apiUrl || 'https://api.xiaomimimo.com/v1/chat/completions')}`,
      `  ffmpeg: ${quote(this.resolveFfmpeg())}`,
      `  node: ${quote(this.resolveNode())}`,
      `  script: ${quote(path.join(this.rootDir, 'studio', 'video_runner.mjs'))}`,
      '',
    ]
    writeText(file, lines.join('\n'))
    return file
  }

  jobPath(id) {
    return path.join(this.jobsDir, `${id}.json`)
  }

  putJob(job) {
    job.updatedAt = nowIso()
    this.jobs.set(job.id, job)
    writeJson(this.jobPath(job.id), job)
    return job
  }

  updateJob(id, patch) {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch)
    job.progress = clamp(Number(job.progress ?? 0), 0, 100)
    return this.putJob(job)
  }

  getJob(id) {
    if (this.jobs.has(id)) return this.jobs.get(id)
    const file = this.jobPath(id)
    if (!exists(file)) return null
    const job = readJson(file, null)
    if (job) this.jobs.set(id, job)
    return job
  }

  listJobs(limit = 20) {
    const files = []
    try {
      for (const name of fs.readdirSync(this.jobsDir)) {
        if (name.endsWith('.json')) files.push(path.join(this.jobsDir, name))
      }
    } catch {}
    const jobs = files
      .map((file) => readJson(file, null))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    return jobs.slice(0, limit)
  }

  startJob(type, title) {
    const id = shortId('s')
    const job = this.putJob({
      id,
      type,
      title,
      status: 'running',
      progress: 1,
      stage: '准备',
      message: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      result: null,
      error: '',
    })
    return job
  }

  logJob(id, message) {
    const job = this.jobs.get(id)
    if (!job) return
    job.log = [...(job.log || []), `[${nowIso().slice(11, 19)}] ${message}`].slice(-40)
    this.putJob(job)
  }

  async probeDuration(file) {
    const result = await run(this.resolveFfprobe(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
    ], { timeoutMs: 30000 })
    if (!result.ok) return 0
    try {
      const data = pickJson(result.stdout)
      return Number(data.format?.duration || 0)
    } catch { return 0 }
  }

  async makeAutoSource() {
    const seconds = 6
    const width = 1280
    const height = 720
    const out = path.join(this.workDir, `auto-${shortId('s')}.mp4`)
    const pictures = (this.assets?.publicList?.() || [])
      .filter((item) => ['.png', '.jpg', '.jpeg', '.webp'].includes(String(item.ext || '').toLowerCase()))
    const image = pictures[0]?.path || ''
    const common = [
      '-y', '-t', String(seconds), '-r', '25', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k', '-shortest', out,
    ]
    const args = image
      ? [
        '-loop', '1', '-i', image,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        ...common,
      ]
      : [
        '-f', 'lavfi', '-i', `color=c=0x14213d:s=${width}x${height}:d=${seconds}`,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        ...common,
      ]
    const result = await run(this.resolveFfmpeg(), args, { timeoutMs: 120000 })
    if (!result.ok) throw new Error(`自动造参考片失败：${tail(result.stderr, 500)}`)
    return out
  }

  async analyze(source, { level } = {}) {
    const cfg = this.config()
    if (!cfg.enabled) throw new Error('创作功能还没开：先在总控台「创作」里打开')
    let value = String(source || '').trim()
    if (!value) {
      value = await this.makeAutoSource()
      this.logger?.info?.(`[dafeiyu] 没给参考视频，自动造了一段：${value}`)
    }
    const file = path.resolve(value)
    if (!exists(file) || !VIDEO_EXT.has(path.extname(file).toLowerCase())) {
      throw new Error('只支持本地视频文件（mp4/mkv/webm/mov/flv/avi/ts）；不填则会自动造一段 6 秒参考片')
    }
    const env = await this.probeEnvironment()
    if (!env.pythonOk) throw new Error(`视频解析环境不完整：${env.pythonDetail}（需要 numpy/httpx/yaml）`)
    if (!env.analysisExists) throw new Error('视频解析包缺失：studio/analysis/analyze.py')
    const job = this.startJob('analyze', `解析 ${path.basename(file)}`)
    this.runAnalyzeJob(job.id, file, { level }).catch((error) => {
      this.updateJob(job.id, { status: 'error', error: String(error.message || error), stage: '失败' })
    })
    return this.getJob(job.id)
  }

  async runAnalyzeJob(id, file, { level } = {}) {
    const job = this.getJob(id)
    const work = path.join(this.workDir, id)
    ensureDir(work)
    const out = path.join(work, 'analysis')
    ensureDir(out)
    const cfg = this.config()
    const configFile = this.writeAnalysisConfig()
    const python = this.resolvePython()
    const env = {
      ...process.env,
      VA_DATA: this.dataDir,
      VA_CONFIG: configFile,
      VIDEO_UNDERSTAND_PLUGIN: this.pluginPath(),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }
    const args = [
      path.join(this.rootDir, 'studio', 'analysis', 'analyze.py'),
      file,
      '--out', out,
      '--quiet',
      '--fresh',
    ]
    if (level) args.push('--level', String(level))
    this.updateJob(id, { progress: 8, stage: '解析画面', message: '启动视频解析…' })
    const result = await run(python, args, {
      cwd: path.join(this.rootDir, 'studio', 'analysis'),
      env,
      timeoutMs: 15 * 60000,
      onStdout: () => { this.updateJob(id, { progress: 35, message: '模型在读画面…' }) },
    })
    if (!result.ok) throw new Error(`解析失败：${tail(result.stderr || result.stdout, 1200)}`)
    const files = fs.readdirSync(out).filter((name) => name.endsWith('.analysis.json'))
    if (!files.length) throw new Error(`解析没有产出 JSON：${tail(result.stdout || result.stderr, 800)}`)
    const analysisPath = path.join(out, files[0])
    const analysis = readJson(analysisPath, null)
    if (!analysis) throw new Error('解析 JSON 读取失败')
    const resultRecord = {
      source: file,
      analysisPath,
      analysis,
      segments: Array.isArray(analysis.segments) ? analysis.segments.length : 0,
      duration: Number(analysis.duration || 0),
      model: analysis.model || '',
      costCny: Number(analysis.cost_cny || analysis.costCny || 0),
    }
    this.updateJob(id, {
      status: 'done', progress: 100, stage: '解析完成', message: `${resultRecord.segments} 段`,
      result: resultRecord,
    })
    this.logJob(id, `解析完成：${resultRecord.segments} 段，${resultRecord.duration.toFixed(1)}s`)
    return resultRecord
  }

  draftFromAnalysis(analysis, topic) {
    const segments = (analysis?.segments || []).slice(0, 10)
    const scenes = segments.map((seg, index) => ({
      id: index + 1,
      narration: truncate(String(seg.summary || `第 ${index + 1} 段画面`).replace(/\s+/g, ' ').trim(), 220),
      imagePrompt: truncate(String(seg.visual_notes || seg.summary || 'cinematic still').replace(/\s+/g, ' ').trim(), 400),
      durationSec: clamp((Number(seg.t1 ?? seg.t0 + 4) - Number(seg.t0 ?? 0)), 2, 10),
      text: `第 ${index + 1} 段`,
    }))
    if (!scenes.length) {
      scenes.push({ id: 1, narration: topic || '今天随便看看。', imagePrompt: 'a calm desk at night, soft light, cinematic', durationSec: 5, text: '' })
    }
    return {
      title: truncate(topic || '一段视频观察', 60),
      desc: `参考画面见解析。\n\n本视频由 AI 辅助生成并发布。`,
      tags: ['AI', '视频观察'],
      declareAI: true,
      scenes,
      source: 'draft',
    }
  }

  async chatJson(messages, { temperature } = {}) {
    const cfg = this.config().text || {}
    if (!cfg.baseUrl || !cfg.model) throw new Error('文本 API 未配置')
    const url = endpoint(cfg.baseUrl, '/chat/completions')
    const body = {
      model: cfg.model,
      messages,
      temperature: temperature ?? Number(cfg.temperature ?? 0.8),
      response_format: { type: 'json_object' },
    }
    const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}
    const data = await fetchJson(url, { body, headers, timeoutMs: 180000 })
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('文本 API 返回空内容')
    try { return pickJson(content) } catch {
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1))
      throw new Error(`文本 API 没有返回 JSON：${content.slice(0, 300)}`)
    }
  }

  async generateScript(analysis, topic) {
    const cfg = this.config().text || {}
    if (cfg.baseUrl && cfg.model) {
      const persona = this.store.readDoc ? this.store.readDoc('persona') : ''
      const style = this.store.readDoc ? this.store.readDoc('style') : ''
      const segments = (analysis?.segments || []).map((seg) => ({
        t0: seg.t0, t1: seg.t1, summary: seg.summary, notes: seg.visual_notes,
      })).slice(0, 20)
      const prompt = [
        '你在帮 B 站 UP 主“大肥鱼”写一条 1-3 分钟的短视频脚本。',
        '它的人设与说话风格如下（只取语气，不要照抄）：',
        truncate(persona, 900),
        truncate(style, 500),
        '',
        `主题：${topic || '围绕参考视频做一条有观点的短视频'}`,
        '参考视频的画面解析（JSON）：',
        truncate(JSON.stringify(segments), 7000),
        '',
        '请只输出 JSON，不要 Markdown。结构：',
        '{"title":"≤30字","desc":"≤200字，结尾带 AI 声明","tags":["≤6个"],"declareAI":true,"scenes":[{"id":1,"narration":"口播，1-2句，口语化","imagePrompt":"英文画面提示词，具体","durationSec":5,"text":"可选字幕"}]}',
        '要求：4-8 个场景；每个场景 narration 25-80 字；不要假装真人亲历；不要低俗引战。',
      ].join('\n')
      try {
        const data = await this.chatJson([{ role: 'user', content: prompt }])
        const scenes = Array.isArray(data.scenes) ? data.scenes.slice(0, 10) : []
        if (!scenes.length) throw new Error('脚本没有 scenes')
        return {
          title: truncate(String(data.title || topic || '一段视频观察'), 80),
          desc: String(data.desc || '本视频由 AI 辅助生成并发布。'),
          tags: Array.isArray(data.tags) ? data.tags.slice(0, 10).map(String) : ['AI'],
          declareAI: data.declareAI !== false,
          scenes: scenes.map((scene, index) => ({
            id: index + 1,
            narration: String(scene.narration || scene.text || '').trim() || `第 ${index + 1} 段`,
            imagePrompt: String(scene.imagePrompt || scene.prompt || 'cinematic still').trim(),
            durationSec: clamp(Number(scene.durationSec || 5), 2, 12),
            text: String(scene.text || ''),
          })),
          source: 'llm',
        }
      } catch (error) {
        if (cfg.fallbackDraft === false) throw error
        this.logger?.warn?.(`[dafeiyu] 文本 API 失败，改用本地草稿：${error.message}`)
      }
    }
    return this.draftFromAnalysis(analysis, topic)
  }

  async sapiTts(text, outFile) {
    const cfg = this.config().tts || {}
    const txt = path.join(path.dirname(outFile), `${path.basename(outFile, path.extname(outFile))}.txt`)
    writeText(txt, String(text || '').slice(0, 4000))
    const voice = String(cfg.voice || '').trim()
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$t = [IO.File]::ReadAllText(${quote(txt)}, [Text.Encoding]::UTF8)`,
      voice ? `try { $s.SelectVoice(${quote(voice)}) } catch {}` : '',
      '$s.Rate = 0',
      `$s.SetOutputToWaveFile(${quote(outFile)})`,
      '$s.Speak($t)',
      '$s.Dispose()',
    ].filter(Boolean).join('\n')
    const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 120000 })
    if (!result.ok || !exists(outFile)) throw new Error(`本地配音失败：${tail(result.stderr || result.stdout, 600)}`)
    return outFile
  }

  async apiTts(text, outFile) {
    const cfg = this.config().tts || {}
    if (!cfg.baseUrl || !cfg.model) throw new Error('语音 API 未配置')
    const url = endpoint(cfg.baseUrl, '/audio/speech')
    const headers = { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        input: String(text || '').slice(0, 4000),
        voice: cfg.voice || 'alloy',
        response_format: cfg.format || 'mp3',
      }),
      signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`语音 API HTTP ${response.status}: ${detail.slice(0, 500)}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error('语音 API 返回空音频')
    fs.writeFileSync(outFile, buffer)
    return outFile
  }

  async makeAudio(text, outBase) {
    const cfg = this.config().tts || {}
    if (cfg.provider === 'sapi') {
      const file = await this.sapiTts(text, `${outBase}.wav`)
      return file
    }
    if (cfg.provider === 'api' && cfg.baseUrl && cfg.model) {
      const ext = cfg.format === 'wav' ? 'wav' : 'mp3'
      return this.apiTts(text, `${outBase}.${ext}`)
    }
    const file = `${outBase}.mp3`
    const result = await run(this.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-q:a', '9', '-acodec', 'libmp3lame', file,
    ], { timeoutMs: 60000 })
    if (!result.ok) throw new Error(`静音轨生成失败：${tail(result.stderr, 400)}`)
    return file
  }

  async apiImage(prompt, outFile, index) {
    const cfg = this.config().image || {}
    if (!cfg.baseUrl || !cfg.model) return this.placeholderImage(outFile, index)
    const url = endpoint(cfg.baseUrl, '/images/generations')
    const headers = { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) }
    try {
      const data = await fetchJson(url, {
        headers,
        body: {
          model: cfg.model,
          prompt,
          size: cfg.size || '1280x720',
          n: 1,
          response_format: 'b64_json',
        },
        timeoutMs: 240000,
      })
      const item = data.data?.[0] || {}
      if (item.b64_json) {
        fs.writeFileSync(outFile, Buffer.from(item.b64_json, 'base64'))
        return outFile
      }
      if (item.url) {
        const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) })
        if (!response.ok) throw new Error(`下载图片 HTTP ${response.status}`)
        fs.writeFileSync(outFile, Buffer.from(await response.arrayBuffer()))
        return outFile
      }
      throw new Error('图片 API 没有返回 b64_json 或 url')
    } catch (error) {
      this.logger?.warn?.(`[dafeiyu] 图片 API 失败，使用占位图：${error.message}`)
      return this.placeholderImage(outFile, index)
    }
  }

  async createImage({ prompt, filename } = {}) {
    const cfg = this.config().image || {}
    if (!prompt || !String(prompt).trim()) throw new Error('要给图片描述')
    const assets = path.join(this.outDir, 'assets')
    ensureDir(assets)
    const name = filename && /^[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(filename)
      ? filename
      : `image-${shortId('img')}.png`
    const outFile = path.join(assets, name)
    const configured = Boolean(cfg.baseUrl && cfg.model)
    const file = await this.apiImage(String(prompt).trim(), outFile, 0)
    return {
      path: file,
      configured,
      source: configured ? 'api' : 'placeholder',
      note: configured ? '已调用图片 API；失败时会退回纯色占位图，看文件内容为准。' : '没配图片 API，生成的是纯色占位图。',
    }
  }

  async placeholderImage(outFile, index = 0) {
    const cfg = this.config().video || {}
    const w = Number(cfg.width || 1280)
    const h = Number(cfg.height || 720)
    const colors = ['0x172033', '0x231b2e', '0x152a26', '0x2b2018', '0x1c2438', '0x2a1b22']
    const color = colors[index % colors.length]
    const result = await run(this.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:d=1`, '-frames:v', '1', outFile,
    ], { timeoutMs: 60000 })
    if (!result.ok) throw new Error(`占位图生成失败：${tail(result.stderr, 400)}`)
    return outFile
  }

  async makeSegment({ image, audio, outFile, duration }) {
    const cfg = this.config().video || {}
    const w = Number(cfg.width || 1280)
    const h = Number(cfg.height || 720)
    const fps = Number(cfg.fps || 25)
    const args = [
      '-y', '-loop', '1', '-i', image, '-i', audio,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
      '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p',
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      '-r', String(fps), '-shortest', '-t', String(Math.max(1.5, duration)), outFile,
    ]
    const result = await run(this.resolveFfmpeg(), args, { timeoutMs: 180000 })
    if (!result.ok) throw new Error(`合成片段失败：${tail(result.stderr, 700)}`)
    return outFile
  }

  async produce({ source, topic, analysisId, autoPublish, assetIds, coverAssetId } = {}) {
    const cfg = this.config()
    if (!cfg.enabled) throw new Error('创作功能还没开：先在总控台「创作」里打开')
    const job = this.startJob('produce', `做视频：${topic || source || '新视频'}`)
    this.runProduceJob(job.id, { source, topic, analysisId, autoPublish, assetIds, coverAssetId }).catch((error) => {
      this.updateJob(job.id, { status: 'error', error: String(error.message || error), stage: '失败' })
    })
    return this.getJob(job.id)
  }

  normalizePipelineLines(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split(/\r?\n/)
    const lines = []
    let section = ''
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const text = String(item.text || item.line || '').trim()
        if (!text) continue
        lines.push({
          seg: Number(item.seg || item.scene || 1),
          name: String(item.name || item.section || section || '一段').trim(),
          instr: String(item.instr || item.emotion || '客服腔').trim(),
          gap: Number(item.gap ?? 0.35),
          video: String(item.video || item.recording || '').trim(),
          crop: String(item.crop || '').trim(),
          text,
        })
        continue
      }
      const value = String(item || '').trim()
      if (!value) continue
      if (/^#{1,6}\s+/.test(value)) {
        section = value.replace(/^#{1,6}\s+/, '').trim()
        continue
      }
      let text = value.replace(/^[-*]\s+/, '').replace(/^\d+[.)、]\s*/, '').trim()
      let instr = '客服腔'
      const tag = text.match(/^[\[【(（]([^\]】)）]{1,8})[\]】)）]\s*/)
      if (tag) {
        instr = tag[1].trim()
        text = text.slice(tag[0].length).trim()
      }
      if (!text) continue
      lines.push({ seg: lines.length + 1, name: section || `第 ${lines.length + 1} 段`, instr, gap: 0.35, text })
    }
    return lines
  }

  findAssetByName(needle) {
    let list = []
    try { list = this.assets?.publicList() || [] } catch { list = [] }
    const key = String(needle || '').toLowerCase()
    return list.find((item) => String(item.name || '').toLowerCase().includes(key))?.path || ''
  }

  async pipeline({ title, topic, lines, text, voice, shotlistPath, assetIds, coverAssetId } = {}) {
    const cfg = this.config()
    if (!cfg.enabled) throw new Error('创作功能还没开：先在总控台「创作」里打开')
    const job = this.startJob('pipeline', `七步做视频：${title || topic || '新视频'}`)
    this.runPipelineJob(job.id, { title, topic, lines, text, voice, shotlistPath, assetIds, coverAssetId }).catch((error) => {
      this.updateJob(job.id, { status: 'error', error: String(error.message || error), stage: '失败' })
    })
    return this.getJob(job.id)
  }

  async runPipelineJob(id, { title, topic, lines, text, voice, shotlistPath, assetIds, coverAssetId } = {}) {
    const cfg = this.config()
    const pcfg = cfg.pipeline || {}
    const python = this.resolvePython()
    const ffmpeg = this.resolveFfmpeg()
    const ffprobe = this.resolveFfprobe()
    const editDir = String(pcfg.editDir || 'D:/你的工作目录/work/edit')
    const genLine = String(pcfg.genLine || '')
    const buildPy = path.join(editDir, 'build.py')
    const pipelinePy = path.join(this.rootDir, 'studio', 'pipeline.py')
    for (const [label, file] of [['gen_line.py', genLine], ['build.py', buildPy], ['pipeline.py', pipelinePy]]) {
      if (!exists(file)) throw new Error(`七步流水线缺少 ${label}：${file}`)
    }
    let parsedLines = this.normalizePipelineLines(lines || text)
    if (!parsedLines.length && shotlistPath) {
      const shotlist = path.resolve(String(shotlistPath))
      if (!exists(shotlist)) throw new Error(`shotlist 不存在：${shotlist}`)
      parsedLines = this.normalizePipelineLines(readText(shotlist))
    }
    if (!parsedLines.length) throw new Error('请给台词：lines 数组、text 多行文本，或 shotlistPath')

    const assets = this.assetPool(assetIds)
    const coverAsset = this.resolveAsset(coverAssetId)
    const cover = coverAsset || this.findAssetByName('title_dafeiyu')
    const watermark = this.findAssetByName('watermark_dafeiyu')
    let bgm = String(pcfg.bgm || '')
    if (!bgm) {
      const bgmDir = path.join(path.dirname(editDir), 'research', 'bgm')
      try {
        const found = fs.readdirSync(bgmDir).find((name) => /\.(mp3|wav|m4a|flac)$/i.test(name))
        if (found) bgm = path.join(bgmDir, found)
      } catch {}
    }
    const work = path.join(String(pcfg.rootDir || 'D:/你的项目目录/.dafeiyu-studio'), 'work', id)
    const outDir = path.join(String(pcfg.rootDir || 'D:/你的项目目录/.dafeiyu-studio'), 'out', id)
    ensureDir(work)
    ensureDir(outDir)
    const requestFile = path.join(work, 'request.json')
    writeJson(requestFile, {
      job_id: id,
      title: String(title || topic || '大肥鱼视频').slice(0, 60),
      topic: String(topic || ''),
      voice: String(voice || pcfg.voice || '撒娇学妹'),
      pitch: Number(pcfg.pitch || 2),
      lines: parsedLines,
      assets,
      cover,
      watermark,
      bgm,
      sfx_dir: String(pcfg.sfxDir || 'D:/你的工作目录/work/research/sfx'),
      work_dir: work,
      out_dir: outDir,
      python,
      ffmpeg,
      ffprobe,
      gen_line: genLine,
      build_py: buildPy,
      edit_dir: editDir,
    })
    this.updateJob(id, { progress: 5, stage: '七步流水线', message: `${parsedLines.length} 句 · 先配音` })
    this.logJob(id, `七步流水线：${parsedLines.length} 句，素材 ${assets.length} 张`)
    const proc = await run(python, [pipelinePy, '--request', requestFile], {
      timeoutMs: 45 * 60 * 1000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      onStdout: (stdout) => {
        const linesOut = String(stdout || '').split(/\r?\n/)
        const marks = linesOut.filter((line) => line.startsWith('PROGRESS '))
        const last = marks[marks.length - 1]
        if (!last) return
        const match = last.match(/^PROGRESS\s+(\d+)\s+(\S+)\s*(.*)$/)
        if (!match) return
        this.updateJob(id, { progress: clamp(Number(match[1]), 5, 99), stage: match[2], message: match[3].slice(0, 120) })
      },
    })
    if (!proc.ok) throw new Error(`七步流水线失败：${tail(proc.stderr || proc.stdout, 1500)}`)
    const resultLine = String(proc.stdout || '').split(/\r?\n/).reverse().find((line) => line.startsWith('RESULT '))
    if (!resultLine) throw new Error(`流水线没有返回结果：${tail(proc.stdout, 1200)}`)
    const result = JSON.parse(resultLine.slice(7))
    const copied = {}
    for (const key of ['videoPath', 'coverPath', 'srtPath', 'contactPath']) {
      const from = result[key]
      if (!from || !exists(from)) continue
      const to = path.join(this.outDir, path.basename(from))
      try {
        fs.copyFileSync(from, to)
        result[key] = to
        copied[key] = to
      } catch (error) {
        this.logJob(id, `复制 ${key} 失败：${error.message}`)
      }
    }
    result.cacheWorkDir = result.workDir
    result.workDir = work
    this.updateJob(id, {
      status: 'done',
      progress: 100,
      stage: '完成',
      message: `${result.segments} 段 · ${Number(result.duration || 0).toFixed(1)}s（七步流水线）`,
      result,
    })
    this.logJob(id, `七步成片：${result.videoPath}`)
    return result
  }


  async runProduceJob(id, { source, topic, analysisId, assetIds, coverAssetId, autoPublish } = {}) {
    const work = path.join(this.workDir, id)
    ensureDir(work)
    let analysis = null
    let analysisPath = ''
    if (analysisId) {
      const previous = this.getJob(analysisId)
      if (!previous?.result?.analysis) throw new Error('找不到那份解析结果')
      analysis = previous.result.analysis
      analysisPath = previous.result.analysisPath || ''
    } else if (source) {
      this.updateJob(id, { progress: 5, stage: '解析参考视频', message: '先读画面…' })
      const parsed = await this.runAnalyzeJob(`${id}-a`, source)
      analysis = parsed.analysis
      analysisPath = parsed.analysisPath
    }
    this.updateJob(id, { progress: 22, stage: '写脚本', message: '按人设写口播…' })
    const script = await this.generateScript(analysis, topic)
    const scriptPath = path.join(work, 'script.json')
    writeJson(scriptPath, script)
    this.logJob(id, `脚本来自 ${script.source}，${script.scenes.length} 个场景`)

    const images = []
    const audios = []
    const segments = []
    const srt = []
    const assetPool = this.assetPool(assetIds)
    const coverAsset = this.resolveAsset(coverAssetId)
    if (assetPool.length) this.logJob(id, `使用素材 ${assetPool.length} 张，按场景轮换`)
    let cursor = 0
    for (let index = 0; index < script.scenes.length; index += 1) {
      const scene = script.scenes[index]
      this.updateJob(id, {
        progress: 28 + Math.round((index / Math.max(1, script.scenes.length)) * 52),
        stage: '配音与画面',
        message: `第 ${index + 1}/${script.scenes.length} 段：${truncate(scene.narration, 40)}`,
      })
      const base = path.join(work, `scene_${String(index + 1).padStart(2, '0')}`)
      const audio = await this.makeAudio(scene.narration, base)
      const duration = await this.probeDuration(audio) || Number(scene.durationSec || 4)
      const assetImage = assetPool.length ? assetPool[index % assetPool.length] : ''
      const image = assetImage || await this.apiImage(scene.imagePrompt, `${base}.png`, index)
      const segment = await this.makeSegment({ image, audio, outFile: `${base}.mp4`, duration })
      const realDuration = await this.probeDuration(segment) || duration
      srt.push(`${index + 1}\n${srtTime(cursor)} --> ${srtTime(cursor + realDuration)}\n${scene.text || scene.narration}\n`)
      cursor += realDuration
      images.push(image)
      audios.push(audio)
      segments.push(segment)
    }

    this.updateJob(id, { progress: 84, stage: '合成', message: '拼接片段…' })
    const listFile = path.join(work, 'concat.txt')
    writeText(listFile, segments.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'))
    const videoPath = path.join(this.outDir, `${id}.mp4`)
    let concat = await run(this.resolveFfmpeg(), [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoPath,
    ], { timeoutMs: 180000 })
    if (!concat.ok) {
      concat = await run(this.resolveFfmpeg(), [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', videoPath,
      ], { timeoutMs: 300000 })
    }
    if (!concat.ok) throw new Error(`拼接失败：${tail(concat.stderr, 700)}`)
    const srtPath = path.join(this.outDir, `${id}.srt`)
    writeText(srtPath, srt.join('\n'))
    const coverPath = path.join(this.outDir, `${id}.jpg`)
    const coverSource = coverAsset || ''
    let coverResult = { ok: false }
    if (coverSource) {
      coverResult = await run(this.resolveFfmpeg(), [
        '-y', '-i', coverSource, '-frames:v', '1', '-q:v', '2', coverPath,
      ], { timeoutMs: 60000 })
    } else {
      coverResult = await run(this.resolveFfmpeg(), [
        '-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-q:v', '2', coverPath,
      ], { timeoutMs: 60000 })
    }
    if (!coverResult.ok) {
      const fallback = coverSource || images[0]
      if (fallback) fs.copyFileSync(fallback, coverPath)
    }
    const metaPath = path.join(this.outDir, `${id}.json`)
    writeJson(metaPath, script)
    const duration = await this.probeDuration(videoPath)
    const result = {
      videoPath, coverPath, srtPath, metaPath, scriptPath, analysisPath,
      duration, scenes: script.scenes.length, title: script.title,
      source: script.source, assetCount: assetPool.length, coverAsset,
    }
    this.updateJob(id, {
      status: 'done', progress: 100, stage: '完成', message: `${script.scenes.length} 段 · ${duration.toFixed(1)}s`,
      result,
    })
    this.logJob(id, `视频生成：${videoPath}`)
    const shouldAuto = autoPublish ?? this.config().autoPublish
    if (shouldAuto) {
      try {
        const pending = await this.createPublishPending({
          jobId: id,
          meta: { title: script.title, desc: script.desc || '本视频由 AI 辅助生成，已提交人类审核。' },
        })
        result.pendingId = pending.id
        this.updateJob(id, { result, stage: '等待投稿审批' })
        this.logJob(id, `已自动提交投稿审批：${pending.id}`)
      } catch (error) {
        this.logJob(id, `自动提交投稿审批失败：${error.message}`)
      }
    }
    return result
  }

  async cleanCache() {
    const running = [...this.jobs.values()].filter((job) => job.status === 'running')
    if (running.length) return { ok: false, error: `还有 ${running.length} 个任务在跑，等它结束再清` }
    const targets = [
      this.workDir,
      this.outDir,
      path.join(this.dataDir, 'jobs'),
      path.join(this.dataDir, 'cache'),
      path.join(this.dataDir, 'analysis'),
      String(this.config().pipeline?.rootDir || 'D:/你的项目目录/.dafeiyu-studio'),
    ]
    let removed = 0
    for (const target of targets) {
      try {
        if (!fs.existsSync(target)) continue
        removed += fs.readdirSync(target).length
        fs.rmSync(target, { recursive: true, force: true })
      } catch (error) {
        return { ok: false, error: `清理 ${target} 失败：${error.message}` }
      }
    }
    ensureDir(this.workDir)
    ensureDir(this.outDir)
    ensureDir(path.join(this.dataDir, 'jobs'))
    return { ok: true, removed, message: `已清理工作区/输出/缓存（${removed} 项）` }
  }

  publishPayload(jobId, meta = {}) {
    const job = this.getJob(jobId)
    if (!job?.result?.videoPath) throw new Error('没有可发布的视频')
    const publish = this.config().publish || {}
    return {
      videoPath: job.result.videoPath,
      coverPath: job.result.coverPath,
      title: String(meta.title || job.result.title || '大肥鱼的视频').slice(0, 80),
      desc: String(meta.desc || '本视频由 AI 辅助生成并发布。').slice(0, 1900),
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 10) : (publish.tags || ['AI']),
      tid: Number(meta.tid || publish.tid || 21),
      declareAI: meta.declareAI !== false,
    }
  }

  async createPublishPending({ jobId, meta = {} } = {}) {
    const payload = this.publishPayload(jobId, meta)
    const pending = this.store.pendingCreate({
      capability: 'bili.video_publish',
      args: payload,
      summary: `投稿：${payload.title}`,
      reason: '视频投稿需要人类确认',
    })
    this.store.logAction({ capability: 'bili.video_publish', kind: 'publish', status: 'pending', summary: payload.title, args: payload })
    return pending
  }

  async executePublish({ approvalId, dryRun = false } = {}) {
    const item = this.store.pendingGet(approvalId)
    if (!item) throw new Error('找不到审批项')
    if (item.status !== 'approved') throw new Error(`审批项状态是 ${item.status}，还没批准`)
    const args = item.args || {}
    const upload = path.join(this.rootDir, 'studio', 'upload.py')
    if (!exists(upload)) throw new Error('上传脚本缺失：studio/upload.py')
    const metaFile = path.join(this.workDir, `publish-${shortId('p')}.json`)
    writeJson(metaFile, {
      title: args.title, desc: args.desc, tags: args.tags,
      tid: args.tid, declareAI: args.declareAI, dynamic: args.dynamic || '',
    })
    const python = this.resolvePython()
    const result = await run(python, [
      upload,
      '--video', args.videoPath,
      '--cover', args.coverPath,
      '--meta', metaFile,
      '--cookie', this.cookiePath(),
      dryRun ? '--dry-run' : '--confirm',
    ], { timeoutMs: 30 * 60000 })
    const output = pickJson(result.stdout || result.stderr)
    if (!dryRun) this.store.pendingConsume(approvalId, 'bili.video_publish', item.argsHash)
    this.store.logAction({
      capability: 'bili.video_publish', kind: 'publish',
      status: output.ok ? 'done' : 'error',
      summary: args.title, error: output.error || '',
    })
    if (!output.ok) throw new Error(output.error || '投稿失败')
    return output
  }
}

export function createStudio(options) {
  return new Studio(options)
}
