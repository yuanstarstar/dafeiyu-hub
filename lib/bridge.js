import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dshHome, truncate } from './util.js'

const KNOWN_PYTHONS = [
  path.join(dshHome(), 'dsh-runtimes', 'dsh-plugin-desktop-primary-runtime', 'dependencies', 'python', 'python.exe'),
  path.join(dshHome(), 'dsh-runtimes', 'dsh-plugin-desktop-primary-runtime', 'dependencies', 'python', 'python'),
]

export function bridgePath(rootDir) {
  return path.join(rootDir, 'bridge', 'bili_bridge.py')
}

export function resolvePython(config = {}) {
  const explicit = config?.bili?.pythonPath
  if (explicit && fs.existsSync(explicit)) return explicit
  if (process.env.DAFEIYU_PYTHON && fs.existsSync(process.env.DAFEIYU_PYTHON)) return process.env.DAFEIYU_PYTHON
  for (const candidate of KNOWN_PYTHONS) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

export function cookiePath(config = {}) {
  return config?.bili?.cookieFile || path.join(dshHome(), 'dafeiyu', 'secrets', 'bili_cookie.json')
}

export function bridgeInfo(rootDir, config = {}) {
  const file = bridgePath(rootDir)
  const cookie = cookiePath(config)
  return {
    path: file,
    exists: fs.existsSync(file),
    python: resolvePython(config),
    cookie,
    cookieExists: fs.existsSync(cookie),
    timeoutMs: Number(config?.bili?.bridgeTimeoutMs ?? 90000),
  }
}

function readTail(chunks) {
  return truncate(Buffer.concat(chunks).toString('utf8'), 4000)
}

/**
 * 调 Python 桥。bridge 最后一行必须是 JSON：{ok, action, data|error, code?}
 */
export function runBridge(rootDir, config, action, args = {}, options = {}) {
  const file = bridgePath(rootDir)
  if (!fs.existsSync(file)) {
    return Promise.resolve({ ok: false, error: `B 站桥还没装好：${file} 不存在`, code: 'BRIDGE_MISSING' })
  }
  const python = resolvePython(config)
  const cookie = cookiePath(config)
  const timeoutMs = Number(options.timeoutMs ?? config?.bili?.bridgeTimeoutMs ?? 90000)
  const payload = JSON.stringify({ action, args: args ?? {} })
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, [file, '--cookie', cookie, payload], {
        cwd: path.dirname(file),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      resolve({ ok: false, error: `启动 Python 失败：${error.message}`, code: 'PYTHON_SPAWN' })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, error: `桥执行超过 ${timeoutMs}ms，已取消`, code: 'TIMEOUT' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > 4 * 1024 * 1024) return
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < 200) err.push(chunk)
    })
    child.on('error', (error) => {
      finish({
        ok: false,
        error: error?.code === 'ENOENT'
          ? `找不到 Python（${python}）。在总控台填 pythonPath，或装一下运行时。`
          : `Python 进程出错：${error.message}`,
        code: 'PYTHON_ERROR',
      })
    })
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (!line.startsWith('{')) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object') {
            finish({ ...parsed, exitCode: code })
            return
          }
        } catch {}
      }
      finish({
        ok: false,
        error: `桥没有返回 JSON（exit ${code}）：${readTail(out) || readTail(err) || '无输出'}`,
        code: 'BAD_OUTPUT',
        stderr: readTail(err),
      })
    })
  })
}

export async function pingBridge(rootDir, config) {
  const started = Date.now()
  const result = await runBridge(rootDir, config, 'ping', {}, { timeoutMs: 15000 })
  return {
    ok: result.ok === true,
    ms: Date.now() - started,
    python: resolvePython(config),
    bridge: bridgePath(rootDir),
    cookie: cookiePath(config),
    detail: result.ok ? result.data : result,
  }
}
