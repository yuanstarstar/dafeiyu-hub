// B站扫码登录：生成二维码（服务端画成 SVG，不把登录 URL 交给第三方）+ 轮询 + 落盘。
// 只做三件事：拿 qrcode_key、把 Set-Cookie 里的凭证写进统一 cookie 文件、用桥回读确认。
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './util.js'

const require = createRequire(import.meta.url)

let QR = null
try {
  // 用 browser 构建：只依赖 dijkstrajs，不拖 pngjs/yargs；输出 SVG 足够扫码。
  QR = require('../vendor/node_modules/qrcode/lib/browser.js')
} catch {
  QR = null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const DEFAULT_COOKIE = join(dshHome(), 'dafeiyu', 'secrets', 'bili_cookie.json')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  return { response, body }
}

export async function createLoginQr() {
  const { body } = await jsonFetch(GENERATE)
  const data = body?.data || {}
  if (!data.qrcode_key || !data.url) {
    throw new Error(`生成二维码失败：${body?.message || body?.code || '返回里没有 qrcode_key'}`)
  }
  if (!QR) throw new Error('二维码渲染组件缺失：vendor/node_modules/qrcode 不在包里')
  const svg = await QR.toString(data.url, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' })
  return {
    key: data.qrcode_key,
    url: data.url,
    svg,
    expiresIn: 180,
  }
}

function pickCookies(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const jar = {}
  for (const raw of list) {
    const first = String(raw || '').split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (!name || !value) continue
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4'].includes(name)) {
      jar[name] = value
    }
  }
  return jar
}

export async function pollLogin(key) {
  if (!key) throw new Error('缺 qrcode_key')
  const { response, body } = await jsonFetch(pollUrl(key))
  const code = body?.data?.code
  if (code === 86101) return { state: 'waiting', code, message: '还没扫' }
  if (code === 86090) return { state: 'scanned', code, message: '已扫码，等手机确认' }
  if (code === 86038) return { state: 'expired', code, message: '二维码过期了，重新生成一张' }
  if (code === 0) {
    const cookie = pickCookies(response)
    if (!cookie.SESSDATA || !cookie.bili_jct) {
      return { state: 'error', code, message: '登录成功但没拿到完整凭证（Set-Cookie 里缺 SESSDATA 或 bili_jct）' }
    }
    return { state: 'ok', code, message: '登录成功', cookie }
  }
  return { state: 'unknown', code, message: body?.message || body?.data?.message || '未知状态' }
}

export function cookieFile(config) {
  const raw = String(config?.bili?.cookieFile || '').trim()
  return raw || DEFAULT_COOKIE
}

export function saveCredential(cookie, config) {
  const target = cookieFile(config)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) {
    try { copyFileSync(target, `${target}.bak-${stamp()}`) } catch { /* 备份失败不挡住登录 */ }
  }
  const payload = {
    ...cookie,
    updated: new Date().toISOString(),
    note: '由大肥鱼总控台扫码登录写入；原文件已备份到同名 .bak-*',
  }
  writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  // dsh-bili-scroll 的 MCP 边车只认自己目录下的 bili_credential.json。
  // 同一次扫码顺手同步一份，避免“总控台登录了、刷视频却还是未登录”。
  const dutyDir = join(dshHome(), 'bili-duty')
  if (existsSync(dutyDir)) {
    const dutyFile = join(dutyDir, 'bili_credential.json')
    const duty = {
      sessdata: cookie.SESSDATA || '',
      bili_jct: cookie.bili_jct || '',
      buvid3: cookie.buvid3 || '',
      dedeuserid: cookie.DedeUserID || '',
    }
    try { writeFileSync(dutyFile, JSON.stringify(duty, null, 2) + '\n', 'utf8') } catch { /* 同步失败不影响主凭证 */ }
  }
  return target
}


