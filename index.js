import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './lib/store.js'
import { registerTools } from './lib/tools.js'
import { buildSelfCard } from './lib/prompt.js'
import { createHttpHandler } from './lib/http.js'
import { createHeartbeat } from './lib/heartbeat.js'
import { createFeedback } from './lib/feedback.js'
import { createSocial } from './lib/social.js'
import { createStudio } from './lib/studio.js'
import { createLive } from './lib/live.js'
import { createAssets } from './lib/assets.js'
import { createLibrary } from './lib/library.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 系统注入的时间/任务通知/压缩提示不是“说过的话”，不该占用短记忆。
function isNoise(text) {
  const value = String(text || '').trim()
  if (!value) return true
  if (value.startsWith('Time sampled while preparing')) return true
  if (value.startsWith('background job ')) return true
  if (value.startsWith('📦 [ACP]') || value.startsWith('❌ [ACP]')) return true
  if (value.startsWith('[Compressed conversation section]')) return true
  if (value.includes('Browser time zone for this request')) return true
  if (value.includes('Elapsed since the preceding step context')) return true
  if (value.includes('<system-reminder>')) return true
  return false
}

export const inject = ['tools', 'systemPrompt', 'webServer', 'timer', 'agents', 'sessionProjections']

export function apply(ctx) {
  const logger = ctx.logger
  let store
  try {
    store = new Store({ rootDir: HERE })
  } catch (error) {
    logger?.error?.('dafeiyu: 状态目录初始化失败', error)
    throw error
  }

  // 1) 模型工具
  const assets = createAssets({ store, rootDir: HERE, logger })
  const library = createLibrary({ store, rootDir: HERE, logger })
  const studio = createStudio({ store, rootDir: HERE, logger, assets })
  const live = createLive({ store, rootDir: HERE, logger })
  const feedback = createFeedback(ctx, store, HERE, logger)
  const social = createSocial(ctx, store, logger)
  registerTools(ctx, store, HERE, { studio, live, feedback, assets, library })

  // 外部 `bili_interact` 的点赞/收藏/弹幕也算 B 站真实动作；与 feiyu_bili 互不重叠，避免“换个工具就 0 分”。
  ctx.effect(
    () => ctx.on('tools/result', (exec, result) => {
      try {
        if (exec?.name !== 'bili_interact') return
        if (result?.isError === true || result?.error) return
        const args = exec.arguments ?? {}
        if (args.dryRun === true) return
        const action = String(args.action ?? '')
        if (!['like', 'fav', 'danmaku', 'triple', 'follow'].includes(action)) return
        const gain = action === 'triple' ? 8 : 5
        store.satisfactionAdd(gain, `bili_interact.${action}`, `B站互动 ${action}`)
      } catch (error) {
        logger?.warn?.('dafeiyu: bili_interact 计分失败', error)
      }
    }),
    'dafeiyu: bili_interact satisfaction',
  )

  // 2) 系统提示（每次组装时重读状态，保持短小）
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'dafeiyu-self',
      order: 30,
      text: () => buildSelfCard(store),
    }),
    'dafeiyu: prompt section',
  )

  // 3) 短时记忆捕获 + 聊天厌倦度
  let heartbeat = null
  const turnState = new Map()
  const chatState = new Map()
  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      try {
        const config = store.configGet()
        const sessionId = session?.id ?? session?.header?.id ?? 'unknown'
        // 只记与本人直接对话的根会话；子代理/团队成员的会话不进“刚说过的话”。
        const rootSession = (() => {
          try {
            return ctx.agents.roots().some((agent) => agent.id === sessionId || agent.session === session)
          } catch {
            return false
          }
        })()
        if (!rootSession) return
        if (event?.type === 'turn/start') {
          chatState.set(sessionId, { hadTool: false, heartbeat: false })
          return
        }
        if (event?.type === 'tool/call') {
          const state = chatState.get(sessionId) ?? { hadTool: false, heartbeat: false }
          state.hadTool = true
          chatState.set(sessionId, state)
          try {
            if (state.heartbeat) {
              const name = event.data?.name ?? event.data?.tool?.name ?? event.data?.toolName ?? ''
              heartbeat?.noteTool?.(sessionId, name)
            }
          } catch {}
          return
        }
        if (event?.type === 'turn/end') {
          const state = chatState.get(sessionId)
          if (state && !state.heartbeat) store.recordChat(state.hadTool)
          chatState.delete(sessionId)
          return
        }
        if (!config.captureMemory) return
        if (event?.type === 'user/message') {
          const message = event.data
          if (message?.source?.kind === 'schedule') {
            const state = chatState.get(sessionId)
            if (state) state.heartbeat = true
            return
          }
          const text = extractText(message)
          if (text && !isNoise(text)) {
            store.shortAdd('你', text)
            try {
              const relationUid = String(config.relation?.ownerUid ?? '').trim()
              if (relationUid) {
                const tick = store.relationChatTick(sessionId, {
                  uid: relationUid,
                  every: config.relation?.chatEvery ?? 4,
                  max: config.relation?.maxCloseness ?? 10,
                })
                if (tick.bumped) logger?.info?.(`dafeiyu: 和 ${relationUid} 的亲近度涨到 ${tick.closeness}`)
              }
            } catch (error) {
              logger?.warn?.('dafeiyu: 亲近度更新失败', error)
            }
          }
          return
        }
        if (event?.type === 'assistant/message') {
          const text = extractText(event.data?.message)
          if (text) store.shortAdd('大肥鱼', text)
        }
      } catch (error) {
        logger?.warn?.('dafeiyu: 会话事件处理失败', error)
      }
    }),
    'dafeiyu: session capture',
  )

  // 4) 心跳（默认关闭，由总控台打开）
  heartbeat = createHeartbeat(ctx, store, logger)
  ctx.effect(() => {
    heartbeat.start()
    return () => heartbeat.stop()
  }, 'dafeiyu: heartbeat')

  // 5) 互动反馈（定时查 B 站谁回复/@/赞了我；有就同步到会话）
  ctx.effect(() => {
    feedback.start()
    return () => feedback.stop()
  }, 'dafeiyu: feedback')

  // 6) 主动社交脉冲（定时给会话一个“去找人玩”的任务，默认关闭）
  ctx.effect(() => {
    social.start()
    return () => social.stop()
  }, 'dafeiyu: social')

  // 7) 总控台 HTTP API
  const httpHandler = createHttpHandler({ store, rootDir: HERE, heartbeat, webServer: ctx.webServer, studio, live, feedback, social, assets, library })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/dafeiyu/api', handler: httpHandler }),
    'dafeiyu: http api',
  )

  logger?.info?.(`大肥鱼已上线：${store.stateDir}`)
}

function extractText(message) {
  if (!message) return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
