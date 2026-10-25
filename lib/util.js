import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const nowIso = () => new Date().toISOString()
export const nowMs = () => Date.now()

export function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function monthKey(offset = 0) {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function shortId(prefix = 'p') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

export function truncate(text, max = 200) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

export function writeText(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    try { fs.unlinkSync(file) } catch {}
    fs.renameSync(tmp, file)
  }
  return file
}

export function writeIfMissing(file, text) {
  ensureDir(path.dirname(file))
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

export function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return structuredClone(fallback)
    return JSON.parse(text)
  } catch {
    return structuredClone(fallback)
  }
}

export function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${line}\n`, 'utf8')
  return file
}

export function listFiles(dir, ext = '') {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !ext || name.endsWith(ext))
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try { return fs.statSync(file).isFile() } catch { return false }
      })
  } catch {
    return []
  }
}

export function mtimeIso(file) {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString()
  } catch {
    return null
  }
}

export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (Array.isArray(patch)) return patch
  if (patch === null || typeof patch !== 'object') return patch
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value)
  }
  return out
}

export function parseFrontMatter(raw) {
  const text = String(raw ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (!key) continue
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    meta[key] = value
  }
  return { meta, body: text.slice(match[0].length).trim() }
}

export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim()
}

export function bodyLines(raw, maxLines, maxChars = 1200) {
  const { body } = parseFrontMatter(raw)
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('>'))
  const picked = []
  let used = 0
  for (const line of lines) {
    if (picked.length >= maxLines) break
    if (used + line.length > maxChars) break
    picked.push(line)
    used += line.length
  }
  return picked
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function hashArgs(value) {
  return crypto.createHash('sha1').update(stableStringify(value ?? {})).digest('hex').slice(0, 16)
}

export function localTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function inQuietHours(start = '23:30', end = '08:30', date = new Date()) {
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const cur = date.getHours() * 60 + date.getMinutes()
  const a = toMin(start)
  const b = toMin(end)
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

export function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 1800 ? `${value.slice(0, 1800)}…` : value
  if (typeof value !== 'object') return value
  if (depth >= 5) return '[deep]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => compactValue(item, depth + 1))
    if (value.length > 20) head.push(`…(${value.length - 20} more)`)
    return head
  }
  const out = {}
  for (const [key, val] of Object.entries(value)) out[key] = compactValue(val, depth + 1)
  return out
}

export function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir()
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(homeDir(), '.dsh')
}

export function toPosix(file) {
  return String(file).replace(/\\/g, '/')
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
