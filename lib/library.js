import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, nowIso, readJson, writeJson } from './util.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.flv'])
const SKIP_TOP = new Set(['__pycache__', 'node_modules', '.git', '.cache', 'edit', 'research', 'raw', 'trainer', 'shots'])
const SCRATCH = /^(pk_qc\d*|pk_dbg|pk_probe|qc\d*|frames|probe)$/i
const ROLE_BY_PREFIX = [
  [/watermark/i, 'watermark'],
  [/sticker|贴纸/i, 'sticker'],
  [/char|whale|dafeiyu|立绘/i, 'character'],
  [/cover|封面/i, 'cover'],
  [/^ref|参考/i, 'ref'],
]
const ROLE_DIRS = {
  card: 'cards',
  character: 'src',
  cover: 'src',
  watermark: 'src',
  sticker: 'src',
  ref: 'src',
  src: 'src',
  vo: 'vo',
  base: 'base',
  qc: 'qc',
  sfx: 'sfx',
  bgm: 'bgm',
}

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

function isFile(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function slugify(value) {
  const input = String(value || '').trim()
  if (!input) return ''
  const ascii = input.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
  return ascii.slice(0, 80) || 'project'
}

function safeName(name) {
  const base = path.basename(String(name || '').replace(/[\\/]+/g, '_')).trim()
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) || 'asset'
}

function sumBytes(files) {
  return files.reduce((sum, item) => sum + (item.size || 0), 0)
}

