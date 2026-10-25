import { CAPABILITIES, resolveCapability } from './catalog.js'
import { compactValue, hashArgs, inQuietHours, nowMs, truncate } from './util.js'

const WRITE_KINDS = new Set(['write', 'publish', 'money', 'destructive'])

export function isWriteCapability(cap) {
  return WRITE_KINDS.has(cap?.kind)
}

export function effectivePolicy(policy, cap) {
  return policy?.overrides?.[cap.id] ?? cap.default
}

export function approvalSummary(cap, args = {}) {
  const a = args ?? {}
  if (cap.id === 'bili.comment_add') {
    const target = a.bvid ?? a.aid ?? a.oid ?? '?'
    return `在 ${target} 发评论：${truncate(a.message ?? a.text ?? '', 80)}`
  }
  if (cap.id === 'bili.dm_send' || cap.id === 'bili.dynamic_post') {
    return `${cap.label}：${truncate(a.message ?? a.text ?? a.content ?? a.dynamic ?? '', 100)}`
  }
  if (cap.id === 'bili.danmaku_send' || cap.id === 'bili.live_danmaku') {
    return `${cap.label}：${truncate(a.message ?? a.text ?? a.danmaku ?? '', 80)}`
  }
  return `${cap.label} ${truncate(JSON.stringify(compactValue(a)), 140)}`
}

function limitFor(policy, cap, window) {
  const key = window === 'hour' ? 'perHour' : 'perDay'
  const direct = cap.limit?.[key]
  if (Number.isFinite(direct)) return direct
  if (cap.id === 'bili.comment_add' && window === 'day') return policy.limits?.commentPerDay
  if (cap.id === 'bili.dm_send' && window === 'day') return policy.limits?.dmPerDay
  if ((cap.id === 'bili.dynamic_post' || cap.id === 'bili.video_publish') && window === 'day') return policy.limits?.publishPerDay
  if ((cap.id === 'bili.danmaku_send' || cap.id === 'bili.live_danmaku') && window === 'hour') return policy.limits?.danmakuPerHour
  if (cap.id === 'bili.like' && window === 'hour') return policy.limits?.likePerHour
  return undefined
}

export function suggestAlternatives(store, cap, policy, count = 3) {
  const threshold = Number(policy?.boredomThreshold ?? 70)
  const seen = new Set()
  const candidates = []
  for (const candidate of CAPABILITIES) {
    if (candidate.id === cap.id) continue
    if (candidate.group === cap.group) continue
    if (candidate.default === 'deny' && policy?.overrides?.[candidate.id] !== 'allow') continue
    const boredom = store.boredomValue(candidate.group)
    if (boredom >= threshold) continue
    if (seen.has(candidate.group)) continue
    seen.add(candidate.group)
    candidates.push({
      id: candidate.id,
      label: candidate.label,
      group: candidate.group,
      boredom: Math.round(boredom),
      why: candidate.kind === 'task' ? '换个脑子' : '换种内容',
    })
  }
  candidates.sort((a, b) => a.boredom - b.boredom)
  const picked = candidates.slice(0, count)
  if (picked.length < count) {
    picked.push({ id: 'task.rest', label: '休息 / 发呆', group: '休息', boredom: 0, why: '什么都不做也算一种选择' })
  }
  return picked.slice(0, count)
}

/**
 * 权限总闸。返回 {decision: 'allow'|'deny'|'ask'|'pending'|'approved', ...}
 * 纯读不产生副作用；写操作会按需创建审批项。
 */
