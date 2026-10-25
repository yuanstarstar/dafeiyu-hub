// Runs dsh-video-understand's registered tool against a local video, without
// mounting the plugin in DSH. Called by video_analysis/analyzer.py.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const plugin = process.env.VIDEO_UNDERSTAND_PLUGIN
const target = process.argv[2]
const outFile = process.argv[3]
const argsFile = process.argv[4]
if (!target || !outFile) {
  console.error('usage: node video_runner.mjs <video> <out.json> [args.json]')
  process.exit(2)
}
const extraArgs = argsFile ? JSON.parse(readFileSync(argsFile, 'utf8')) : {}
const mod = await import(pathToFileURL(plugin).href)
const registered = []
mod.apply({ effect() {}, tools: { register: (tool) => registered.push(tool) } }, {})
const tool = registered[0]
if (!tool) throw new Error(`没有从 ${plugin} 注册到工具`)
const ac = new AbortController()
const t0 = Date.now()
let out = null
let error = null
try {
  out = await tool.execute({ target, ...extraArgs }, { signal: ac.signal })
} catch (err) {
  error = String((err && err.stack) || err)
}
const result = { toolName: tool.name, elapsedMs: Date.now() - t0, result: out, error }
writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
console.log(`DONE elapsedMs=${result.elapsedMs} error=${error ? 'yes' : 'no'}`)
if (error) console.error(error)