function roleFor(file, rel, kind) {
  const lower = `${rel}/${file.name}`.toLowerCase()
  for (const [re, role] of ROLE_BY_PREFIX) if (re.test(lower)) return role
  if (kind === 'image' && /(^|\/)(cards?|assets?)\//i.test(rel)) return 'card'
  return kind
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json')
  if (!isFile(file)) return null
  const data = readJson(file, null)
  return data && typeof data === 'object' ? data : null
}

export class Library {
  constructor({ store, rootDir, logger }) {
    this.store = store
    this.rootDir = rootDir
    this.logger = logger
    this.indexDir = path.join(store.stateDir, 'library')
    this.indexPath = path.join(this.indexDir, 'index.json')
    ensureDir(this.indexDir)
    this.cache = null
    this.scannedAt = 0
  }

  config() {
    return this.store.configGet().studio || {}
  }

  projectsRoot() {
    return path.resolve(String(this.config().projectsDir || 'D:/你的工作目录/projects'))
  }

  legacyRoot() {
    return path.resolve(String(this.config().legacyWorkDir || 'D:/你的工作目录/work'))
  }

  scan({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.scannedAt < 20000) return this.cache
    const projects = []
    const seen = new Set()
    const push = (entry) => {
      if (seen.has(entry.id)) return
      seen.add(entry.id)
      projects.push(entry)
    }

    for (const entry of this.scanNewLayout()) push(entry)
    for (const entry of this.scanLegacy()) push(entry)

    projects.sort((a, b) => {
      const rank = { project: 0, scratch: 1, shared: 2, source: 3 }
      return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || String(b.mtime).localeCompare(String(a.mtime)) || a.name.localeCompare(b.name)
    })

    const result = {
      scannedAt: nowIso(),
      projectsRoot: this.projectsRoot(),
      legacyRoot: this.legacyRoot(),
      projects,
      summary: {
        total: projects.length,
        projects: projects.filter((p) => p.kind === 'project').length,
        scratch: projects.filter((p) => p.kind === 'scratch').length,
        shared: projects.filter((p) => p.kind === 'shared').length,
        source: projects.filter((p) => p.kind === 'source').length,
        assets: projects.reduce((n, p) => n + (p.counts?.images || 0), 0),
        bytes: projects.reduce((n, p) => n + (p.counts?.bytes || 0), 0),
      },
    }
    this.cache = result
    this.scannedAt = Date.now()
    try { writeJson(this.indexPath, result) } catch (error) {
      this.logger?.warn?.(`大肥鱼素材索引写入失败：${error.message}`)
    }
    return result
  }

  scanNewLayout() {
    const root = this.projectsRoot()
    if (!isDir(root)) return []
    const projects = []
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(root, entry.name)
      const manifest = readManifest(dir)
      if (!manifest) continue
      const contentDir = manifest.legacyPath && isDir(manifest.legacyPath) ? manifest.legacyPath : dir
      const files = this.walk(contentDir, { maxDepth: 2, maxFiles: 1200 })
      const stats = this.stats(files, contentDir)
      const dirs = this.detectDirs(contentDir)
      const counts = this.counts(files)
      projects.push({
        id: crypto.createHash('sha1').update(`new:${dir}`).digest('hex').slice(0, 12),
        slug: entry.name,
        name: manifest.name || manifest.title || entry.name,
        kind: 'project',
        layout: 'projects',
        path: dir,
        contentPath: contentDir,
        legacyPath: manifest.legacyPath || '',
        manifestPath: path.join(dir, 'manifest.json'),
        manifest,
        dirs,
        counts: { ...counts, bytes: sumBytes(files), files: files.length },
        assets: this.assetsFrom(files, contentDir, entry.name).slice(0, 80),
        outputs: stats.outputs,
        timeline: stats.timeline,
        mtime: this.latestMtime(files, contentDir),
        materialized: true,
      })
    }
    return projects
  }

  scanLegacy() {
    const root = this.legacyRoot()
    if (!isDir(root)) return []
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_TOP.has(entry.name.toLowerCase())) continue
      const dir = path.join(root, entry.name)
      const kind = SCRATCH.test(entry.name) ? 'scratch' : entry.name === 'raw' ? 'source' : 'project'
      const slug = slugify(entry.name)
      const target = path.join(this.projectsRoot(), slug)
      if (isFile(path.join(target, 'manifest.json'))) continue
      const walkOptions = kind === 'source'
        ? { maxDepth: 1, maxFiles: 1200 }
        : { maxDepth: 2, maxFiles: 3000 }
      const files = this.walk(dir, walkOptions)
      const stats = this.stats(files, dir)
      const dirs = this.detectDirs(dir)
      const counts = this.counts(files)
      const manifestPath = path.join(target, 'manifest.json')
      projects.push({
        id: crypto.createHash('sha1').update(`legacy:${dir}`).digest('hex').slice(0, 12),
        slug,
        name: entry.name,
        kind,
        layout: 'legacy',
        path: dir,
        legacyPath: dir,
        manifestPath: isFile(manifestPath) ? manifestPath : '',
        manifest: readManifest(dir) || null,
        dirs,
        counts: { ...counts, bytes: sumBytes(files), files: files.length },
        assets: this.assetsFrom(files, dir).slice(0, 80),
        outputs: stats.outputs,
        timeline: stats.timeline,
        mtime: this.latestMtime(files, dir),
        materialized: isFile(manifestPath),
      })
    }
    return projects
  }

  walk(dir, { maxDepth = 2, maxFiles = 3000 } = {}) {
    const files = []
    const visit = (current, depth) => {
      if (depth > maxDepth || files.length >= maxFiles) return
      let entries = []
      try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (files.length >= maxFiles) break
        if (entry.name.startsWith('.')) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_TOP.has(entry.name.toLowerCase())) continue
          visit(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        files.push({
          name: entry.name,
          path: full,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ext: path.extname(entry.name).toLowerCase(),
        })
      }
    }
    visit(dir, 0)
    return files
  }

  counts(files) {
    return {
      images: files.filter((f) => IMAGE_EXT.has(f.ext)).length,
      audio: files.filter((f) => AUDIO_EXT.has(f.ext)).length,
      video: files.filter((f) => VIDEO_EXT.has(f.ext)).length,
    }
  }

  stats(files, dir) {
    const outputs = files.filter((f) => VIDEO_EXT.has(f.ext) && f.size > 64 * 1024)
      .sort((a, b) => b.size - a.size)
      .slice(0, 8)
      .map((f) => ({ name: f.name, path: f.path, size: f.size, mtime: f.mtime }))
    const timeline = files.filter((f) => /timeline.*\.json$/i.test(f.name))
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
      .slice(0, 3)
      .map((f) => ({ name: f.name, path: f.path, size: f.size, mtime: f.mtime }))
    return { outputs, timeline }
  }

  detectDirs(dir) {
    const result = {}
    for (const key of ['cards', 'src', 'vo', 'base', 'qc', 'timeline', 'out']) {
      const candidate = path.join(dir, key)
      if (isDir(candidate)) result[key] = candidate
    }
    for (const child of ['assets', 'cards']) {
      const candidate = path.join(dir, 'edit', child)
      if (isDir(candidate)) result[child] = candidate
    }
    if (!result.vo && isDir(path.join(dir, 'voice'))) result.vo = path.join(dir, 'voice')
    if (!result.vo && isDir(path.join(dir, 'tts'))) result.vo = path.join(dir, 'tts')
    return result
  }

  assetsFrom(files, dir, projectSlug) {
    const slug = projectSlug || path.basename(dir)
    return files
      .filter((f) => IMAGE_EXT.has(f.ext) && f.size <= 30 * 1024 * 1024)
      .map((f) => {
        const rel = path.relative(dir, f.path).replace(/\\/g, '/')
        const role = roleFor(f, rel, 'image')
        const id = crypto.createHash('sha1').update(path.resolve(f.path)).digest('hex').slice(0, 12)
        return {
          id,
          name: f.name,
          role,
          rel,
          path: f.path,
          size: f.size,
          mtime: f.mtime,
          url: `/dafeiyu/api/library/file?project=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`,
        }
      })
      .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
  }

  latestMtime(files, dir) {
    let latest = 0
    try { latest = fs.statSync(dir).mtimeMs } catch {}
    for (const file of files) {
      const time = Date.parse(file.mtime) || 0
      if (time > latest) latest = time
    }
    return latest ? new Date(latest).toISOString() : ''
  }

  list() {
    return this.scan()
  }

  find(name) {
    const wanted = String(name || '').trim()
    if (!wanted) return null
    const all = this.scan().projects
    return all.find((p) => p.slug === wanted || p.name === wanted || p.path === path.resolve(wanted)) || null
  }

  project(name) {
    const project = this.find(name)
    if (!project) throw new Error('找不到这个项目')
    return project
  }

  projectManifest(project) {
    const manifestPath = project.layout === 'projects'
      ? path.join(project.path, 'manifest.json')
      : path.join(this.projectsRoot(), project.slug, 'manifest.json')
    const existing = readManifest(project.path) || readJson(manifestPath, null)
    const base = existing && typeof existing === 'object' ? existing : {}
    return {
      schema: 1,
      name: base.name || project.name,
      slug: project.slug,
      createdAt: base.createdAt || nowIso(),
      updatedAt: nowIso(),
      style: base.style || { width: 1920, height: 1080, fps: 30 },
      legacy: project.layout === 'legacy',
      legacyPath: project.legacyPath || base.legacyPath || '',
      projectPath: project.layout === 'projects' ? project.path : path.join(this.projectsRoot(), project.slug),
      dirs: {
        src: 'src',
        cards: 'cards',
        vo: 'vo',
        base: 'base',
        qc: 'qc',
        sfx: 'sfx',
        bgm: 'bgm',
      },
      assets: (() => {
        const merged = new Map()
        for (const item of (base.assets || [])) if (item?.id) merged.set(item.id, item)
        for (const item of project.assets) if (item?.id) merged.set(item.id, {
          id: item.id, name: item.name, role: item.role, rel: item.rel, size: item.size, mtime: item.mtime,
        })
        return [...merged.values()].slice(-200)
      })(),
      audio: base.audio || { sfxDir: 'D:/你的工作目录/work/research/sfx', bgmDir: 'D:/你的工作目录/work/research/bgm' },
      timeline: project.timeline.map((item) => item.path),
      outputs: project.outputs.map((item) => item.path),
      notes: base.notes || [],
    }
  }

  materialize(name) {
    const project = this.project(name)
    const target = path.join(this.projectsRoot(), project.slug)
    const dirs = ['src', 'cards', 'vo', 'base', 'qc', 'sfx', 'bgm']
    for (const dir of dirs) ensureDir(path.join(target, dir))
    const manifest = this.projectManifest(project)
    manifest.projectPath = target
    manifest.legacy = project.layout === 'legacy'
    writeJson(path.join(target, 'manifest.json'), manifest)
    this.cache = null
    return {
      ok: true,
      project: project.name,
      slug: project.slug,
      path: target,
      manifestPath: path.join(target, 'manifest.json'),
      moved: 0,
      copied: 0,
      note: '只建立清单和空目录，原文件没有移动',
    }
  }

  materializeAll() {
    const all = this.scan({ force: true }).projects.filter((p) => p.kind === 'project' && !p.materialized)
    const results = []
    for (const project of all) results.push(this.materialize(project.name))
    return { ok: true, count: results.length, results }
  }

  createProject({ name, title } = {}) {
    const projectName = String(name || title || '').trim()
    if (!projectName) throw new Error('项目名不能为空')
    const slug = slugify(projectName)
    const target = path.join(this.projectsRoot(), slug)
    if (fs.existsSync(target)) throw new Error(`项目已存在：${slug}`)
    const dirs = ['src', 'cards', 'vo', 'base', 'qc', 'sfx', 'bgm']
    for (const dir of dirs) ensureDir(path.join(target, dir))
    const manifest = {
      schema: 1,
      name: projectName,
      slug,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      style: { width: 1920, height: 1080, fps: 30 },
      legacy: false,
      legacyPath: '',
      projectPath: target,
      dirs: { src: 'src', cards: 'cards', vo: 'vo', base: 'base', qc: 'qc', sfx: 'sfx', bgm: 'bgm' },
      assets: [],
      audio: { sfxDir: 'D:/你的工作目录/work/research/sfx', bgmDir: 'D:/你的工作目录/work/research/bgm' },
      timeline: [],
      outputs: [],
      notes: [],
    }
    writeJson(path.join(target, 'manifest.json'), manifest)
    this.cache = null
    return { ok: true, project: projectName, slug, path: target, manifestPath: path.join(target, 'manifest.json') }
  }

  addAsset({ project, file, name, role } = {}) {
    const targetProject = this.project(project)
    const source = path.resolve(String(file || '').trim())
    if (!isFile(source)) throw new Error('源文件不存在')
    const ext = path.extname(source).toLowerCase()
    const kind = IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : VIDEO_EXT.has(ext) ? 'video' : ''
    if (!kind) throw new Error('只支持图片/音频/视频')
    const chosenRole = String(role || (kind === 'image' ? 'card' : kind)).trim()
    const dirName = ROLE_DIRS[chosenRole] || (kind === 'image' ? 'src' : kind === 'audio' ? 'sfx' : 'base')
    const targetRoot = path.join(this.projectsRoot(), targetProject.slug)
    if (!isFile(path.join(targetRoot, 'manifest.json'))) this.materialize(targetProject.name)
    const dir = path.join(targetRoot, dirName)
    ensureDir(dir)
    let target = path.join(dir, safeName(name || path.basename(source)))
    if (fs.existsSync(target)) {
      const extName = path.extname(target)
      target = path.join(dir, `${path.basename(target, extName)}-${Date.now().toString(36)}${extName}`)
    }
    fs.copyFileSync(source, target)
    const manifestPath = path.join(targetRoot, 'manifest.json')
    const manifest = readJson(manifestPath, {})
    const item = {
      id: crypto.createHash('sha1').update(path.resolve(target)).digest('hex').slice(0, 12),
      name: path.basename(target),
      role: chosenRole,
      rel: path.relative(targetRoot, target).replace(/\\/g, '/'),
      size: fs.statSync(target).size,
      mtime: new Date().toISOString(),
      path: target,
    }
    manifest.assets = Array.isArray(manifest.assets) ? manifest.assets : []
    manifest.assets.push(item)
    manifest.updatedAt = nowIso()
    writeJson(manifestPath, manifest)
    this.cache = null
    return { ok: true, project: targetProject.name, slug: targetProject.slug, asset: item, target }
  }

  plan() {
    const all = this.scan({ force: true }).projects.filter((p) => p.kind === 'project')
    const pending = all.filter((p) => !p.materialized)
    return {
      ok: true,
      projectsRoot: this.projectsRoot(),
      count: pending.length,
      total: all.length,
      existing: all.length - pending.length,
      actions: all.map((p) => ({
        project: p.name,
        slug: p.slug,
        from: p.path,
        to: path.join(this.projectsRoot(), p.slug),
        materialized: p.materialized,
        files: p.counts.files,
        bytes: p.counts.bytes,
        action: p.materialized ? 'exists' : 'create-manifest',
        note: '只建清单，不移动文件',
      })),
    }
  }

  audioLibrary() {
    const cfg = this.config()
    const dirs = [
      { kind: 'sfx', dir: path.resolve(String(cfg.sfxDir || 'D:/你的工作目录/work/research/sfx')) },
      { kind: 'bgm', dir: path.resolve(String(cfg.bgmDir || 'D:/你的工作目录/work/research/bgm')) },
    ]
    const result = { sfx: [], bgm: [] }
    for (const item of dirs) {
      if (!isDir(item.dir)) continue
      let entries = []
      try { entries = fs.readdirSync(item.dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isFile() || !AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue
        const full = path.join(item.dir, entry.name)
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        result[item.kind].push({ name: entry.name, path: full, size: stat.size })
      }
      result[item.kind].sort((a, b) => a.name.localeCompare(b.name))
    }
    return result
  }

  status() {
    const data = this.scan()
    return {
      ok: true,
      projectsRoot: data.projectsRoot,
      legacyRoot: data.legacyRoot,
      scannedAt: data.scannedAt,
      summary: data.summary,
      audio: this.audioLibrary(),
      projects: data.projects.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        kind: p.kind,
        layout: p.layout,
        path: p.path,
        legacyPath: p.legacyPath,
        manifestPath: p.manifestPath,
        materialized: p.materialized,
        counts: p.counts,
        dirs: p.dirs,
        outputs: p.outputs,
        timeline: p.timeline,
        mtime: p.mtime,
        assets: p.assets.slice(0, 12),
      })),
    }
  }
}

export function createLibrary(options) {
  return new Library(options)
}
