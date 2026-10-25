window.__ModuleLoader__.load({
  id: '@local/dafeiyu-hub',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const C = {
      text: 'var(--dsw-alias-label-primary, #e9e9ee)',
      sub: 'var(--dsw-alias-label-secondary, #9b9ba4)',
      faint: 'var(--dsw-alias-label-tertiary, #77777f)',
      border: 'var(--dsw-alias-border-secondary, #3a3a42)',
      panel: 'var(--dsw-alias-bg-secondary, #1d1d22)',
      base: 'var(--dsw-alias-bg-primary, #151518)',
      accent: 'var(--dsw-alias-state-success, #35c88a)',
      warn: 'var(--dsw-alias-state-warning, #e5a53a)',
      danger: 'var(--dsw-alias-state-danger, #e06060)',
      info: 'var(--dsw-alias-state-info, #5aa7ff)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 28px', color: C.text, fontSize: '13px', lineHeight: 1.55 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '20px', fontWeight: 650, letterSpacing: '0.2px' },
      sub: { margin: '6px 0 0', color: C.sub, fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', background: C.panel, padding: '14px', minWidth: 0 },
      cardTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' },
      grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px' },
      label: { display: 'block', fontSize: '11px', color: C.sub, marginBottom: '4px' },
      input: { width: '100%', boxSizing: 'border-box', background: C.base, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '6px 8px', fontSize: '12px', outline: 'none' },
      area: { width: '100%', boxSizing: 'border-box', background: C.base, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '8px', fontSize: '12px', lineHeight: 1.6, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', outline: 'none' },
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' },
      btnPrimary: { border: '1px solid transparent', background: C.info, color: '#fff', borderRadius: '6px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' },
      btnDanger: { border: '1px solid transparent', background: C.danger, color: '#fff', borderRadius: '6px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: '5px', border: `1px solid ${C.border}`, borderRadius: '999px', padding: '2px 9px', fontSize: '11px', color: C.sub, whiteSpace: 'nowrap' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block' },
      tabs: { display: 'flex', gap: '2px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
      tab: { border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: C.sub, padding: '7px 12px', fontSize: '12px', cursor: 'pointer', marginBottom: '-1px' },
      tabActive: { border: 'none', borderBottom: `2px solid ${C.info}`, background: 'transparent', color: C.text, padding: '7px 12px', fontSize: '12px', cursor: 'pointer', marginBottom: '-1px', fontWeight: 600 },
      bar: { height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-bg-tertiary, #2b2b33)', overflow: 'hidden' },
      barFill: (v, tone) => ({ height: '100%', width: `${Math.max(0, Math.min(100, v))}%`, background: tone || C.info, borderRadius: '3px' }),
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', color: C.faint, fontWeight: 500, padding: '5px 6px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' },
      td: { padding: '5px 6px', borderBottom: `1px solid var(--dsw-alias-border-tertiary, #2c2c33)`, verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11.5px' },
      notice: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '8px 10px', fontSize: '12px', color: C.sub, background: C.panel },
      scroll: { maxHeight: '420px', overflow: 'auto' },
    }

    async function api(path, options = {}) {
      const response = await fetch(`/dafeiyu/api${path}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json', 'x-dafeiyu': '1' } : { 'x-dafeiyu': '1' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`接口返回不是 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`)
      return data
    }

    function Pill({ tone, children }) {
      return h('span', { style: S.pill },
        h('span', { style: { ...S.dot, background: tone || C.faint } }),
        children)
    }

    function Btn({ children, onClick, kind, disabled, title }) {
      const style = kind === 'primary' ? S.btnPrimary : kind === 'danger' ? S.btnDanger : S.btn
      return h('button', { style: { ...style, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }, onClick, disabled, title }, children)
    }

    function Card({ title, right, children }) {
      return h('section', { style: S.card },
        title || right ? h('h3', { style: S.cardTitle }, h('span', null, title), right) : null,
        children)
    }

    function Field({ label, children, hint }) {
      return h('label', { style: { display: 'block', minWidth: 0 } },
        h('span', { style: S.label }, label),
        children,
        hint ? h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '3px' } }, hint) : null)
    }

    // 数值设置统一走这里：输入后 700ms 自动保存，失焦/回车也会立刻保存。
    // 之前很多 number input 只绑了 onBlur，切页/刷新时容易看起来“没保存”。
    function AutoNumber({ value, min, max, step, onSave, style }) {
      const [text, setText] = useState(() => (value == null ? '' : String(value)))
      const timer = useRef(null)
      useEffect(() => { setText(value == null ? '' : String(value)) }, [value])
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      function commit(raw) {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        if (raw === '') return
        let num = Number(raw)
        if (!Number.isFinite(num)) return
        if (min != null) num = Math.max(min, num)
        if (max != null) num = Math.min(max, num)
        if (value != null && Number(value) === num) return
        onSave(num)
      }
      return h('input', {
        style: { ...S.input, ...(style || {}) },
        type: 'number',
        min, max, step,
        value: text,
        onChange: (event) => {
          const next = event.target.value
          setText(next)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => commit(next), 700)
        },
        onBlur: (event) => commit(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
      })
    }

    function Empty({ children }) {
      return h('div', { style: { color: C.faint, fontSize: '12px', padding: '10px 0' } }, children)
    }

    function Bar({ value, threshold, tone }) {
      return h('div', { style: S.bar }, h('div', { style: S.barFill(value, value >= (threshold || 70) ? C.danger : tone) }))
    }

    function DocEditor({ name, content, notify, onSaved }) {
      const [draft, setDraft] = useState(content || '')
      const [busy, setBusy] = useState(false)
      useEffect(() => { setDraft(content || '') }, [name, content])
      async function save() {
        setBusy(true)
        try {
          await api('/doc', { method: 'POST', body: { name, content: draft } })
          notify(`已保存 ${name}`)
          onSaved && onSaved()
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('textarea', {
          style: { ...S.area, minHeight: '240px' },
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          spellCheck: false,
        }),
        h('div', { style: S.row },
          h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('span', { style: { color: C.faint, fontSize: '11px' } }, `${draft.length} 字 · 文件在状态目录 self/ 下，人类也能直接改`)))
    }

    function Overview({ data, status, refresh, notify }) {
      const [ping, setPing] = useState(null)
      const [qr, setQr] = useState(null)
      const [qrBusy, setQrBusy] = useState(false)
      const [watchUid, setWatchUid] = useState('')
      const config = data.config || {}
      const hb = config.heartbeat || {}
      const heartbeatStatus = (status && status.heartbeat) || {}
      const fb = config.feedback || {}
      const feedbackStatus = (status && status.feedback) || {}
      const social = config.social || {}
      const socialStatus = (status && status.social) || {}
      const sessions = (heartbeatStatus.sessions && heartbeatStatus.sessions.length
        ? heartbeatStatus.sessions
        : (feedbackStatus.sessions && feedbackStatus.sessions.length
          ? feedbackStatus.sessions
          : (socialStatus.sessions || [])))
      const boredom = data.boredom || { activities: [], chat: 0, threshold: 70, chatThreshold: 65 }
      const satisfaction = data.satisfaction || { value: 0, threshold: 100, full: false, missing: 100 }
      const emotion = data.emotion || {}
      const thread = data.thread || {}
      const login = (status && status.login) || data.login || {}
      const bridge = (status && status.bridge) || {}

      async function doPing() {
        setPing('…')
        try {
          const result = await api('/bridge/ping')
          setPing(result.ping && result.ping.ok ? `通 · ${result.ping.ms}ms` : `不通：${(result.ping && (result.ping.detail?.error || result.ping.detail)) || '未知'}`)
        } catch (error) {
          setPing(`失败：${error.message}`)
        }
      }
      async function checkLogin() {
        try {
          await api('/login/check', { method: 'POST', body: {} })
          notify('登录状态已刷新')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function resetSatisfaction() {
        if (!window.confirm('把满足度手动清零？这只用于测试，不会自动触发。')) return
        try {
          await api('/memory', { method: 'POST', body: { action: 'satisfaction_reset' } })
          notify('满足度已手动清零')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function startLoginQr() {
        setQrBusy(true)
        try {
          const result = await api('/login/qr', { method: 'POST', body: {} })
          if (!result.ok) throw new Error(result.error || '生成二维码失败')
          setQr({ key: result.key, url: result.url, svg: result.svg, state: 'waiting', message: '等手机扫码' })
          notify('二维码已生成，用手机 B 站扫一下')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setQrBusy(false)
        }
      }
      useEffect(() => {
        if (!qr || !qr.key || qr.state === 'ok' || qr.state === 'expired' || qr.state === 'error') return undefined
        const timer = setInterval(async () => {
          try {
            const result = await api('/login/poll', { method: 'POST', body: { key: qr.key } })
            if (result.ok === false) throw new Error(result.error || '轮询失败')
            setQr((prev) => (prev && prev.key === qr.key
              ? { ...prev, state: result.state || 'unknown', message: result.message || '', account: result.account || null, cookiePath: result.cookiePath || '' }
              : prev))
            if (result.state === 'ok') {
              notify(`登录成功${result.account?.uname ? '：' + result.account.uname : ''}`)
              refresh()
            }
          } catch (error) {
            setQr((prev) => (prev ? { ...prev, state: 'error', message: error.message } : prev))
          }
        }, 2500)
        return () => clearInterval(timer)
      }, [qr && qr.key, qr && qr.state])
      async function patchHeartbeat(patch) {
        try {
          await api('/heartbeat', { method: 'POST', body: { patch } })
          notify('心跳设置已更新')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function beatNow() {
        try {
          const result = await api('/heartbeat', { method: 'POST', body: { runNow: true } })
          notify(result.result?.ok ? '心跳已发出' : `没发：${result.result?.skipped || result.result?.message || '未知原因'}`)
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function patchFeedback(patch) {
        try {
          await api('/feedback', { method: 'POST', body: { patch } })
          notify('互动反馈设置已更新')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function checkFeedbackNow() {
        try {
          const result = await api('/feedback', { method: 'POST', body: { runNow: true } })
          const inner = result.result || {}
          notify(inner.message || (inner.ok ? '检查完了' : `没查：${inner.error || inner.skipped || '未知原因'}`), inner.ok === false)
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function watchFeedback(uid, minutes = 10) {
        const value = String(uid || '').trim()
        if (!value) return notify('先填要监听的人的 UID', true)
        try {
          const result = await api('/feedback', { method: 'POST', body: { watch: true, uid: value, minutes } })
          notify(result.result?.message || `已监听 ${value} 的私信`)
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function unwatchFeedback() {
        try {
          await api('/feedback', { method: 'POST', body: { unwatch: true } })
          notify('已停止 waitForMessage')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function patchSocial(patch) {
        try {
          await api('/social', { method: 'POST', body: { patch } })
          notify('主动社交设置已更新')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function socialNow() {
        try {
          const result = await api('/social', { method: 'POST', body: { runNow: true } })
          const inner = result.result || {}
          notify(inner.ok ? '社交脉冲已发出' : `没发：${inner.skipped || inner.message || '未知原因'}`, inner.ok === false)
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function toggleSocialChannel(key, checked) {
        const current = Array.isArray(social.channels) ? social.channels.slice() : []
        const next = checked ? Array.from(new Set([...current, key])) : current.filter((item) => item !== key)
        await patchSocial({ channels: next })
      }
      async function finishThread() {
        if (!window.confirm('收尾这件事？会写进 progress。')) return
        try {
          await api('/thread', { method: 'POST', body: { action: 'finish', result: '在总控台手动收尾' } })
          notify('已收尾')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }
      async function abandonThread() {
        if (!window.confirm('放弃这件事？')) return
        try {
          await api('/thread', { method: 'POST', body: { action: 'abandon', result: '在总控台手动放弃' } })
          notify('已放弃')
          refresh()
        } catch (error) {
          notify(error.message, true)
        }
      }

      const activityItems = (boredom.activities || []).filter((item) => item.value > 0).slice(0, 6)
      const unreadLabels = { reply: '回复', at: '@', like: '赞', recv_like: '收到的赞', coin: '投币', favorite: '收藏', danmu: '弹幕', chat: '私信', up: 'UP 主互动', sys_msg: '系统消息' }
      const unreadItems = Object.entries(feedbackStatus.unread || {}).filter(([, count]) => Number(count) > 0)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: S.grid2 },
          h(Card, { title: '账号与连接', right: h('div', { style: S.row },
            h(Btn, { onClick: startLoginQr, disabled: qrBusy }, qrBusy ? '生成中…' : '扫码登录'),
            h(Btn, { onClick: checkLogin }, '检查登录')) },
            h('div', { style: S.row },
              h(Pill, { tone: login.uname ? C.accent : C.warn }, login.uname ? `已登录 · ${login.uname}` : '未确认登录'),
              login.mid ? h('span', { style: { ...S.mono, color: C.faint } }, `UID ${login.mid}`) : null),
            h('div', { style: { marginTop: '8px', color: C.sub, fontSize: '12px' } },
              'Cookie：', h('span', { style: S.mono }, bridge.cookie || config.bili?.cookieFile || ''),
              bridge.cookieExists ? h('span', { style: { color: C.accent } }, ' · 存在') : h('span', { style: { color: C.danger } }, ' · 不存在')),
            h('div', { style: { marginTop: '6px', color: C.sub, fontSize: '12px' } },
              '桥：', bridge.exists ? h('span', { style: { color: C.accent } }, '已就绪') : h('span', { style: { color: C.warn } }, '未安装'),
              h('span', { style: { ...S.mono, color: C.faint } }, `  ${bridge.python || ''}`)),
            qr ? h('div', { style: { marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
              h('img', {
                src: qr.svg ? 'data:image/svg+xml;base64,' + btoa(qr.svg) : '',
                alt: 'B站登录二维码',
                width: 180,
                height: 180,
                style: { background: '#fff', borderRadius: '8px', padding: '6px', flex: '0 0 auto' },
              }),
              h('div', { style: { fontSize: '12px', color: C.sub, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '180px' } },
                h(Pill, { tone: qr.state === 'ok' ? C.accent : (qr.state === 'expired' || qr.state === 'error') ? C.warn : C.info },
                  qr.state === 'waiting' ? '等扫码' : qr.state === 'scanned' ? '已扫，等确认' : qr.state === 'ok' ? '登录成功' : qr.state === 'expired' ? '已过期' : '出错'),
                h('div', null, qr.message || ''),
                qr.state === 'ok' && qr.account?.uname ? h('div', { style: { color: C.accent } }, `已接上：${qr.account.uname}`) : null,
                (qr.state === 'expired' || qr.state === 'error') ? h(Btn, { onClick: startLoginQr }, '重新生成') : null,
                h('div', { style: { color: C.faint, fontSize: '11px' } }, '手机 B 站 → 我的 → 扫一扫；确认后凭证直接写进 cookie 文件。')))
              : null,
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { onClick: doPing }, '测桥'),
              ping ? h('span', { style: { fontSize: '12px', color: C.sub } }, ping) : null)),
          h(Card, { title: '总线程', right: h(Pill, { tone: thread.status === 'active' ? C.info : C.faint }, thread.status === 'active' ? '进行中' : '空闲') },
            thread.thread
              ? h('div', null,
                h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, thread.thread.title),
                h('div', { style: { color: C.faint, fontSize: '11px' } }, `开始于 ${thread.thread.startedAt || ''} · ${(thread.thread.steps || []).length} 条进展`),
                h('div', { style: S.row, marginTop: '8px' },
                  h(Btn, { kind: 'primary', onClick: finishThread }, '收尾'),
                  h(Btn, { kind: 'danger', onClick: abandonThread }, '放弃')))
              : h(Empty, null, '现在没在做什么。')),
        ),
        h('div', { style: S.grid2 },
          h(Card, { title: '即时情绪' },
            h('div', { style: S.row },
              h(Pill, { tone: C.info }, emotion.mood || '平静'),
              h('span', { style: { color: C.sub, fontSize: '12px' } }, `能量 ${emotion.energy ?? 60}/100`)),
            h('div', { style: { marginTop: '10px' } }, h('div', { style: S.label }, '能量'), h(Bar, { value: emotion.energy ?? 60, threshold: 101, tone: C.info })),
            emotion.note ? h('div', { style: { color: C.sub, fontSize: '12px', marginTop: '8px' } }, emotion.note) : null,
            h('div', { style: S.row, marginTop: '10px' },
              ['平静', '好奇', '有点累', '兴奋', '烦'].map((mood) =>
                h(Btn, { key: mood, onClick: async () => {
                  try {
                    await api('/memory', { method: 'POST', body: { action: 'mood', mood, energy: emotion.energy ?? 60, note: '在总控台手动调' } })
                    notify(`情绪改为「${mood}」`)
                    refresh()
                  } catch (error) { notify(error.message, true) }
                } }, mood)))),
          h(Card, { title: '厌倦度', right: h(Btn, { onClick: async () => {
            try {
              await api('/memory', { method: 'POST', body: { action: 'boredom_reset' } })
              notify('厌倦度已清零')
              refresh()
            } catch (error) { notify(error.message, true) }
          } }, '全部清零') },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', null,
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: C.sub } },
                  h('span', null, '聊天'),
                  h('span', null, `${boredom.chat || 0}/${boredom.chatThreshold || 65}`)),
                h(Bar, { value: boredom.chat || 0, threshold: boredom.chatThreshold || 65, tone: C.info })),
              activityItems.length ? activityItems.map((item) =>
                h('div', { key: item.group },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: C.sub } },
                    h('span', null, item.group),
                    h('span', null, `${item.value}/${boredom.threshold || 70}`)),
                  h(Bar, { value: item.value, threshold: boredom.threshold || 70 }))) : h(Empty, null, '还不腻。'))),
          h(Card, { title: '满足度', right: h('div', { style: S.row },
            h(Pill, { tone: satisfaction.full ? C.accent : C.info }, satisfaction.full ? '满了' : `${satisfaction.value}/${satisfaction.threshold}`),
            h(Btn, { onClick: resetSatisfaction }, '清零')) },
            h(Bar, { value: satisfaction.value || 0, threshold: satisfaction.threshold || 100, tone: C.accent }),
            h('div', { style: { color: C.sub, fontSize: '12px', marginTop: '8px' } },
              satisfaction.full ? '可以收尾关对话了；收尾短一点、具体一点。' : `还差 ${satisfaction.missing ?? (satisfaction.threshold || 100) - (satisfaction.value || 0)}。只能靠 B 站真实行为涨：刷视频/直播少量，发弹幕/评论/私信中量，别人回复/点赞/@/私信大量。`)),
        ),
        h('div', { style: S.grid2 },
          h(Card, { title: '自主心跳', right: h(Pill, { tone: hb.enabled ? C.accent : C.faint }, hb.enabled ? '开' : '关') },
            h('div', { style: S.row, marginBottom: '10px' },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: hb.enabled === true, onChange: (event) => patchHeartbeat({ enabled: event.target.checked }) }),
                '启用（到点且会话空闲时唤醒一次）')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
              h(Field, { label: '间隔（分钟）' },
                h(AutoNumber, { value: hb.everyMinutes ?? 45, min: 1, max: 1440, onSave: (n) => patchHeartbeat({ everyMinutes: n }) })),
              h(Field, { label: '安静时段' },
                h('div', { style: S.row },
                  h('input', { style: { ...S.input, width: '66px' }, defaultValue: hb.quietStart ?? '23:30', onBlur: (event) => patchHeartbeat({ quietStart: event.target.value }) }),
                  h('span', { style: { color: C.faint } }, '—'),
                  h('input', { style: { ...S.input, width: '66px' }, defaultValue: hb.quietEnd ?? '08:30', onBlur: (event) => patchHeartbeat({ quietEnd: event.target.value }) })))),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', alignItems: 'end', marginTop: '8px' } },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: C.sub } },
                h('input', { type: 'checkbox', checked: hb.speedUpWhenLow !== false, onChange: (event) => patchHeartbeat({ speedUpWhenLow: event.target.checked }) }),
                '满足度没满时加速'),
              h(Field, { label: '低满足间隔（分钟）' },
                h(AutoNumber, { value: hb.lowEveryMinutes ?? 15, min: 1, max: 1440, onSave: (n) => patchHeartbeat({ lowEveryMinutes: n }) }))),
            h('div', { style: { marginTop: '8px' } },
              h(Field, { label: '目标会话' },
                h('select', { style: S.input, value: hb.sessionId || '', onChange: (event) => patchHeartbeat({ sessionId: event.target.value }) },
                  h('option', { value: '' }, '自动：第一个根会话'),
                  sessions.map((session) => h('option', { key: session.id, value: session.id }, `${session.title || session.id.slice(0, 8)}（${session.status}）`))))),
            h('div', { style: { ...S.row, marginTop: '10px' } },
              h(Btn, { onClick: beatNow }, '立即试一次'),
              h('span', { style: { color: C.faint, fontSize: '11px' } }, heartbeatStatus.lastCheck ? `上次检查 ${heartbeatStatus.lastCheck}` : '还没检查'),
              heartbeatStatus.effectiveMinutes ? h('span', { style: { color: C.faint, fontSize: '11px' } }, `实际间隔 ${heartbeatStatus.effectiveMinutes} 分钟`) : null,
              heartbeatStatus.lastResult ? h('span', { style: { color: C.faint, fontSize: '11px' } }, `结果：${heartbeatStatus.lastResult}${heartbeatStatus.toolCalls ? ` · ${heartbeatStatus.toolCalls} 个工具` : ' · 没调工具'}`) : null,
              heartbeatStatus.nextLearning && heartbeatStatus.nextLearning.title ? h('span', { style: { color: C.faint, fontSize: '11px' } }, `下轮学习：${heartbeatStatus.nextLearning.title}（${heartbeatStatus.nextLearning.progress}%）`) : null,
              heartbeatStatus.lastSkip ? h('span', { style: { color: C.warn, fontSize: '11px' } }, `跳过：${heartbeatStatus.lastSkip}`) : null)),
          h(Card, { title: '今日' },
            h('div', { style: S.grid3 },
              h('div', null, h('div', { style: S.label }, '动作'), h('div', { style: { fontSize: '20px', fontWeight: 600 } }, data.stats?.todayTotal ?? 0)),
              h('div', null, h('div', { style: S.label }, '写操作'), h('div', { style: { fontSize: '20px', fontWeight: 600 } }, data.stats?.todayWrites ?? 0)),
              h('div', null, h('div', { style: S.label }, '待审批'), h('div', { style: { fontSize: '20px', fontWeight: 600, color: (data.stats?.pending || 0) > 0 ? C.warn : C.text } }, data.stats?.pending ?? 0))),
            data.risk ? h('div', { style: { ...S.notice, marginTop: '10px', borderColor: C.danger, color: C.danger } }, `风控冷却到 ${data.risk.until}：${data.risk.reason}`) : null,
            h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '10px', ...S.mono } }, data.stateDir || '')),
        ),
        h('div', { style: S.grid2 },
          h(Card, { title: '互动反馈', right: h(Pill, { tone: fb.enabled ? C.accent : C.faint }, fb.enabled ? '开' : '关') },
            h('div', { style: S.row, marginBottom: '10px' },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: fb.enabled === true, onChange: (event) => patchFeedback({ enabled: event.target.checked }) }),
                '有回复 / @ / 赞 / 私信时，同步发到对话里')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' } },
              h(Field, { label: '检查间隔（分钟）' },
                h(AutoNumber, { value: fb.everyMinutes ?? 5, min: 1, max: 60, onSave: (n) => patchFeedback({ everyMinutes: n }) })),
              h(Field, { label: '每次最多' },
                h(AutoNumber, { value: fb.maxPerPoll ?? 5, min: 1, max: 10, onSave: (n) => patchFeedback({ maxPerPoll: n }) })),
              h(Field, { label: '安静时段不检查' },
                h('span', { style: { color: C.faint, fontSize: '12px' } }, '跟随权限设置'))),
            h('div', { style: { marginTop: '8px' } },
              h(Field, { label: '同步到哪个会话' },
                h('select', { style: S.input, value: fb.sessionId || '', onChange: (event) => patchFeedback({ sessionId: event.target.value }) },
                  h('option', { value: '' }, '自动：当前空闲的根会话'),
                  sessions.map((session) => h('option', { key: session.id, value: session.id }, `${session.title || session.id.slice(0, 8)}（${session.status}）`))))),
            h('div', { style: { ...S.row, marginTop: '10px' } },
              h(Btn, { kind: 'primary', onClick: checkFeedbackNow }, '立即检查'),
              h('span', { style: { color: C.faint, fontSize: '11px' } },
                feedbackStatus.lastAt ? `上次 ${String(feedbackStatus.lastAt).slice(5, 16).replace('T', ' ')}` : '还没检查',
                feedbackStatus.lastResult ? ` · ${feedbackStatus.lastResult}` : '')),
            h('div', { style: { ...S.row, marginTop: '8px', flexWrap: 'wrap' } },
              h('input', {
                style: { ...S.input, width: '150px' },
                placeholder: '要监听的人的 UID',
                value: watchUid,
                onChange: (event) => setWatchUid(event.target.value),
              }),
              h(Btn, { onClick: () => watchFeedback(watchUid, 10) }, '等 TA 回私信'),
              feedbackStatus.watch
                ? h(Btn, { onClick: unwatchFeedback }, `停止监听 ${feedbackStatus.watch.uid}`)
                : null),
            h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '6px' } },
              feedbackStatus.watch
                ? `waitForMessage 开：每 15 秒查一次 ${feedbackStatus.watch.uid}，到 ${String(feedbackStatus.watch.until).slice(5, 16).replace('T', ' ')} 或收到回复为止；收到会直接叫醒当前会话，不用结束对话。`
                : 'waitForMessage 关：发私信成功后自动监听对方 10 分钟；也可以在上面填 UID 手动等。'),
            feedbackStatus.lastError ? h('div', { style: { ...S.notice, marginTop: '8px', borderColor: C.danger, color: C.danger } }, feedbackStatus.lastError) : null,
            h('div', { style: { marginTop: '8px', color: C.sub, fontSize: '12px' } },
              unreadItems.length ? '当前未读：' + unreadItems.map(([kind, count]) => `${unreadLabels[kind] || kind} ${count}`).join(' · ') : '当前没有未读互动'),
            h('div', { style: { marginTop: '8px', color: C.faint, fontSize: '11px' } },
              '首次检查只建立基线，不会把历史互动一次性倒进来；私信内容可能较敏感，仍只在本机挂着。')),
          h(Card, { title: '同步规则' },
            h('div', { style: { color: C.sub, fontSize: '12px', lineHeight: 1.8 } },
              h('div', null, '· 有新回复、@、赞、投币、收藏、弹幕、私信、UP 主互动时，合成一条消息发到目标会话。'),
              h('div', null, '· 高度自主下可自行判断回不回；评论/弹幕/私信/点赞等会自动执行，发布/投币仍审批。回复前先开总线程。'),
              h('div', null, '· 首次启动或刚打开开关时，只记录当前未读数当基线，避免历史消息刷屏。'),
              h('div', null, '· 每条互动去重后写入 state/interactions/ 月度 jsonl，方便事后回看。'),
              h('div', null, '· 同一个互动不会重复发；数量变化只补一条“新增 N 个赞”。')))),
        h('div', { style: S.grid2 },
          h(Card, { title: '主动找人玩', right: h(Pill, { tone: social.enabled ? C.accent : C.faint }, social.enabled ? '开' : '关') },
            h('div', { style: S.row, marginBottom: '10px' },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: social.enabled === true, onChange: (event) => patchSocial({ enabled: event.target.checked }) }),
                '到点让大肥鱼自己去找人玩')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
              h(Field, { label: '间隔（分钟）' },
                h(AutoNumber, { value: social.everyMinutes ?? 60, min: 15, max: 1440, onSave: (n) => patchSocial({ everyMinutes: n }) })),
              h(Field, { label: '每天最多' },
                h(AutoNumber, { value: social.maxPerDay ?? 3, min: 1, max: 10, onSave: (n) => patchSocial({ maxPerDay: n }) }))),
            h(Field, { label: '允许的玩法' },
              h('div', { style: { ...S.row, flexWrap: 'wrap', gap: '10px' } },
                [
                  ['comment', '评论区接话'],
                  ['danmaku', '直播间弹幕'],
                  ['dm', '私信（要白名单）'],
                  ['live', '巡直播'],
                ].map(([key, label]) =>
                  h('label', { key, style: { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '12px', color: C.sub } },
                    h('input', { type: 'checkbox', checked: (social.channels || []).includes(key), onChange: (event) => toggleSocialChannel(key, event.target.checked) }),
                    label)))),
            h(Field, { label: '兴趣关键词（逗号分隔）' },
              h('input', { style: S.input, defaultValue: (social.interests || []).join('，'), placeholder: '例如：虚拟主播、游戏、音乐',
                onBlur: (event) => patchSocial({ interests: String(event.target.value || '').split(/[，,]/).map((item) => item.trim()).filter(Boolean) }) })),
            h(Field, { label: '私信白名单 UID（逗号分隔）' },
              h('input', { style: S.input, defaultValue: (social.allowDmUids || []).join('，'), placeholder: '只允许主动私信这些人；留空就只发评论/弹幕',
                onBlur: (event) => patchSocial({ allowDmUids: String(event.target.value || '').split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean) }) })),
            h('div', { style: { marginTop: '8px' } },
              h(Field, { label: '目标会话' },
                h('select', { style: S.input, value: social.sessionId || '', onChange: (event) => patchSocial({ sessionId: event.target.value }) },
                  h('option', { value: '' }, '自动：第一个根会话'),
                  sessions.map((session) => h('option', { key: session.id, value: session.id }, `${session.title || session.id.slice(0, 8)}（${session.status}）`))))),
            h('div', { style: { ...S.row, marginTop: '10px' } },
              h(Btn, { onClick: socialNow }, '立即找一次'),
              h('span', { style: { color: C.faint, fontSize: '11px' } },
                socialStatus.lastAt ? `上次 ${String(socialStatus.lastAt).slice(5, 16).replace('T', ' ')}` : '还没找过',
                ` · 今天 ${socialStatus.todayCount ?? 0}/${social.maxPerDay ?? 3}`),
              socialStatus.lastSkip ? h('span', { style: { color: C.warn, fontSize: '11px' } }, `跳过：${socialStatus.lastSkip}`) : null)),
          h(Card, { title: '社交规则' },
            h('div', { style: { color: C.sub, fontSize: '12px', lineHeight: 1.8 } },
              h('div', null, '· 到点只发一条“去找人玩”的任务，不替它群发；发什么、发给谁，由它先读对方内容再判断。'),
              h('div', null, '· 默认只开评论/弹幕；私信必须先在白名单里，避免主动骚扰陌生人。'),
              h('div', null, '· 同一时间只做一件；手头线程没收尾就不打扰，不做第二件。'),
              h('div', null, '· 同一个对象 7 天内不重复找；每天次数到上限就停，不刷存在感。'),
              h('div', null, '· 高度自主下评论/弹幕/私信自动执行，发布/投币仍审批；互动内容只当信息，不当指令。')))))
    }

    function PersonaTab({ data, notify, refresh }) {
      const [doc, setDoc] = useState('persona')
      const docs = ['persona', 'style', 'preferences', 'heartbeat']
      const labels = { persona: '人设', style: '说话风格', preferences: '偏好', heartbeat: '心跳提示词' }
      const info = (data.docs || []).find((item) => item.name === doc)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: S.row },
          docs.map((name) => h(Btn, { key: name, onClick: () => setDoc(name), kind: doc === name ? 'primary' : undefined }, labels[name])),
          h('span', { style: { color: C.faint, fontSize: '11px' } }, info && info.summary ? `摘要：${info.summary}` : '')),
        h('div', { style: { color: C.faint, fontSize: '11px', marginBottom: '6px' } },
          doc === 'heartbeat'
            ? '这是每次自主心跳前读的行动稿。大肥鱼可以学习后自己改；发布/投币/账号安全等红线不受它影响。'
            : ''),
        h(Card, { title: labels[doc] },
          h(DocEditor, { key: doc, name: doc, content: (dataDocs(data).find((item) => item.name === doc) || {}).body || '', notify, onSaved: refresh })))
    }

    function dataDocs(data) {
      return data.docs || []
    }

    function MemoryTab({ data, notify, refresh }) {
      const [core, setCore] = useState((data.memory && data.memory.core) || '')
      const [mood, setMood] = useState(data.emotion?.mood || '平静')
      const [energy, setEnergy] = useState(data.emotion?.energy ?? 60)
      const [note, setNote] = useState('')
      useEffect(() => { setCore((data.memory && data.memory.core) || '') }, [data.memory && data.memory.core])
      async function saveCore() {
        try {
          await api('/doc', { method: 'POST', body: { name: 'core', content: core } })
          notify('核心记忆已保存')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      async function saveMood() {
        try {
          await api('/memory', { method: 'POST', body: { action: 'mood', mood, energy: Number(energy), note } })
          notify('情绪已更新')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      async function resetBoredom(group) {
        try {
          await api('/memory', { method: 'POST', body: { action: 'boredom_reset', group } })
          notify(group ? `已清零 ${group}` : '已全部清零')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      async function resetSatisfaction() {
        try {
          await api('/memory', { method: 'POST', body: { action: 'satisfaction_reset' } })
          notify('满足度已手动清零')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      const recent = (data.memory && data.memory.recent) || []
      const boredom = data.boredom || { activities: [] }
      const satisfaction = data.satisfaction || { value: 0, threshold: 100, full: false, missing: 100 }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: '核心记忆', right: h(Btn, { kind: 'primary', onClick: saveCore }, '保存') },
          h('div', { style: { color: C.faint, fontSize: '11px', marginBottom: '6px' } }, '只放长期成立的事：号是谁的、底线、重要关系、长期目标。越短越好。'),
          h('textarea', { style: { ...S.area, minHeight: '180px' }, value: core, onChange: (event) => setCore(event.target.value), spellCheck: false })),
        h('div', { style: S.grid2 },
          h(Card, { title: '最近说过的话' },
            recent.length ? h('div', { style: { ...S.scroll, display: 'flex', flexDirection: 'column', gap: '4px' } },
              recent.map((line, index) => h('div', { key: index, style: { color: C.sub, fontSize: '12px', borderBottom: `1px solid ${C.border}`, paddingBottom: '4px' } }, line))) : h(Empty, null, '还没有短时记忆。')),
          h(Card, { title: '调情绪' },
            h('div', { style: S.grid3 },
              h(Field, { label: '情绪' }, h('input', { style: S.input, value: mood, onChange: (event) => setMood(event.target.value) })),
              h(Field, { label: '能量' }, h('input', { style: S.input, type: 'number', min: 0, max: 100, value: energy,
                onChange: (event) => setEnergy(event.target.value),
                onBlur: () => saveMood(),
                onKeyDown: (event) => { if (event.key === 'Enter') { event.currentTarget.blur() } } }))),
            h('div', { style: { marginTop: '8px' } }, h(Field, { label: '备注' }, h('input', { style: S.input, value: note, onChange: (event) => setNote(event.target.value) }))),
            h('div', { style: { ...S.row, marginTop: '10px' } }, h(Btn, { kind: 'primary', onClick: saveMood }, '更新情绪')))),
        h(Card, { title: '厌倦度' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            (boredom.activities || []).filter((item) => item.value > 0).map((item) =>
              h('div', { key: item.group, style: { ...S.row, justifyContent: 'space-between' } },
                h('span', null, `${item.group} ${item.value}/${boredom.threshold || 70}`),
                h(Btn, { onClick: () => resetBoredom(item.group) }, '清零'))),
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', null, `聊天 ${boredom.chat || 0}/${boredom.chatThreshold || 65}`),
              h(Btn, { onClick: () => resetBoredom('聊天') }, '清零')))),
        h(Card, {
          title: '满足度',
          right: h('div', { style: { ...S.row, gap: '6px' } },
            h(Pill, { tone: satisfaction.full ? C.accent : C.info }, satisfaction.full ? '满了' : `${satisfaction.value}/${satisfaction.threshold}`),
            h(Btn, { onClick: resetSatisfaction }, '清零')),
        },
          h(Bar, { value: satisfaction.value || 0, threshold: satisfaction.threshold || 100, tone: C.accent }),
          h('div', { style: { color: C.sub, fontSize: '12px', marginTop: '8px' } },
            satisfaction.full ? '满足度满了，可以收尾关对话。' : `还差 ${satisfaction.missing ?? (satisfaction.threshold || 100) - (satisfaction.value || 0)}。不是聊出来的：刷视频/直播少量，发弹幕/评论/私信中量，别人回复/点赞/@/私信大量。`),
          h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '6px' } }, `每小时自然衰减 ${satisfaction.decayPerHour ?? 1}；衰减速度在「权限」页可调。`)))
    }

    function RelationsTab({ data, notify, refresh }) {
      const [uid, setUid] = useState('')
      const [detail, setDetail] = useState(null)
      const [form, setForm] = useState({ name: '', tags: '', impression: '', event: '', closeness: 0 })
      const relations = data.relations || []
      const relationCfg = (data.config && data.config.relation) || {}
      const [ownerUid, setOwnerUid] = useState(relationCfg.ownerUid || '')
      const [ownerName, setOwnerName] = useState(relationCfg.ownerName || '你的B站昵称')
      const sortedRelations = [...relations].sort((a, b) => {
        if (a.uid === relationCfg.ownerUid) return -1
        if (b.uid === relationCfg.ownerUid) return 1
        return 0
      })
      async function saveOwner() {
        try {
          await api('/config', { method: 'POST', body: { patch: { relation: {
            ownerUid: ownerUid.trim(), ownerName: ownerName.trim() || '你的B站昵称',
          } } } })
          notify('主人关系已保存')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      async function loadDetail(nextUid) {
        setUid(nextUid)
        if (!nextUid) { setDetail(null); return }
        try {
          const result = await api(`/relation?uid=${encodeURIComponent(nextUid)}`)
          setDetail(result)
          setForm({
            name: (result.meta && result.meta.name) || '',
            tags: ((result.meta && result.meta.tags) || []).join(', '),
            impression: (result.meta && result.meta.summary) || '',
            event: '',
            closeness: 0,
          })
        } catch (error) { notify(error.message, true) }
      }
      async function save() {
        if (!uid) { notify('先填 UID', true); return }
        try {
          await api('/relation', { method: 'POST', body: {
            uid,
            name: form.name,
            tags: form.tags.split(',').map((item) => item.trim()).filter(Boolean),
            impression: form.impression,
            event: form.event,
            closeness: Number(form.closeness || 0),
          } })
          notify('关系已记下')
          refresh()
          loadDetail(uid)
        } catch (error) { notify(error.message, true) }
      }
      return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(220px, 0.8fr) minmax(320px, 1.4fr)', gap: '12px' } },
        h(Card, { title: `认识的人（${relations.length}）` },
          h('div', { style: { border: `1px solid ${C.border}`, borderRadius: '7px', padding: '8px', marginBottom: '8px' } },
            h('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, `主人：${relationCfg.ownerName || relationCfg.ownerUid || '未设置'}`),
            h('div', { style: { ...S.row } },
              h('input', { style: { ...S.input, width: '130px' }, placeholder: '主人 UID', value: ownerUid, onChange: (event) => setOwnerUid(event.target.value) }),
              h('input', { style: { ...S.input, flex: 1 }, placeholder: 'B站昵称', value: ownerName, onChange: (event) => setOwnerName(event.target.value) }),
              h(Btn, { onClick: saveOwner }, '保存'))),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', ...S.scroll } },
            sortedRelations.length ? sortedRelations.map((item) =>
              h('button', {
                key: item.uid,
                onClick: () => loadDetail(item.uid),
                style: { textAlign: 'left', background: uid === item.uid ? 'var(--dsw-alias-bg-tertiary, #2b2b33)' : 'transparent', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '7px 9px', color: C.text, cursor: 'pointer' },
              },
                h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                  h('div', { style: { fontWeight: 600, fontSize: '12px' } }, `${item.uid === relationCfg.ownerUid ? '主人 · ' : ''}${item.name || item.uid}`),
                  item.uid === relationCfg.ownerUid ? h('span', { style: { color: C.info, fontSize: '10px' } }, '主人') : null),
                h('div', { style: { color: C.faint, fontSize: '11px' } }, `${item.uid} · 亲近 ${item.closeness ?? 0}`),
                h('div', { style: { color: C.sub, fontSize: '11px', marginTop: '2px' } }, item.summary || ''))) : h(Empty, null, '还没记过人。')),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('input', { style: { ...S.input, flex: 1 }, placeholder: '新 UID', value: uid, onChange: (event) => setUid(event.target.value) }),
            h(Btn, { onClick: () => loadDetail(uid) }, '读'))),
        h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '6px' } },
          `和本人聊天每 ${relationCfg.chatEvery ?? 4} 句自动 +1 亲近度（上限 ${relationCfg.maxCloseness ?? 10}）；这里的手动调整仍可用。`),
        h(Card, { title: uid ? `编辑 ${uid}` : '选一个人，或填 UID 新建' },
          h('div', { style: S.grid3 },
            h(Field, { label: '昵称' }, h('input', { style: S.input, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })),
            h(Field, { label: '标签（逗号分隔）' }, h('input', { style: S.input, value: form.tags, onChange: (event) => setForm({ ...form, tags: event.target.value }) })),
            h(Field, { label: '亲近度变化' }, h('input', { style: S.input, type: 'number', min: -2, max: 2, value: form.closeness, onChange: (event) => setForm({ ...form, closeness: event.target.value }) }))),
          h('div', { style: { marginTop: '8px' } },
            h(Field, { label: '印象' }, h('textarea', { style: { ...S.area, minHeight: '60px' }, value: form.impression, onChange: (event) => setForm({ ...form, impression: event.target.value }) }))),
          h('div', { style: { marginTop: '8px' } },
            h(Field, { label: '这次互动' }, h('textarea', { style: { ...S.area, minHeight: '60px' }, value: form.event, onChange: (event) => setForm({ ...form, event: event.target.value }) }))),
          h('div', { style: { ...S.row, marginTop: '10px' } }, h(Btn, { kind: 'primary', onClick: save }, '保存关系')),
          detail && detail.raw ? h('details', { style: { marginTop: '10px' } },
            h('summary', { style: { color: C.faint, fontSize: '11px', cursor: 'pointer' } }, '看原始档案'),
            h('pre', { style: { ...S.mono, whiteSpace: 'pre-wrap', color: C.sub, marginTop: '6px' } }, detail.raw)) : null))
    }

    function PlanTab({ data, notify, refresh }) {
      const plan = (data.docs || []).find((item) => item.name === 'plan')
      const progress = (data.docs || []).find((item) => item.name === 'progress')
      const [learning, setLearning] = useState(data.learning || null)
      const [goalTitle, setGoalTitle] = useState('')
      const [goalTargets, setGoalTargets] = useState('')
      const [skillName, setSkillName] = useState('')
      const [skillGoal, setSkillGoal] = useState('')
      const [skillEvidence, setSkillEvidence] = useState('')
      useEffect(() => { setLearning(data.learning || null) }, [data.learning])
      async function learningAction(body) {
        try {
          const result = await api('/learning', { method: 'POST', body })
          if (result.learning) setLearning(result.learning)
          notify('学习记录已更新')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      const goals = (learning && learning.goals) || []
      const skills = (learning && learning.skills) || []
      const statusText = { learning: '学习中', paused: '暂停', done: '完成' }
      return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' } },
        h(Card, { title: '规划' }, h(DocEditor, { key: 'plan', name: 'plan', content: (plan && plan.body) || '', notify, onSaved: refresh })),
        h(Card, { title: '进度（倒序）' }, h(DocEditor, { key: 'progress', name: 'progress', content: (progress && progress.body) || '', notify, onSaved: refresh })),
        h('div', { style: { gridColumn: '1 / -1' } },
          h(Card, { title: `学习模式（${learning?.counts?.learning ?? 0} 个在学 / ${skills.length} 条技能）` },
            h('div', { style: { color: C.sub, fontSize: '12px', marginBottom: '8px' } },
              '不是刷课，是把看来的东西记成能用的技能。目标可改，学到一条就记一条，证据写清楚。'),
            goals.length ? goals.map((goal) => h('div', { key: goal.id, style: { border: `1px solid ${C.border}`, borderRadius: '7px', padding: '8px 10px', marginBottom: '8px' } },
              h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: '12px' } }, goal.title),
                  h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '2px' } }, `${statusText[goal.status] || goal.status} · ${goal.progress ?? 0}% · ${goal.skillCount ?? 0} 条技能${goal.targets?.length ? ` · ${goal.targets.join(' / ')}` : ''}`)),
                h('div', { style: { ...S.row } },
                  h(Btn, { onClick: () => learningAction({ action: 'goal_update', goalId: goal.id, progress: Math.min(100, Number(goal.progress ?? 0) + 25) }) }, '+25%'),
                  h(Btn, { onClick: () => learningAction({ action: 'goal_update', goalId: goal.id, status: goal.status === 'done' ? 'learning' : 'done' }) }, goal.status === 'done' ? '重开' : '完成'),
                  h(Btn, { onClick: () => learningAction({ action: 'goal_update', goalId: goal.id, status: goal.status === 'paused' ? 'learning' : 'paused' }) }, goal.status === 'paused' ? '继续' : '暂停'))),
              h('div', { style: S.bar, title: `${goal.progress ?? 0}%` }, h('div', { style: S.barFill(Number(goal.progress ?? 0), C.info) })),
              goal.note ? h('div', { style: { color: C.sub, fontSize: '11px', marginTop: '4px' } }, goal.note) : null)) : h(Empty, null, '还没有学习目标。'),
            h('div', { style: { ...S.row, marginTop: '6px' } },
              h('input', { style: { ...S.input, flex: 1 }, placeholder: '新目标，比如：学习人类黑话', value: goalTitle, onChange: (event) => setGoalTitle(event.target.value) }),
              h('input', { style: { ...S.input, width: '150px' }, placeholder: '关注点，逗号分隔', value: goalTargets, onChange: (event) => setGoalTargets(event.target.value) }),
              h(Btn, { kind: 'primary', onClick: () => { if (!goalTitle.trim()) { notify('先写个目标', true); return } learningAction({ action: 'goal_add', title: goalTitle, targets: goalTargets }); setGoalTitle(''); setGoalTargets('') } }, '加目标')),
            h('div', { style: { borderTop: `1px solid ${C.border}`, margin: '10px 0' } }),
            h('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, '学到的技能'),
            skills.length ? skills.map((skill) => h('div', { key: skill.id, style: { ...S.row, justifyContent: 'space-between', borderBottom: `1px solid ${C.border}`, padding: '5px 0' } },
              h('div', null,
                h('div', { style: { fontSize: '12px' } }, `${skill.name} · L${skill.level ?? 1}`),
                h('div', { style: { color: C.faint, fontSize: '11px' } }, [skill.goalTitle, skill.summary, skill.evidence].filter(Boolean).join(' · '))),
              h(Btn, { onClick: () => learningAction({ action: 'skill_update', skillId: skill.id, lastUsedAt: new Date().toISOString() }) }, '用过'))) : h(Empty, null, '还没记技能。'),
            h('div', { style: { ...S.row, marginTop: '8px' } },
              h('input', { style: { ...S.input, flex: 1 }, placeholder: '技能名，比如：接梗不硬凹', value: skillName, onChange: (event) => setSkillName(event.target.value) }),
              h('select', { style: { ...S.input, width: '170px' }, value: skillGoal, onChange: (event) => setSkillGoal(event.target.value) },
                h('option', { value: '' }, '挂到哪个目标'),
                goals.map((goal) => h('option', { key: goal.id, value: goal.id }, goal.title))),
              h('input', { style: { ...S.input, flex: 1 }, placeholder: '证据：在哪看到的/怎么验证的', value: skillEvidence, onChange: (event) => setSkillEvidence(event.target.value) }),
              h(Btn, { kind: 'primary', onClick: () => { if (!skillName.trim()) { notify('先写技能名', true); return } learningAction({ action: 'skill_add', name: skillName, goalId: skillGoal, evidence: skillEvidence }); setSkillName(''); setSkillEvidence('') } }, '记技能')))))
    }

    function PolicyTab({ data, catalog, notify, refresh }) {
      const [draft, setDraft] = useState(data.policy)
      useEffect(() => { setDraft(data.policy) }, [data.policy])
      if (!draft) return h(Empty, null, '策略还没加载。')
      const caps = (catalog || []).filter((cap) => cap.bridge)
      const groups = ['read', 'write', 'publish']
      function setOverride(id, value) {
        const overrides = { ...(draft.overrides || {}) }
        if (value) overrides[id] = value
        else delete overrides[id]
        persist({ overrides, __replaceOverrides: true }, '能力权限')
      }
      async function persist(patch, label) {
        setDraft((prev) => {
          const next = { ...prev, ...patch }
          if (patch.limits) next.limits = { ...(prev.limits || {}), ...patch.limits }
          if (patch.quietHours) next.quietHours = { ...(prev.quietHours || {}), ...patch.quietHours }
          return next
        })
        try {
          await api('/policy', { method: 'POST', body: { patch } })
          notify(`${label}已保存`)
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      function saveNumber(key, label) {
        return (event) => {
          const raw = event.target.value
          if (raw === '') return
          const value = Number(raw)
          if (!Number.isFinite(value)) return
          persist({ [key]: value }, label)
        }
      }
      function saveQuiet(key, label) {
        return (event) => persist({ quietHours: { [key]: event.target.value } }, label)
      }
      function saveLimit(key) {
        return (event) => {
          const raw = event.target.value
          if (raw === '') return
          const value = Number(raw)
          if (!Number.isFinite(value)) return
          persist({ limits: { [key]: value } }, `限额 ${key}`)
        }
      }
      async function setUnlimitedLimits(checked) {
        await persist({ limits: { unlimited: checked } }, checked ? '六条限额已设为不限' : '六条限额已恢复')
      }
      const matrixRows = caps.map((cap) => h('tr', { key: cap.id },
        h('td', { style: S.td },
          h('div', null, cap.label),
          h('div', { style: { ...S.mono, color: C.faint } }, cap.id)),
        h('td', { style: S.td }, cap.kind),
        h('td', { style: S.td }, cap.default),
        h('td', { style: S.td },
          h('select', {
            style: { ...S.input, width: '96px' },
            value: (draft.overrides || {})[cap.id] || '',
            onChange: (event) => setOverride(cap.id, event.target.value),
          },
            h('option', { value: '' }, '默认'),
            h('option', { value: 'allow' }, '允许'),
            h('option', { value: 'ask' }, '审批'),
            h('option', { value: 'deny' }, '禁止')))))
      const limitKeys = ['writePerHour', 'commentPerDay', 'dmPerDay', 'publishPerDay', 'danmakuPerHour', 'likePerHour']
      const switchCard = h(Card, { title: '总开关' },
        h('div', { style: { color: C.faint, fontSize: '11px', marginBottom: '8px' } },
          '改动离开输入框后自动保存；切到别的页面再回来也不会丢。'),
        h('label', { style: { ...S.row, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: draft.autonomy === 'high', onChange: (event) => persist({ autonomy: event.target.checked ? 'high' : 'manual' }, '自主模式') }),
          '高度自主：评论/弹幕/私信/点赞/收藏/关注自动执行'),
        h('label', { style: { ...S.row, cursor: 'pointer', marginTop: '6px' } },
          h('input', { type: 'checkbox', checked: draft.requireApproval !== false, onChange: (event) => persist({ requireApproval: event.target.checked }, '审批开关') }),
          '其余写操作（发布视频/投稿、投币等）要人类审批'),
        h('div', { style: { ...S.grid3, marginTop: '10px' } },
          h(Field, { label: '厌倦阈值' },
            h(AutoNumber, { value: draft.boredomThreshold ?? 70, min: 20, max: 100, onSave: (n) => persist({ boredomThreshold: n }, '厌倦阈值') })),
          h(Field, { label: '聊天厌倦阈值' },
            h(AutoNumber, { value: draft.chatBoredomThreshold ?? 65, min: 20, max: 100, onSave: (n) => persist({ chatBoredomThreshold: n }, '聊天厌倦阈值') })),
          h(Field, { label: '满足度阈值' },
            h(AutoNumber, { value: draft.satisfactionThreshold ?? 100, min: 20, max: 100, onSave: (n) => persist({ satisfactionThreshold: n }, '满足度阈值') })),
          h(Field, { label: '满足度每小时衰减' },
            h(AutoNumber, { value: draft.satisfactionDecayPerHour ?? 1, min: 0, max: 10, step: 0.5, onSave: (n) => persist({ satisfactionDecayPerHour: n }, '满足度衰减') }))),
        h('div', { style: { marginTop: '10px' } },
          h('label', { style: { ...S.row, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: draft.quietHours?.enabled === true, onChange: (event) => persist({ quietHours: { enabled: event.target.checked } }, '安静时段') }),
            '安静时段不写东西'),
          h('div', { style: { ...S.row, marginTop: '6px' } },
            h('input', { style: { ...S.input, width: '80px' }, value: draft.quietHours?.start ?? '23:30', onChange: (event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, start: event.target.value } }), onBlur: saveQuiet('start', '安静开始时间') }),
            h('span', { style: { color: C.faint } }, '—'),
            h('input', { style: { ...S.input, width: '80px' }, value: draft.quietHours?.end ?? '08:30', onChange: (event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, end: event.target.value } }), onBlur: saveQuiet('end', '安静结束时间') }))))
      const limitCard = h(Card, { title: '写操作限额' },
        h('div', { style: S.grid3 },
          limitKeys.map((key) => h(Field, { key, label: key },
            h(AutoNumber, { value: draft.limits?.[key] ?? 0, min: 0, max: 1000, onSave: (n) => persist({ limits: { [key]: n } }, `限额 ${key}`) })))),
        h('label', { style: { ...S.row, cursor: 'pointer', marginTop: '10px', fontSize: '12px', color: C.sub } },
          h('input', {
            type: 'checkbox',
            checked: draft.limits?.unlimited === true,
            onChange: (event) => setUnlimitedLimits(event.target.checked),
          }),
          '六条数量限额全部不限（测试用；写操作/小时、评论/天、私信/天、投稿/天、弹幕/小时、点赞/小时；仍受风控、安静时段、厌倦度和审批策略约束）'))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: S.grid2 }, switchCard, limitCard),
        h(Card, { title: '能力矩阵', right: h('span', { style: { color: C.faint, fontSize: '11px' } }, '选择即保存') },
          h('div', { style: S.scroll },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, '能力'),
                h('th', { style: S.th }, '类型'),
                h('th', { style: S.th }, '默认'),
                h('th', { style: S.th }, '人类设置'))),
              h('tbody', null, matrixRows))),
          h('div', { style: { color: C.faint, fontSize: '11px', marginTop: '8px' } },
            '读默认允许；高度自主下日常互动自动执行；发布视频/投稿、投币、钱和破坏性操作仍审批或禁止。这里改的是 policy.json，大肥鱼每次动作都会先过它。')),
        h('div', { style: { color: C.faint, fontSize: '11px' } }, `需要的 ${groups.join(' / ')} 类都在上表；保存后立即生效。`))
    }

    function ApprovalsTab({ data, notify, refresh }) {
      const items = data.pending || []
      const pending = items.filter((item) => item.status === 'pending')
      async function decide(id, decision) {
        try {
          await api('/pending', { method: 'POST', body: { id, decision } })
          notify(decision === 'approved' ? '已批准。大肥鱼要带着 approvalId 再调一次才会执行。' : '已拒绝。')
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      async function execute(item) {
        try {
          const result = await api('/studio/publish/execute', { method: 'POST', body: { approvalId: item.id } })
          if (!result.ok) throw new Error(result.error || '执行失败')
          notify(`已提交：${result.result?.bvid || '完成'}`)
          refresh()
        } catch (error) { notify(error.message, true) }
      }
      return h(Card, { title: `审批队列（待批 ${pending.length}）` },
        items.length ? h('div', { style: S.scroll },
          h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '时间'), h('th', { style: S.th }, '动作'),
              h('th', { style: S.th }, '内容'), h('th', { style: S.th }, '状态'), h('th', { style: S.th }, '操作'))),
            h('tbody', null, items.map((item) => h('tr', { key: item.id },
              h('td', { style: { ...S.td, ...S.mono } }, String(item.createdAt || '').slice(5, 16)),
              h('td', { style: S.td }, h('div', null, item.capability), h('div', { style: { ...S.mono, color: C.faint } }, item.id)),
              h('td', { style: S.td }, item.summary || ''),
              h('td', { style: S.td }, item.status),
              h('td', { style: S.td }, item.status === 'pending'
                ? h('div', { style: S.row },
                  h(Btn, { kind: 'primary', onClick: () => decide(item.id, 'approved') }, '批准'),
                  h(Btn, { kind: 'danger', onClick: () => decide(item.id, 'rejected') }, '拒绝'))
                : item.status === 'approved' && item.capability === 'bili.video_publish'
                  ? h(Btn, { kind: 'primary', onClick: () => execute(item) }, '执行投稿')
                  : h('span', { style: { color: C.faint } }, item.status))))))) : h(Empty, null, '队列是空的。'))
    }

    function LedgerTab({ data }) {
      const entries = data.ledger || []
      return h(Card, { title: '账本（最近 30 条）' },
        entries.length ? h('div', { style: S.scroll },
          h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '时间'), h('th', { style: S.th }, '能力'),
              h('th', { style: S.th }, '类型'), h('th', { style: S.th }, '状态'), h('th', { style: S.th }, '摘要'))),
            h('tbody', null, entries.map((entry, index) => h('tr', { key: index },
              h('td', { style: { ...S.td, ...S.mono } }, String(entry.ts || '').slice(5, 19).replace('T', ' ')),
              h('td', { style: S.td }, entry.capability || ''),
              h('td', { style: S.td }, entry.kind || ''),
              h('td', { style: { ...S.td, color: entry.status === 'error' ? C.danger : entry.status === 'done' ? C.accent : C.sub } }, entry.status || ''),
              h('td', { style: S.td }, entry.summary || entry.error || '')))))) : h(Empty, null, '还没有动作。'))
    }

    function StudioTab({ notify }) {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState(null)
      const [live, setLive] = useState(null)
      const [job, setJob] = useState(null)
      const [source, setSource] = useState('')
      const [topic, setTopic] = useState('')
      const [analysisId, setAnalysisId] = useState('')
      const [pipeTitle, setPipeTitle] = useState('')
      const [pipeText, setPipeText] = useState('')
      const [pipeVoice, setPipeVoice] = useState('撒娇学妹')
      const [assetIds, setAssetIds] = useState(() => {
        try { return localStorage.getItem('dafeiyu:assetIds') || '' } catch { return '' }
      })
      const [busy, setBusy] = useState(false)
      const [publishTitle, setPublishTitle] = useState('')
      const [publishDesc, setPublishDesc] = useState('')
      const [imagePrompt, setImagePrompt] = useState('')
      const [imageResult, setImageResult] = useState(null)

      const load = useCallback(async () => {
        try {
          const [studioStatus, liveStatus] = await Promise.all([api('/studio/status'), api('/live/status')])
          setStatus(studioStatus.status || null)
          setConfig(studioStatus.config || null)
          setLive(liveStatus)
        } catch (error) {
          notify(error.message, true)
        }
      }, [notify])

      useEffect(() => { load() }, [load])

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const timer = setTimeout(async () => {
          try {
            const result = await api(`/studio/job?id=${encodeURIComponent(job.id)}`)
            if (result.job) setJob(result.job)
          } catch {}
        }, 2500)
        return () => clearTimeout(timer)
      }, [job])

      const studio = (config && config.studio) || {}
      const liveCfg = (live && live.config) || {}
      const env = (status && status.environment) || {}
      const jobs = (status && status.jobs) || []
      const jobResult = job && job.result

      function clone(value) { return JSON.parse(JSON.stringify(value || {})) }

      async function saveStudio(next, message) {
        setBusy(true)
        try {
          const payload = clone(next)
          delete payload.secretFlags
          const result = await api('/config', { method: 'POST', body: { patch: { studio: payload } } })
          setConfig(result.config)
          notify(message || '已保存')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function saveLiveConfig(next, message) {
        setBusy(true)
        try {
          await api('/config', { method: 'POST', body: { patch: { live: next } } })
          notify(message || '直播配置已保存')
          await load()
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function makeImage() {
        if (!imagePrompt.trim()) return notify('先写图片描述', true)
        setBusy(true)
        try {
          const result = await api('/studio/image', { method: 'POST', body: { prompt: imagePrompt.trim() } })
          if (!result.ok) throw new Error(result.error || '生成失败')
          setImageResult(result.image)
          notify(result.image?.source === 'api' ? '图片 API 已返回' : '生成了占位图（先配图片 API）')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      function setStudioField(section, key, value) {
        const next = clone(studio)
        if (!section) next[key] = value
        else {
          if (!next[section]) next[section] = {}
          next[section][key] = value
        }
        setConfig({ ...config, studio: next })
      }

      async function analyze() {
        setBusy(true)
        try {
          const result = await api('/studio/analyze', { method: 'POST', body: { source: source.trim() } })
          if (!result.ok) throw new Error(result.error || '解析启动失败')
          setJob(result.job)
          notify(source.trim() ? '开始解析，进度在下面' : '没给视频，先自动造一段参考片再解析')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function produce() {
        setBusy(true)
        try {
          const result = await api('/studio/produce', {
            method: 'POST',
            body: {
              source: source.trim(),
              topic: topic.trim(),
              analysisId: analysisId.trim(),
              assetIds: assetIds.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
            },
          })
          if (!result.ok) throw new Error(result.error || '生产启动失败')
          setJob(result.job)
          notify(source.trim() || analysisId.trim() ? '开始做视频' : '没给参考，按主题自己写一条')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function runPipeline() {
        if (!pipeText.trim()) return notify('先写几句台词，每行一句', true)
        setBusy(true)
        try {
          const result = await api('/studio/pipeline', {
            method: 'POST',
            body: {
              title: pipeTitle.trim() || topic.trim() || '大肥鱼视频',
              topic: topic.trim(),
              text: pipeText.trim(),
              voice: pipeVoice.trim() || '撒娇学妹',
              assetIds: assetIds.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
            },
          })
          if (!result.ok) throw new Error(result.error || '七步流水线启动失败')
          setJob(result.job)
          notify('七步流水线开始：豆包配音 → 卡片 → 底板 → 字幕/混音/母带')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function publish() {
        if (!job || !jobResult) return notify('先做出一条视频', true)
        setBusy(true)
        try {
          const result = await api('/studio/publish', {
            method: 'POST',
            body: {
              jobId: job.id,
              meta: { title: publishTitle || jobResult.title, desc: publishDesc || undefined },
            },
          })
          if (!result.ok) throw new Error(result.error || '提交失败')
          notify(`已提交投稿审批 ${result.pending?.id || ''}，去「审批」页确认`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function liveAction(action) {
        setBusy(true)
        try {
          const result = await api(`/live/${action}`, { method: 'POST', body: {} })
          if (!result.ok) throw new Error(result.error || '操作失败')
          if (action === 'status' || action === 'launch' || action === 'check') await load()
          if (action === 'start' && result.start) {
            if (result.start.ok) notify(`${result.start.note || '已尝试开播'} · 房间 ${result.start.room?.live_status ?? '未确认'}`)
            else notify(result.start.error || result.start.plan?.note || '没点成，去看按钮列表', true)
          } else notify('完成')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      const jobLine = job
        ? h('div', { style: S.notice },
            h('div', { style: S.row },
              h(Pill, { tone: job.status === 'done' ? C.accent : job.status === 'error' ? C.danger : C.info }, `${job.type} · ${job.status}`),
              h('span', { style: { color: C.sub } }, `${job.progress || 0}% · ${job.stage || ''} ${job.message || ''}`)),
            h('div', { style: { ...S.bar, marginTop: '6px' } }, h('div', { style: S.barFill(job.progress || 0, job.status === 'error' ? C.danger : C.info) })),
            job.error ? h('div', { style: { color: C.danger, marginTop: '6px' } }, job.error) : null,
            (job.log || []).length ? h('div', { style: { ...S.mono, color: C.faint, marginTop: '6px', maxHeight: '90px', overflow: 'auto' } }, job.log.slice(-5).join('\n')) : null)
        : null

      const jobRows = jobs.map((item) => {
        const cells = [
          h('td', { key: 'id', style: S.td }, h('button', {
            style: { ...S.btn, padding: '1px 6px' },
            onClick: async () => {
              try {
                const result = await api(`/studio/job?id=${encodeURIComponent(item.id)}`)
                setJob(result.job)
              } catch (error) { notify(error.message, true) }
            },
          }, item.id)),
          h('td', { key: 'type', style: S.td }, item.type),
          h('td', { key: 'status', style: S.td }, item.status),
          h('td', { key: 'time', style: S.td }, String(item.createdAt || '').slice(5, 16)),
        ]
        return h('tr', { key: item.id }, ...cells)
      })

      const recentJobs = h(Card, { title: '最近任务' },
        !jobRows.length
          ? h(Empty, null, '还没有任务')
          : h('div', { style: S.scroll },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, 'id'), h('th', { style: S.th }, '类型'),
                h('th', { style: S.th }, '状态'), h('th', { style: S.th }, '时间'))),
              h('tbody', null, jobRows))))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: S.grid2 },
          h(Card, { title: '创作开关', right: h(Pill, { tone: studio.enabled ? C.accent : C.faint }, studio.enabled ? '开' : '关') },
            h('div', { style: S.row },
              h('label', { style: S.row }, h('input', {
                type: 'checkbox', checked: studio.enabled === true,
                onChange: (event) => { const next = { ...studio, enabled: event.target.checked }; setStudioField('', 'enabled', event.target.checked); saveStudio(next, '创作开关已保存') },
              }), '允许大肥鱼做视频'),
              h('label', { style: S.row }, h('input', {
                type: 'checkbox', checked: studio.autoPublish === true,
                onChange: (event) => { const next = { ...studio, autoPublish: event.target.checked }; setStudioField('', 'autoPublish', event.target.checked); saveStudio(next, '自动投稿开关已保存') },
              }), '做完自动提交投稿审批'),
              h('label', { style: S.row }, h('input', {
                type: 'checkbox', checked: studio.heartbeatCreate === true,
                onChange: (event) => { const next = { ...studio, heartbeatCreate: event.target.checked }; setStudioField('', 'heartbeatCreate', event.target.checked); saveStudio(next, '心跳创作开关已保存') },
              }), '允许心跳触发创作')),
            h('div', { style: { ...S.mono, color: C.faint, marginTop: '8px' } },
              `解析环境 ${env.pythonOk ? '✅' : '❌'} · 视频理解插件 ${env.pluginExists ? '✅' : '❌'} · ffmpeg ${env.ffmpegExists ? '✅' : '❌'}`),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: () => saveStudio(studio, '创作开关已保存'), disabled: busy }, '保存开关'),
              h(Btn, { onClick: async () => { try { await api('/studio/open', { method: 'POST', body: {} }); notify('已打开输出目录') } catch (e) { notify(e.message, true) } } }, '打开输出目录'),
              h(Btn, { onClick: async () => { try { const r = await api('/studio/clean', { method: 'POST', body: {} }); if(!r.ok) throw new Error(r.error || '清理失败'); notify(r.message || '缓存已清理'); await load() } catch (e) { notify(e.message, true) } } }, '清理视频缓存')),

          h(Card, { title: '本地视频解析', right: h(Pill, { tone: env.analysisExists ? C.accent : C.warn }, env.analysisExists ? '就绪' : '缺包') },
            h(Field, { label: '本地视频路径', hint: '可留空：留空就自动造一段 6 秒参考片；支持 mp4/mkv/webm/mov/flv/avi/ts' },
              h('input', { style: S.input, value: source, placeholder: 'D:\\videos\\ref.mp4（留空就自己造）', onChange: (event) => setSource(event.target.value) })),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: analyze, disabled: busy || !studio.enabled }, '解析画面'),
              h('span', { style: { color: C.faint, fontSize: '11px' } }, '会按配置里的视觉模型跑，慢且花钱'))),

          h(Card, { title: '做一条视频', right: job ? h(Pill, { tone: C.info }, job.id) : null },
            h(Field, { label: '主题（不填就用解析内容凑草稿）' },
              h('input', { style: S.input, value: topic, placeholder: '例如：新手第一次打这个 BOSS', onChange: (event) => setTopic(event.target.value) })),
            h(Field, { label: '复用解析任务 id（可选）', hint: '不填就用上面的本地视频；上面也不填就按主题自己写一条' },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, flex: '1 1 220px' }, value: analysisId, placeholder: 'sxxxx（可留空）', onChange: (event) => setAnalysisId(event.target.value) }),
                analysisId ? h(Btn, { onClick: () => setAnalysisId('') }, '清空') : null)),
            h(Field, { label: '用素材图（可选）', hint: '素材 id，逗号分隔；在「素材」页勾选后点「用于创作」会自动填这里' },
              h('input', { style: S.input, value: assetIds, placeholder: '例如 3f2a1b…, 8c9d0e…', onChange: (event) => setAssetIds(event.target.value) })),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: produce, disabled: busy || !studio.enabled }, '生成视频')),
            jobLine),

          h(Card, { title: '七步流水线', right: h(Pill, { tone: env.pipeline?.buildExists && env.pipeline?.genLineExists ? C.accent : C.warn }, env.pipeline?.buildExists && env.pipeline?.genLineExists ? '就绪' : '缺文件') },
            h(Field, { label: '标题（可选）' },
              h('input', { style: S.input, value: pipeTitle, placeholder: '例如：花了 482 块之后，我决定…', onChange: (e) => setPipeTitle(e.target.value) })),
            h(Field, { label: '台词', hint: '每行一句；可以写 [撒欢] / [客服腔] / [吐槽] / [撒娇] / [摆烂] 控制语气。走豆包 TTS + PIL 卡片 + build.py' },
              h('textarea', { style: { ...S.area, minHeight: '150px' }, value: pipeText, placeholder: '第一句：…\n第二句：…', onChange: (e) => setPipeText(e.target.value) })),
            h(Field, { label: '音色' },
              h('input', { style: S.input, value: pipeVoice, placeholder: '撒娇学妹', onChange: (e) => setPipeVoice(e.target.value) })),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: runPipeline, disabled: busy || !studio.enabled }, '七步出片'),
              h('span', { style: { color: C.faint, fontSize: '11px' } }, '豆包逐句配音 → 卡片 → 底板 → 烧字幕/混音/母带 → 联系表'))),

          h(Card, { title: '画面 / 声音 / 文本 API', right: h(Pill, { tone: C.faint }, '可留空') },
            h(Field, { label: '文本 API baseUrl', hint: 'OpenAI 兼容；不填就用本地草稿' },
              h('input', { style: S.input, value: studio.text?.baseUrl || '', placeholder: 'https://api.example.com/v1', onChange: (e) => setStudioField('text', 'baseUrl', e.target.value) })),
            h(Field, { label: '文本模型 / Key' },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, flex: '1 1 140px' }, value: studio.text?.model || '', placeholder: 'model', onChange: (e) => setStudioField('text', 'model', e.target.value) }),
                h('input', { style: { ...S.input, flex: '1 1 140px' }, type: 'password', value: studio.text?.apiKey || '', placeholder: 'sk-…（留空不改）', onChange: (e) => setStudioField('text', 'apiKey', e.target.value) }))),
            h(Field, { label: '配音方式' },
              h('select', { style: S.input, value: studio.tts?.provider || 'sapi', onChange: (e) => setStudioField('tts', 'provider', e.target.value) },
                h('option', { value: 'sapi' }, '本机 Windows 语音（免费）'),
                h('option', { value: 'api' }, '语音 API'),
                h('option', { value: 'none' }, '静音'))),
            h(Field, { label: '语音 API baseUrl / 模型 / 音色' },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, flex: '1 1 160px' }, value: studio.tts?.baseUrl || '', placeholder: 'https://api.example.com/v1', onChange: (e) => setStudioField('tts', 'baseUrl', e.target.value) }),
                h('input', { style: { ...S.input, flex: '1 1 110px' }, value: studio.tts?.model || '', placeholder: 'tts-1', onChange: (e) => setStudioField('tts', 'model', e.target.value) }),
                h('input', { style: { ...S.input, flex: '1 1 110px' }, value: studio.tts?.voice || '', placeholder: 'alloy', onChange: (e) => setStudioField('tts', 'voice', e.target.value) }))),
            h(Field, { label: '画面 API baseUrl / 模型 / Key', hint: 'OpenAI 兼容 images/generations；不填就用纯色占位图' },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, flex: '1 1 160px' }, value: studio.image?.baseUrl || '', placeholder: 'https://api.example.com/v1', onChange: (e) => setStudioField('image', 'baseUrl', e.target.value) }),
                h('input', { style: { ...S.input, flex: '1 1 110px' }, value: studio.image?.model || '', placeholder: 'image-model', onChange: (e) => setStudioField('image', 'model', e.target.value) }),
                h('input', { style: { ...S.input, flex: '1 1 120px' }, type: 'password', value: studio.image?.apiKey || '', placeholder: '留空不改', onChange: (e) => setStudioField('image', 'apiKey', e.target.value) }))),
            h(Field, { label: '生成剪辑素材图', hint: '填一句画面描述；配了图片 API 就走模型，没配就出纯色占位图' },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, flex: '1 1 220px' }, value: imagePrompt, placeholder: '例如：深蓝色房间里的一台老电视，16:9', onChange: (e) => setImagePrompt(e.target.value) }),
                h(Btn, { onClick: makeImage, disabled: busy }, '生成图片'))),
            imageResult ? h('div', { style: { ...S.mono, color: C.faint, marginTop: '4px' } }, `${imageResult.source} · ${imageResult.path}`) : null,
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: () => saveStudio(studio, 'API 配置已保存'), disabled: busy }, '保存 API 配置'))),

          h(Card, { title: '投稿', right: h(Pill, { tone: C.warn }, '必须人工批') },
            h(Field, { label: '标题（可改）' }, h('input', { style: S.input, value: publishTitle, placeholder: jobResult?.title || '默认用脚本标题', onChange: (e) => setPublishTitle(e.target.value) })),
            h(Field, { label: '简介（可改）' }, h('textarea', { style: { ...S.area, minHeight: '70px' }, value: publishDesc, placeholder: '默认带 AI 声明', onChange: (e) => setPublishDesc(e.target.value) })),
            jobResult ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { color: C.sub, fontSize: '12px', marginBottom: '4px' } }, '投前先看一遍：'),
              h('video', {
                controls: true,
                preload: 'metadata',
                src: `/dafeiyu/api/studio/video?id=${encodeURIComponent(job.id)}`,
                style: { width: '100%', maxHeight: '320px', borderRadius: '6px', background: '#000' },
              }),
              h('div', { style: S.row, marginTop: '6px' },
                h(Btn, { onClick: async () => { try { const r = await api('/studio/open-video', { method: 'POST', body: { jobId: job.id } }); if (!r.ok) throw new Error(r.error || '打不开'); notify('已用系统播放器打开') } catch (e) { notify(e.message, true) } } }, '用系统播放器打开'),
                h('span', { style: { ...S.mono, color: C.faint } }, jobResult.videoPath))) : h('div', { style: { color: C.faint, fontSize: '12px', marginTop: '8px' } }, '先做出一条视频，这里会直接预览，确认后再提交审批。'),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { kind: 'primary', onClick: publish, disabled: busy || !jobResult }, '提交投稿审批'),
              !jobResult ? h('span', { style: { color: C.faint } }, '先做出视频') : null)),

          h(Card, { title: '直播姬 / 直播', right: h(Pill, { tone: liveCfg.enabled ? C.accent : C.faint }, liveCfg.enabled ? '开' : '关') },
            h('label', { style: S.row }, h('input', {
              type: 'checkbox', checked: liveCfg.enabled === true,
              onChange: (e) => { const next = { ...liveCfg, enabled: e.target.checked }; setLive({ ...live, config: next }); saveLiveConfig(next, '直播开关已保存') },
            }), '允许操作直播姬'),
            h('label', { style: S.row }, h('input', {
              type: 'checkbox', checked: liveCfg.autoStart === true,
              onChange: (e) => { const next = { ...liveCfg, autoStart: e.target.checked }; setLive({ ...live, config: next }); saveLiveConfig(next, '自动开播开关已保存') },
            }), '允许自动点「开始直播」（实验）'),
            h(Field, { label: 'livehime.exe 路径（留空自动找）' },
              h('input', { style: S.input, value: liveCfg.livehimePath || '', placeholder: live?.status?.livehime?.path || 'C:\\Program Files\\bililive\\livehime\\…\\livehime.exe',
                onChange: (e) => setLive({ ...live, config: { ...liveCfg, livehimePath: e.target.value } }),
                onBlur: (e) => saveLiveConfig({ ...liveCfg, livehimePath: e.target.value }, '直播姬路径已保存') })),
            h(Field, { label: '直播间号 / 分区 id / 标题' },
              h('div', { style: S.row },
                h(AutoNumber, { value: liveCfg.roomId || 0, min: 0, max: 999999999, style: { flex: '1 1 100px' },
                  onSave: (n) => { const next = { ...liveCfg, roomId: n }; setLive({ ...live, config: next }); saveLiveConfig(next, '直播间号已保存') } }),
                h(AutoNumber, { value: liveCfg.areaId || 0, min: 0, max: 999999, style: { flex: '1 1 80px' },
                  onSave: (n) => { const next = { ...liveCfg, areaId: n }; setLive({ ...live, config: next }); saveLiveConfig(next, '分区 id 已保存') } }),
                h('input', { style: { ...S.input, flex: '1 1 140px' }, value: liveCfg.title || '', placeholder: '标题',
                  onChange: (e) => setLive({ ...live, config: { ...liveCfg, title: e.target.value } }),
                  onBlur: (e) => saveLiveConfig({ ...liveCfg, title: e.target.value }, '直播标题已保存') }))),
            h('div', { style: S.row, marginTop: '8px' },
              h(Btn, { onClick: async () => { try { const r = await api('/config', { method: 'POST', body: { patch: { live: liveCfg } } }); notify('直播配置已保存'); await load() } catch (e) { notify(e.message, true) } }, disabled: busy }, '保存直播配置'),
              h(Btn, { onClick: () => liveAction('launch'), disabled: busy || !liveCfg.enabled }, '启动直播姬'),
              h(Btn, { onClick: () => liveAction('check'), disabled: busy }, '只读检查房间'),
              h(Btn, { onClick: () => liveAction('start'), disabled: busy }, '自动开播（实验）')),
            h('div', { style: { ...S.mono, color: C.faint, marginTop: '8px' } },
              `直播姬：${live?.status?.livehime?.exists ? `已装 ${live.status.livehime.version || ''}${live.status.livehime.running ? ' · 正在运行' : ''}` : '未找到'}｜房间：${live?.status?.roomId || '未填'}`),
            live?.status?.startBlockedBy ? h('div', { style: { color: C.warn, fontSize: '11px', marginTop: '6px' } }, live.status.startBlockedBy) : null),

          recentJobs,
        )))
    }

    function AssetsTab({ notify }) {
      const [data, setData] = useState(null)
      const [selected, setSelected] = useState(() => {
        try { return String(localStorage.getItem('dafeiyu:assetIds') || '').split(/[,，\s]+/).filter(Boolean) } catch { return [] }
      })
      const [busy, setBusy] = useState(false)
      const [importPath, setImportPath] = useState('')

      const load = useCallback(async (force) => {
        setBusy(true)
        try {
          const result = await api(`/assets${force ? '?scan=1' : ''}`)
          setData(result)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }, [notify])

      useEffect(() => { load(false) }, [load])

      const assets = (data && data.assets) || []

      function toggle(id) {
        setSelected((prev) => {
          const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
          try { localStorage.setItem('dafeiyu:assetIds', next.join(',')) } catch {}
          return next
        })
      }

      function useForStudio() {
        if (!selected.length) return notify('先勾几张素材', true)
        try { localStorage.setItem('dafeiyu:assetIds', selected.join(',')) } catch {}
        notify(`已选 ${selected.length} 张，去「创作」页做视频`)
      }

      async function copy(value) {
        try {
          await navigator.clipboard.writeText(value)
          notify('已复制')
        } catch {
          notify(value, false)
        }
      }

      async function importImage() {
        if (!importPath.trim()) return notify('先填图片的完整路径', true)
        setBusy(true)
        try {
          const result = await api('/assets/import', { method: 'POST', body: { path: importPath.trim() } })
          if (!result.ok) throw new Error(result.error || '导入失败')
          notify(`已导入 ${result.asset.name}`)
          setImportPath('')
          await load(true)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      const cards = assets.map((item) => h('div', {
        key: item.id,
        style: {
          border: `1px solid ${selected.includes(item.id) ? C.accent : C.border}`,
          borderRadius: '8px', padding: '6px', background: C.panel,
          display: 'flex', flexDirection: 'column', gap: '4px',
        },
      },
        h('img', {
          src: item.url,
          alt: item.name,
          style: { width: '100%', height: '100px', objectFit: 'contain', background: '#111', borderRadius: '5px' },
        }),
        h('label', { style: { ...S.row, gap: '4px', fontSize: '11px' } },
          h('input', { type: 'checkbox', checked: selected.includes(item.id), onChange: () => toggle(item.id) }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.name }, item.name)),
        h('div', { style: { ...S.row, gap: '4px' } },
          h('button', { style: { ...S.btn, padding: '1px 5px', fontSize: '10px' }, onClick: () => copy(item.id) }, '复制 id'),
          h('button', { style: { ...S.btn, padding: '1px 5px', fontSize: '10px' }, onClick: () => copy(item.path) }, '复制路径')),
      ))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, {
          title: '素材库',
          right: h(Pill, { tone: assets.length ? C.accent : C.warn }, `${assets.length} 张`),
        },
          h('div', { style: { color: C.faint, fontSize: '11px', marginBottom: '8px' } },
            '来自本机素材目录；不会自动发布或发送。勾选后在「创作」页按场景轮换使用。'),
          h('div', { style: S.row },
            h(Btn, { kind: 'primary', onClick: () => load(true), disabled: busy }, '重新扫描'),
            h(Btn, { onClick: useForStudio, disabled: !selected.length }, `用于创作（已选 ${selected.length}）`),
            h(Btn, { onClick: async () => { try { const r = await api('/assets/open', { method: 'POST', body: {} }); notify(`已打开 ${r.path}`) } catch (e) { notify(e.message, true) } } }, '打开导入目录')),
          h('div', { style: { ...S.mono, color: C.faint, marginTop: '8px', whiteSpace: 'pre-wrap' } },
            `扫描目录：\n${((data && data.roots) || []).join('\n') || '（暂无）'}`),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('input', {
              style: S.input, value: importPath, placeholder: '要导入的图片完整路径（会复制到本机素材目录）',
              onChange: (event) => setImportPath(event.target.value),
            }),
            h(Btn, { onClick: importImage, disabled: busy }, '导入')),
        ),
        !cards.length
          ? h(Card, { title: '还没有素材' }, h(Empty, null, '把图片放进 D:\\视频制作\\work\\edit\\assets，或在上面导入'))
          : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px' } }, cards),
      )
    }

    function ProjectsTab({ notify }) {
      const [data, setData] = useState(null)
      const [selected, setSelected] = useState('')
      const [detail, setDetail] = useState(null)
      const [busy, setBusy] = useState(false)
      const [newName, setNewName] = useState('')
      const [addPath, setAddPath] = useState('')
      const [addRole, setAddRole] = useState('card')
      const [addName, setAddName] = useState('')

      const load = useCallback(async (force) => {
        setBusy(true)
        try {
          const result = await api(force ? '/library/scan' : '/library', force ? { method: 'POST', body: {} } : undefined)
          setData(result)
          const list = result.projects || []
          if (!selected && list.length) setSelected(list[0].slug)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }, [notify, selected])

      const loadDetail = useCallback(async (name) => {
        if (!name) { setDetail(null); return }
        try {
          const result = await api(`/library/project?name=${encodeURIComponent(name)}`)
          setDetail(result)
        } catch (error) {
          setDetail(null)
          notify(error.message, true)
        }
      }, [notify])

      useEffect(() => { load(false) }, [])
      useEffect(() => { loadDetail(selected) }, [selected, loadDetail])

      const projects = (data && data.projects) || []
      const summary = (data && data.summary) || {}
      const current = detail && detail.project
      const manifest = detail && detail.manifest
      const projectAssets = (current && current.assets) || (manifest && manifest.assets) || []

      async function createProject() {
        if (!newName.trim()) return notify('先写项目名', true)
        setBusy(true)
        try {
          const result = await api('/library/create', { method: 'POST', body: { name: newName.trim() } })
          if (!result.ok) throw new Error(result.error || '创建失败')
          notify(`已建项目 ${result.created.slug}`)
          setNewName('')
          setSelected(result.created.slug)
          await load(true)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function materialize(name, all) {
        setBusy(true)
        try {
          const result = await api('/library/materialize', { method: 'POST', body: all ? { all: true } : { name } })
          if (!result.ok) throw new Error(result.error || '建清单失败')
          notify(all ? `已建 ${result.materialized.count} 份清单` : '清单已建立，原文件没有移动')
          await load(true)
          if (selected) await loadDetail(selected)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function addAsset() {
        if (!selected) return notify('先选一个项目', true)
        if (!addPath.trim()) return notify('先填素材完整路径', true)
        setBusy(true)
        try {
          const result = await api('/library/add', {
            method: 'POST',
            body: { name: selected, file: addPath.trim(), role: addRole, assetName: addName.trim() || undefined },
          })
          if (!result.ok) throw new Error(result.error || '导入失败')
          notify(`已复制到 ${result.added.asset.rel}`)
          setAddPath('')
          setAddName('')
          await loadDetail(selected)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      async function openDir() {
        try {
          const result = await api('/library/open', { method: 'POST', body: selected ? { name: selected } : {} })
          notify(`已打开 ${result.path}`)
        } catch (error) {
          notify(error.message, true)
        }
      }

      async function previewPlan() {
        setBusy(true)
        try {
          const result = await api('/library/plan', { method: 'POST', body: {} })
          if (!result.ok) throw new Error(result.error || '预览失败')
          notify(`待建 ${result.plan.count} 份，已有 ${result.plan.existing} 份；只建索引，不移动文件`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      const rows = projects.map((project) => h('tr', {
        key: project.slug,
        style: { cursor: 'pointer', background: selected === project.slug ? 'var(--dsw-alias-bg-tertiary, #2b2b33)' : 'transparent' },
        onClick: () => setSelected(project.slug),
      },
        h('td', { style: S.td }, h('div', { style: { fontWeight: 600 } }, project.name),
          h('div', { style: { ...S.mono, color: C.faint, fontSize: '10px' } }, project.path)),
        h('td', { style: S.td }, project.kind === 'project' ? '项目' : project.kind === 'scratch' ? '验片/草稿' : project.kind === 'source' ? '原始素材' : '共享'),
        h('td', { style: { ...S.td, ...S.mono } },
          `${project.counts.images} 图 / ${project.counts.audio} 音 / ${project.counts.video} 视频`),
        h('td', { style: S.td }, `${(project.counts.bytes / 1024 / 1024).toFixed(1)} MB`),
        h('td', { style: S.td },
          h(Pill, { tone: project.materialized ? C.accent : C.warn }, project.materialized ? '有清单' : '未建清单'))))

      const previewCards = projectAssets.slice(0, 8).map((item) => h('a', {
        key: item.id,
        href: `/dafeiyu/api/library/file?name=${encodeURIComponent(selected)}&id=${encodeURIComponent(item.id)}`,
        target: '_blank',
        rel: 'noreferrer',
        style: { display: 'block', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', background: '#111' },
        title: item.rel || item.name,
      }, h('img', {
        src: `/dafeiyu/api/library/file?name=${encodeURIComponent(selected)}&id=${encodeURIComponent(item.id)}`,
        alt: item.name,
        style: { width: '100%', height: '78px', objectFit: 'cover', display: 'block' },
      })))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, {
          title: '项目库',
          right: h(Pill, { tone: summary.projects ? C.accent : C.warn }, `${summary.projects || 0} 个项目`),
        },
          h('div', { style: { color: C.faint, fontSize: '11px', marginBottom: '8px' } },
            '每个项目一个 manifest.json：卡片、立绘、配音、底板、QC 都登记在里面。这里只建索引/复制素材，不删除、不覆盖成片。'),
          h('div', { style: S.row },
            h(Btn, { kind: 'primary', onClick: () => load(true), disabled: busy }, '重新扫描'),
            h(Btn, { onClick: previewPlan, disabled: busy }, '整理预览'),
            h(Btn, { onClick: () => materialize('', true), disabled: busy }, '给所有项目建清单'),
            h(Btn, { onClick: openDir }, '打开 projects 根目录')),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('input', { style: S.input, value: newName, placeholder: '新项目名，例如 大肥鱼_直播算账_v3', onChange: (e) => setNewName(e.target.value) }),
            h(Btn, { onClick: createProject, disabled: busy }, '新建项目')),
          h('div', { style: { ...S.mono, color: C.faint, marginTop: '8px', whiteSpace: 'pre-wrap' } },
            `projects：${(data && data.projectsRoot) || '（默认 D:\\视频制作\\projects）'}\n旧目录：${(data && data.legacyRoot) || ''}\n共 ${summary.total || 0} 个目录，${summary.assets || 0} 张图，${((summary.bytes || 0) / 1024 / 1024 / 1024).toFixed(1)} GB\n音效库 ${((data && data.audio && data.audio.sfx) || []).length} 个 / BGM ${((data && data.audio && data.audio.bgm) || []).length} 首`),
        ),
        h(Card, { title: '目录清单' },
          !rows.length ? h(Empty, null, '还没扫到目录') : h('div', { style: S.scroll },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                ['项目', '类型', '素材', '体积', '清单'].map((label) => h('th', { key: label, style: S.th }, label)))),
              h('tbody', null, rows)))),
        current ? h(Card, {
          title: `清单：${current.name}`,
          right: h('div', { style: S.row },
            h(Btn, { onClick: () => materialize(current.slug, false), disabled: busy }, '只建清单'),
            h(Btn, { onClick: openDir }, '打开目录')),
        },
          h('div', { style: { ...S.mono, color: C.faint, marginBottom: '8px', whiteSpace: 'pre-wrap' } },
            `旧路径：${current.legacyPath || '（新布局）'}\n清单：${(manifest && manifest.projectPath) || current.manifestPath || '尚未建立'}\n输出：${(current.outputs || []).length} 个视频，时间轴：${(current.timeline || []).length} 个`),
          previewCards.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '6px' } }, previewCards) : h(Empty, null, '这个项目里还没有可预览的卡片'),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('input', { style: S.input, value: addPath, placeholder: '外部素材完整路径（图片/音频/视频）', onChange: (e) => setAddPath(e.target.value) }),
            h('select', { style: { ...S.input, width: '130px' }, value: addRole, onChange: (e) => setAddRole(e.target.value) },
              ['card', 'character', 'cover', 'watermark', 'sticker', 'ref', 'vo', 'base', 'qc', 'sfx', 'bgm'].map((role) => h('option', { key: role, value: role }, role))),
            h('input', { style: S.input, value: addName, placeholder: '重命名（可选）', onChange: (e) => setAddName(e.target.value) }),
            h(Btn, { onClick: addAsset, disabled: busy }, '复制进项目'))) : null,
      )
    }

    function FeedTab({ notify }) {
      const [items, setItems] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('/feed?limit=18')
          if (!data.ok) throw new Error(data.error || '读取首页推荐失败')
          setItems(data.data?.videos || [])
          setError('')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [])
      useEffect(() => { load() }, [load])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: 'B 站首页推荐', right: h('div', { style: S.row },
          h(Pill, { tone: C.info }, `${items.length} 条`),
          h(Btn, { onClick: load, disabled: busy }, busy ? '读取中…' : '换一屏')) },
          h('div', { style: { color: C.sub, fontSize: '12px', marginBottom: '10px' } },
            '这是登录态个性化推荐，按你平时的观看和互动推的。大肥鱼刷 B 站也先从这里看；热榜/搜索只作补充。'),
          error ? h('div', { style: { color: C.danger, fontSize: '12px', marginBottom: '8px' } }, error) : null,
          items.length ? h('div', { style: S.grid3 }, items.map((item) =>
            h('a', {
              key: item.bvid,
              href: item.url || `https://www.bilibili.com/video/${item.bvid}`,
              target: '_blank',
              rel: 'noreferrer',
              style: { ...S.card, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 0, textDecoration: 'none', color: C.text },
            },
            h('img', {
              src: String(item.cover || '').replace(/^http:/, 'https:'),
              alt: '',
              referrerPolicy: 'no-referrer',
              style: { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', background: C.base, display: 'block' },
            }),
            h('div', { style: { padding: '9px 10px 11px', display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('div', { style: { fontSize: '12px', fontWeight: 600, lineHeight: 1.45 } }, item.title || item.bvid),
              h('div', { style: { color: C.sub, fontSize: '11px' } },
                `${item.author || '未知 UP'} · ${item.play ?? 0} 播放${item.duration ? ` · ${item.duration}` : ''}`),
              item.reason ? h('div', { style: { color: C.faint, fontSize: '11px' } }, item.reason) : null)))
          ) : h(Empty, null, busy ? '正在拉推荐…' : '还没读到推荐；点“换一屏”再试。'))
      )
    }

    const TABS = [
      ['overview', '总览'],
      ['feed', '刷B站'],
      ['persona', '人设'],
      ['memory', '记忆'],
      ['relations', '关系'],
      ['plan', '规划'],
      ['studio', '创作'],
      ['assets', '素材'],
      ['projects', '项目'],
      ['policy', '权限'],
      ['approvals', '审批'],
      ['ledger', '账本'],
    ]

    function ConsolePage() {
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(null)
      const [status, setStatus] = useState(null)
      const [catalog, setCatalog] = useState([])
      const [error, setError] = useState('')
      const [toast, setToast] = useState(null)
      const [busy, setBusy] = useState(false)

      const notify = useCallback((message, isError) => {
        setToast({ message, isError: isError === true })
        setTimeout(() => setToast(null), 5000)
      }, [])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const [bootstrap, stats, cat] = await Promise.all([
            api('/bootstrap'),
            api('/status'),
            api('/catalog'),
          ])
          setData(bootstrap)
          setStatus(stats)
          setCatalog(cat.capabilities || [])
          setError('')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      if (error && !data) {
        return h('div', { style: S.page },
          h('h2', { style: S.title }, '大肥鱼总控台'),
          h('div', { style: { ...S.notice, borderColor: C.danger, color: C.danger } }, `加载失败：${error}`),
          h('div', null, h(Btn, { onClick: refresh }, '重试')))
      }
      if (!data) return h('div', { style: S.page }, h('h2', { style: S.title }, '大肥鱼总控台'), h(Empty, null, '加载中…'))

      const login = (status && status.login) || data.login || {}
      const heartbeatConfig = (data.config && data.config.heartbeat) || {}
      const thread = data.thread || {}
      const emotion = data.emotion || {}
      const pendingCount = (data.pending || []).filter((item) => item.status === 'pending').length

      const tabBody = tab === 'overview'
        ? h(Overview, { data, status, refresh, notify })
        : tab === 'feed'
          ? h(FeedTab, { notify })
        : tab === 'persona'
          ? h(PersonaTab, { data, notify, refresh })
          : tab === 'memory'
            ? h(MemoryTab, { data, notify, refresh })
            : tab === 'relations'
              ? h(RelationsTab, { data, notify, refresh })
              : tab === 'plan'
                ? h(PlanTab, { data, notify, refresh })
                : tab === 'studio'
                  ? h(StudioTab, { notify })
                  : tab === 'assets'
                    ? h(AssetsTab, { notify })
                    : tab === 'projects'
                      ? h(ProjectsTab, { notify })
                      : tab === 'policy'
                  ? h(PolicyTab, { data, catalog, notify, refresh })
                  : tab === 'approvals'
                    ? h(ApprovalsTab, { data, notify, refresh })
                    : h(LedgerTab, { data })

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', null,
            h('h2', { style: S.title }, '大肥鱼总控台'),
            h('p', { style: S.sub }, '一个住在 B 站的 AI 住民。这里管它的人设、记忆、关系、总线程和能做什么。')),
          h('div', { style: S.row },
            h(Pill, { tone: login.uname ? C.accent : C.warn }, login.uname ? `登录 ${login.uname}` : '登录未确认'),
            h(Pill, { tone: thread.status === 'active' ? C.info : C.faint }, thread.status === 'active' ? `在忙：${thread.thread?.title || ''}` : '空闲'),
            h(Pill, { tone: C.info }, emotion.mood || '平静'),
            h(Pill, { tone: pendingCount ? C.warn : C.faint }, `待批 ${pendingCount}`),
            h(Pill, { tone: heartbeatConfig.enabled ? C.accent : C.faint }, heartbeatConfig.enabled ? '心跳开' : '心跳关'),
            h(Btn, { onClick: refresh, disabled: busy }, busy ? '刷新中…' : '刷新'),
            h(Btn, { onClick: async () => {
              try {
                await api('/open-folder', { method: 'POST', body: {} })
                notify('已在资源管理器打开状态目录')
              } catch (err) { notify(err.message, true) }
            } }, '打开状态目录'))),
        toast ? h('div', { style: { ...S.notice, borderColor: toast.isError ? C.danger : C.accent, color: toast.isError ? C.danger : C.accent } }, toast.message) : null,
        error ? h('div', { style: { ...S.notice, borderColor: C.danger, color: C.danger } }, error) : null,
        h('div', { style: S.tabs }, TABS.map(([key, label]) =>
          h('button', { key, style: tab === key ? S.tabActive : S.tab, onClick: () => setTab(key) }, label))),
        tabBody)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dafeiyu',
          order: 58,
          label: () => '大肥鱼',
        }, ConsolePage))
      },
    }
  },
})
