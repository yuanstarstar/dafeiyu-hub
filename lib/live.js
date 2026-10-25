import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { bridgeInfo, runBridge } from './bridge.js'
import { dshHome, nowIso } from './util.js'

function exists(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

function findLiveHime(explicit) {
  if (explicit && exists(explicit)) return explicit
  const roots = [
    'C:/Program Files/bililive/livehime',
    'C:/Program Files (x86)/bililive/livehime',
    path.join(dshHome(), 'tools', 'livehime'),
  ]
  for (const root of roots) {
    try {
      const versions = fs.readdirSync(root)
        .map((name) => path.join(root, name, 'livehime.exe'))
        .filter(exists)
        .sort()
      if (versions.length) return versions[versions.length - 1]
    } catch {}
  }
  return ''
}

async function isRunning(name = 'livehime.exe') {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('close', () => resolve(out.toLowerCase().includes(name.toLowerCase())))
    child.on('error', () => resolve(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPowerShell(script, args = [], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message, stdout, stderr }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      let parsed = null
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith('{')) {
          try { parsed = JSON.parse(lines[i]); break } catch {}
        }
      }
      resolve(parsed || { ok: false, error: (stderr || stdout || `powershell exit ${code}`).slice(0, 800), stdout, stderr })
    })
  })
}

export class Live {
  constructor({ store, rootDir, logger, bridgeOptions }) {
    this.store = store
    this.rootDir = rootDir
    this.logger = logger
    this.bridgeOptions = bridgeOptions || {}
  }

  config() {
    return this.store.configGet().live || {}
  }

  async status() {
    const cfg = this.config()
    const exe = findLiveHime(cfg.livehimePath)
    const running = exe ? await isRunning() : false
    let room = null
    let roomError = ''
    if (cfg.roomId) {
      try {
        const result = await runBridge(this.rootDir, this.store.configGet(), 'live_room', { room_id: Number(cfg.roomId) }, this.bridgeOptions)
        room = result.ok ? result.data : null
        roomError = result.ok ? '' : (result.error || '')
      } catch (error) {
        roomError = String(error.message || error)
      }
    }
    return {
      enabled: cfg.enabled === true,
      autoStart: cfg.autoStart === true,
      mode: cfg.mode || 'livehime',
      livehime: {
        path: exe,
        exists: Boolean(exe),
        running,
        version: exe ? path.basename(path.dirname(exe)) : '',
      },
      roomId: cfg.roomId || 0,
      areaId: cfg.areaId || 0,
      title: cfg.title || '',
      room,
      roomError,
      canStart: Boolean(cfg.autoStart && exe),
      startBlockedBy: cfg.autoStart
        ? (exe ? '' : '开了自动开播，但没找到直播姬')
        : '自动开播没开：在总控台「创作」里打开「允许自动点开始直播」才会尝试',
      bridge: bridgeInfo(this.rootDir, this.store.configGet()),
      updatedAt: nowIso(),
    }
  }

  async launch() {
    const cfg = this.config()
    if (!cfg.enabled) throw new Error('直播功能还没开：先在总控台「创作」里打开')
    const exe = findLiveHime(cfg.livehimePath)
    if (!exe) throw new Error('没找到直播姬：请先安装，或在总控台填 livehime.exe 路径')
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    return { ok: true, pid: child.pid, exe }
  }

  async check() {
    const cfg = this.config()
    if (!cfg.roomId) throw new Error('先在总控台填直播间号（roomId）')
    const result = await runBridge(this.rootDir, this.store.configGet(), 'live_room', { room_id: Number(cfg.roomId) }, this.bridgeOptions)
    return result
  }

  async start() {
    const cfg = this.config()
    if (!cfg.enabled) throw new Error('直播功能还没开：先在总控台「创作」里打开')
    if (!cfg.autoStart) {
      return { ok: false, code: 'AUTOSTART_OFF', plan: await this.startPlan() }
    }
    const exe = findLiveHime(cfg.livehimePath)
    if (!exe) throw new Error('没找到直播姬：请先安装，或在总控台填 livehime.exe 路径')
    if (!(await isRunning())) {
      await this.launch()
      for (let i = 0; i < 20; i += 1) {
        await sleep(1000)
        if (await isRunning()) break
      }
      await sleep(3000)
    }
    const script = path.join(this.rootDir, 'studio', 'live_uia.ps1')
    if (!exists(script)) throw new Error('自动开播脚本缺失：studio/live_uia.ps1')
    const uia = await runPowerShell(script, ['-Action', 'click'], 45000)
    if (!uia.ok) {
      return {
        ok: false,
        code: uia.code || 'UIA_FAILED',
        error: uia.error || '没有点到开始直播',
        buttons: uia.buttons || [],
        plan: await this.startPlan(),
      }
    }
    await sleep(4000)
    let room = null
    if (cfg.roomId) {
      const check = await runBridge(this.rootDir, this.store.configGet(), 'live_room', { room_id: Number(cfg.roomId) }, this.bridgeOptions)
      room = check.ok ? check.data : { error: check.error }
    }
    return { ok: true, clicked: uia.clicked, room, note: '点了开始直播，但请在直播姬和 B 站直播间确认真的开了；我不会假装已经开播。' }
  }

  async startPlan() {
    const cfg = this.config()
    const exe = findLiveHime(cfg.livehimePath)
    return {
      ok: false,
      code: cfg.autoStart ? 'LIVE_AUTOSTART_EXPERIMENTAL' : 'LIVE_AUTOSTART_NOT_READY',
      mode: cfg.mode || 'livehime',
      livehime: exe || '',
      autoStart: cfg.autoStart === true,
      steps: [
        '检测/启动直播姬：已完成，可在总控台点「启动直播姬」。',
        '直播间号/分区/标题：在总控台填写并保存。',
        cfg.autoStart
          ? '自动开播：会尝试用 Windows UI Automation 点「开始直播」，只点名字匹配的按钮，不盲点坐标。'
          : '自动开播：没开；打开后才会尝试点「开始直播」。',
        '开播后请在直播姬和 B 站直播间确认；失败会如实返回按钮列表，不会假装成功。',
      ],
      note: cfg.autoStart
        ? '自动开播是实验功能：只认按钮文字，界面改版就会失败。失败时请手动点。'
        : '我不想假装已经能自己开播。先把能验证的检测、只读房间信息和启动做完。',
    }
  }
}

export function createLive(options) {
  return new Live(options)
}
