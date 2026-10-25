import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, nowIso } from './util.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.cache', 'trainer', 'models'])
const DEFAULT_DIRS = []

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

function isFile(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function safeName(name) {
  const base = path.basename(String(name || '').replace(/[\\/]+/g, '_')).trim()
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) || 'asset'
}

export class Assets {
  constructor({ store, rootDir, logger }) {
    this.store = store
    this.rootDir = rootDir
    this.logger = logger
    this.dir = path.join(store.stateDir, 'assets')
    ensureDir(this.dir)
    this.cache = null
    this.scannedAt = 0
  }

  config() {
    return this.store.configGet().studio || {}
  }

  roots() {
    const cfg = this.config()
    const configured = Array.isArray(cfg.assetDirs) ? cfg.assetDirs : []
    const candidates = [...configured, ...DEFAULT_DIRS, this.dir]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
    const seen = new Set()
    const roots = []
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate)
      let real = resolved
      try { real = fs.realpathSync(resolved) } catch {}
      if (seen.has(real) || !isDir(real)) continue
      seen.add(real)
      roots.push(real)
    }
    return roots
  }

  scan({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.scannedAt < 15000) return this.cache
    const roots = this.roots()
    const items = []
    const seen = new Set()
    const visit = (dir, depth) => {
      if (depth > 2) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
          visit(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!IMAGE_EXT.has(ext)) continue
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        if (!stat.size || stat.size > 30 * 1024 * 1024) continue
        let real = full
        try { real = fs.realpathSync(full) } catch {}
        if (seen.has(real)) continue
        seen.add(real)
        items.push({
          id: crypto.createHash('sha1').update(real).digest('hex').slice(0, 12),
          name: entry.name,
          path: full,
          root: dir,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ext,
        })
      }
    }
    for (const root of roots) visit(root, 0)
    items.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)) || a.name.localeCompare(b.name))
    this.cache = items
    this.scannedAt = Date.now()
    return items
  }

  publicList({ force = false } = {}) {
    return this.scan({ force }).map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      root: item.root,
      size: item.size,
      ext: item.ext,
      mtime: item.mtime,
      url: `/dafeiyu/api/assets/file?id=${encodeURIComponent(item.id)}`,
    }))
  }

  status() {
    const items = this.scan()
    return {
      roots: this.roots(),
      count: items.length,
      scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : '',
      now: nowIso(),
    }
  }

  resolve(idOrPath) {
    const input = String(idOrPath || '').trim()
    if (!input) return ''
    if (/^[a-f0-9]{12}$/i.test(input)) {
      const item = this.scan().find((entry) => entry.id.toLowerCase() === input.toLowerCase())
      return item?.path || ''
    }
    const candidate = path.resolve(input)
    if (!isFile(candidate)) return ''
    let real = candidate
    try { real = fs.realpathSync(candidate) } catch {}
    const roots = this.roots().map((root) => {
      try { return fs.realpathSync(root) } catch { return root }
    })
    const allowed = roots.some((root) => real === root || real.startsWith(root + path.sep))
    return allowed ? real : ''
  }

  find(id) {
    return this.scan().find((entry) => entry.id === String(id || '')) || null
  }

  importFile(source, name) {
    const sourcePath = path.resolve(String(source || '').trim())
    if (!isFile(sourcePath)) throw new Error('源文件不存在')
    if (!IMAGE_EXT.has(path.extname(sourcePath).toLowerCase())) throw new Error('只支持图片文件')
    const targetName = safeName(name || path.basename(sourcePath))
    let target = path.join(this.dir, targetName)
    if (fs.existsSync(target)) {
      const ext = path.extname(targetName)
      target = path.join(this.dir, `${path.basename(targetName, ext)}-${Date.now().toString(36)}${ext}`)
    }
    fs.copyFileSync(sourcePath, target)
    const item = this.scan({ force: true }).find((entry) => path.resolve(entry.path) === path.resolve(target))
    if (!item) throw new Error('导入后索引不到文件')
    return item
  }
}

export function createAssets(options) {
  return new Assets(options)
}
