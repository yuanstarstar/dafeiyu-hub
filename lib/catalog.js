/**
 * 大肥鱼能力目录。
 * kind: read | write | publish | money | destructive | task
 * default: allow | ask | deny
 * weight: 单次增加的厌倦值（0 表示不计厌倦）
 * group: 厌倦分组，也是总控台里的分类
 */
const R = (action, group, label, weight = 3, extra = {}) => ({
  id: `bili.${action}`,
  action,
  kind: 'read',
  group,
  label,
  default: 'allow',
  weight,
  bridge: true,
  ...extra,
})

const W = (action, group, label, weight = 12, extra = {}) => ({
  id: `bili.${action}`,
  action,
  kind: 'write',
  group,
  label,
  default: 'ask',
  weight,
  bridge: true,
  needsThread: true,
  ...extra,
})

export const CAPABILITIES = [
  R('whoami', '账号', '看登录身份', 0),
  R('search', '内容发现', '搜视频', 4),
  R('home_feed', '内容发现', '个性化首页推荐', 6),
  R('hot', '内容发现', '热门视频', 4),
  R('rank', '内容发现', '排行榜', 4),
  R('weekly', '内容发现', '每周必看', 4),
  R('video_info', '视频', '看视频信息', 2),
  R('video_comments', '视频', '看视频评论', 3),
  R('comment_state', '视频', '查评论可见性', 1),
  R('video_danmaku', '视频', '看视频弹幕', 3),
  R('video_subtitle', '视频', '看视频字幕', 2),
  R('user_info', '用户', '看用户资料', 2),
  R('user_videos', '用户', '看用户投稿', 3),
  R('user_dynamics', '用户', '看用户动态', 3),
  R('following', '用户', '看关注列表', 2),
  R('relation_status', '用户', '看与某人的关系', 1),
  R('favorites', '收藏', '看收藏夹', 2),
  R('favorite_content', '收藏', '看收藏内容', 3),
  R('live_room', '直播', '看直播间信息', 3),
  R('live_roam', '直播', '巡直播', 8),
  R('live_online', '直播', '看直播在线数据', 2),
  R('messages_unread', '消息', '看未读消息', 2),
  R('messages_sessions', '消息', '看私信会话', 3),
  R('messages_replies', '消息', '看收到的回复', 3),
  R('messages_at', '消息', '看 @ 我的', 3),

  W('comment_add', '互动', '发评论', 18, { limit: { perHour: 2, perDay: 20 } }),
  W('like', '互动', '点赞', 6, { limit: { perHour: 20, perDay: 200 } }),
  W('coin', '互动', '投币', 8, { limit: { perDay: 20 } }),
  W('favorite', '互动', '收藏', 6, { limit: { perHour: 10, perDay: 100 } }),
  W('triple', '互动', '一键三连', 20, { limit: { perDay: 10 } }),
  W('follow', '互动', '关注', 10, { limit: { perDay: 10 } }),
  W('danmaku_send', '互动', '发弹幕', 15, { limit: { perHour: 10, perDay: 60 } }),
  W('live_danmaku', '直播', '发直播弹幕', 15, { limit: { perHour: 20, perDay: 100 } }),
  W('dm_send', '消息', '发私信', 18, { limit: { perDay: 5 } }),
  {
    id: 'bili.video_publish', action: 'video_publish', kind: 'publish', group: '创作',
    label: '投稿视频', default: 'ask', weight: 25, bridge: false, needsThread: true,
    limit: { perDay: 2 },
  },

  { id: 'task.research', action: 'research', kind: 'task', group: '研究', label: '查资料 / 看内容', default: 'allow', weight: 6, bridge: false },
  { id: 'task.create', action: 'create', kind: 'task', group: '创作', label: '写稿 / 剪辑 / 做图', default: 'allow', weight: 12, bridge: false },
  { id: 'task.review', action: 'review', kind: 'task', group: '复盘', label: '整理 / 复盘', default: 'allow', weight: 6, bridge: false },
  { id: 'task.social', action: 'social', kind: 'task', group: '社交', label: '主动社交', default: 'allow', weight: 12, bridge: false },
  { id: 'task.explore', action: 'explore', kind: 'task', group: '闲逛', label: '巡场 / 闲逛', default: 'allow', weight: 8, bridge: false },
  { id: 'task.rest', action: 'rest', kind: 'task', group: '休息', label: '休息 / 发呆', default: 'allow', weight: 0, boring: false, bridge: false },
]

export const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((cap) => [cap.id, cap]))

const ALIASES = {
  recommend: 'home_feed',
  home: 'home_feed',
  feed: 'home_feed',
  rcmd: 'home_feed',
  comments: 'video_comments',
  danmaku: 'video_danmaku',
  subtitle: 'video_subtitle',
  user: 'user_info',
  live: 'live_room',
  unread: 'messages_unread',
  sessions: 'messages_sessions',
  dms: 'messages_sessions',
  replies: 'messages_replies',
  at: 'messages_at',
  dm: 'dm_send',
  comment: 'comment_add',
  publish: 'video_publish',
}

export function resolveCapability(input) {
  const name = String(input ?? '').trim()
  if (!name) return undefined
  if (CAPABILITY_BY_ID.has(name)) return CAPABILITY_BY_ID.get(name)
  if (name.startsWith('bili.') || name.startsWith('task.')) return undefined
  const action = ALIASES[name] ?? name
  return CAPABILITY_BY_ID.get(`bili.${action}`) ?? CAPABILITY_BY_ID.get(`task.${action}`)
}

export function bridgeCapabilities() {
  return CAPABILITIES.filter((cap) => cap.bridge)
}

export function taskCapabilities() {
  return CAPABILITIES.filter((cap) => cap.kind === 'task')
}

export function groupOf(cap) {
  return cap?.group ?? '其它'
}

export function describeCapability(cap) {
  return `${cap.label}（${cap.id}）`
}

export const READ_ACTIONS = new Set(CAPABILITIES.filter((cap) => cap.kind === 'read').map((cap) => cap.action))