export function check(store, capability, args = {}, options = {}) {
  const cap = typeof capability === 'string' ? resolveCapability(capability) : capability
  if (!cap) return { decision: 'deny', reason: `未知能力：${capability}` }
  const policy = store.policyGet()
  const isWrite = isWriteCapability(cap)
  const override = policy.overrides?.[cap.id]
  const effective = override ?? cap.default
  const dryRun = options.dryRun === true || options.checkOnly === true

  if (isWrite) {
    const risk = store.riskGet()
    if (risk) {
      return {
        decision: 'deny',
        reason: `账号风控冷却中（到 ${risk.until}）：${risk.reason}。这期间只读，不写。`,
        risk,
      }
    }
    if (policy.quietHours?.enabled && inQuietHours(policy.quietHours.start, policy.quietHours.end) && override !== 'allow') {
      return {
        decision: 'deny',
        reason: `现在是安静时段（${policy.quietHours.start}–${policy.quietHours.end}），不写东西。可以看，可以想，别发。`,
      }
    }
  }

  if (cap.weight > 0) {
    const value = store.boredomValue(cap.group)
    const threshold = Number(policy.boredomThreshold ?? 70)
    if (value >= threshold) {
      return {
        decision: 'deny',
        reason: `对「${cap.group}」已经有点腻了（${Math.round(value)}/${threshold}）。换一件事做，别硬撑。`,
        boredom: value,
        alternatives: suggestAlternatives(store, cap, policy),
      }
    }
  }

  if (effective === 'deny') {
    return { decision: 'deny', reason: `人类把「${cap.label}」设成了禁止。` }
  }

  if (isWrite) {
    const now = nowMs()
    const autoRun = policy.autonomy === 'high'
      && cap.kind === 'write'
      && override !== 'ask'
      && Array.isArray(policy.autoApprove)
      && policy.autoApprove.includes(cap.id)
    // 测试用：limits.unlimited=true 时六种数量限额全部跳过（风控/安静/厌倦仍生效）。
    // dmUnlimited 保留为旧配置的兼容别名，只影响私信。
    const unlimitedLimits = policy.limits?.unlimited === true
    const unlimitedDm = unlimitedLimits || (cap.id === 'bili.dm_send' && policy.limits?.dmUnlimited === true)
    const hourAgo = now - 3600000
    const dayAgo = now - 86400000
    const writeLimit = Number(policy.limits?.writePerHour ?? 0)
    if (!unlimitedLimits && writeLimit > 0) {
      const writes = store.countSince(hourAgo, (entry) => ['write', 'publish'].includes(entry.kind) && entry.status === 'done')
      if (writes >= writeLimit) {
        return {
          decision: 'deny',
          reason: `这一小时已经写了 ${writes} 次，到上限 ${writeLimit} 了。歇一会儿。`,
          limit: { window: 'hour', used: writes, limit: writeLimit, remaining: 0 },
          alternatives: suggestAlternatives(store, cap, policy),
        }
      }
    }
    for (const [window, since] of [['hour', hourAgo], ['day', dayAgo]]) {
      if (unlimitedLimits || unlimitedDm) continue
      const limit = limitFor(policy, cap, window)
      if (!Number.isFinite(limit) || limit <= 0) continue
      const used = store.countSince(since, (entry) => entry.capability === cap.id && entry.status === 'done')
      if (used >= limit) {
        return {
          decision: 'deny',
          reason: `「${cap.label}」${window === 'hour' ? '这一小时' : '今天'}已经 ${used} 次，到上限 ${limit} 了。`,
          limit: { window, used, limit, remaining: 0 },
          alternatives: suggestAlternatives(store, cap, policy),
        }
      }
    }
    if (autoRun) {
      // 高度自主：日常互动直接执行；发布视频/投稿、投币、账号安全仍走审批。
      return {
        decision: 'allow',
        auto: true,
        effective: 'auto',
        reason: `高度自主：${cap.label} 在自动执行清单里，已放行（仍受限额、厌倦、风控和安静时段约束）。`,
      }
    }
  }

  if (isWrite && (policy.requireApproval !== false || effective === 'ask')) {
    if (dryRun) {
      return { decision: 'ask', reason: `正式执行会进入审批队列（${cap.label}）。`, effective }
    }
    const approvalId = options.approvalId
    if (approvalId) {
      const cleanArgs = { ...args }
      delete cleanArgs.approvalId
      return {
        decision: 'approved',
        approvalId,
        argsHash: hashArgs(cleanArgs),
        reason: '审批项由执行方核销。',
      }
    }
    const pending = store.pendingCreate({
      capability: cap.id,
      args,
      summary: approvalSummary(cap, args),
      reason: `写操作：${cap.label}`,
    })
    return {
      decision: 'pending',
      pendingId: pending.id,
      duplicate: pending.duplicate === true,
      summary: pending.summary,
      reason: pending.duplicate
        ? '这个动作刚才已经提交过审批了，还在等人点头。别重复提交。'
        : '已经放进审批队列。等人类在总控台点头后，用同一个动作加 approvalId 再调用一次。',
    }
  }

  return { decision: 'allow', effective, capability: cap.id }
}

export function riskFromResult(result) {
  const text = JSON.stringify(result ?? {}).toLowerCase()
  const code = result?.code ?? result?.error?.code ?? result?.data?.code
  if (String(code) === '-352' || text.includes('-352') || text.includes('风控')) {
    return { hit: true, code: -352, reason: '接口返回 -352（风控）' }
  }
  if (String(code) === '-412' || text.includes('-412') || text.includes('请求被拦截')) {
    return { hit: true, code: -412, reason: '接口返回 -412（请求被拦截）' }
  }
  if (text.includes('验证码') || text.includes('captcha') || text.includes('风险验证')) {
    return { hit: true, code: 'captcha', reason: '出现验证码 / 风险验证' }
  }
  return { hit: false }
}
