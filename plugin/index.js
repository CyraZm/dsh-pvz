// DSH × 植物大战僵尸 —— host 侧
// 游戏是 Godot 导出的 Web 版，跑在 DSH 页面里的全局浮窗 iframe 中；
// 这里负责：静态托管游戏 / 收局面快照 / 下发指令 / 给 AI 提供工具。
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'

export const name = 'dsh-pvz'
export const inject = ['tools', 'webServer', 'agents', 'agentLoop']

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GAME_DIR = join(HERE, 'game')
const ROUTE = '/dsh-pvz'

/** 进度存在宿主侧：浏览器 origin 随端口变，放 localStorage 每次重启就丢 */
const PROGRESS_FILE = join(homedir(), '.dsh', 'pvz-progress.json')
function readProgress() {
  try {
    const j = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
    return Math.max(0, Number(j.progress) || 0)
  } catch {
    return 0
  }
}
function writeProgress(n) {
  try {
    fs.mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ progress: n }))
  } catch {}
}

export const PLANTS = {
  1: { name: '豌豆射手', cost: 100, emoji: '🌱' },
  2: { name: '向日葵', cost: 50, emoji: '🌻' },
  3: { name: '樱桃炸弹', cost: 150, emoji: '🍒' },
  4: { name: '坚果墙', cost: 50, emoji: '🥜' },
  5: { name: '土豆地雷', cost: 25, emoji: '🥔' },
  6: { name: '寒冰射手', cost: 175, emoji: '❄️' },
  7: { name: '大嘴花', cost: 150, emoji: '🌺' },
  8: { name: '双发射手', cost: 200, emoji: '🌿' },
  19: { name: '三线射手', cost: 325, emoji: '🍀' },
  24: { name: '高坚果', cost: 125, emoji: '🌰' },
}

const CAMPAIGN_FILE = path.join(HERE, 'campaign.json');
function campaignRaw() {
  try { return readFileSync(CAMPAIGN_FILE, 'utf8'); } catch { return ''; }
}

const LEVELS = {
  '1-1': 'res://resources/level_date_resource/mode_adventure/adventure_01_day.tres',
  '1-2': 'res://resources/level_date_resource/mode_adventure/adventure_02_night.tres',
  '1-3': 'res://resources/level_date_resource/mode_adventure/adventure_03_pool.tres',
  '1-4': 'res://resources/level_date_resource/mode_adventure/adventure_04_fog.tres',
  '1-5': 'res://resources/level_date_resource/mode_adventure/adventure_05_Roof.tres',
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const textBlock = (text) => [{ type: 'text', text }]

function buildVersion() {
  try {
    const a = statSync(resolve(GAME_DIR, 'index.pck')).mtimeMs
    const b = statSync(resolve(GAME_DIR, 'index.wasm')).mtimeMs
    return Math.floor(Math.max(a, b)).toString(36)
  } catch {
    return '0'
  }
}

// DSH webServer 的 resource 只放行 GET/HEAD，POST 必须用 handler 形式
function readBody(req, limit = 2 << 20) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}')
  } catch {
    return {}
  }
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const outSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true }
const renderText = (_args, value) => textBlock(String((value && value.text) || ''))

export function apply(ctx) {
  /** 最新局面快照（面板关着时为 null） */
  let latest = null
  let latestAt = 0
  let activeInst = ''
  let activeAt = 0
  /** 待下发指令：按游戏实例分桶，每个实例只取自己的 */
  const queues = new Map()
  /** 每个实例的最新局面 */
  const latestByInst = new Map()
  let seq = 0
  const acks = new Map()
  /** 面板里最后一次动作反馈，给 UI 看 */
  let lastLog = []
  let hostProgress = readProgress()
  const log = (msg, who = 'sys') => {
    lastLog.unshift(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}|${who}`)
    lastLog = lastLog.slice(0, 8)
  }

  const staleMs = 5000
  const hasGame = () => latest && Date.now() - latestAt < staleMs && latest.game

  const bucket = (inst) => {
    const key = inst || ''
    if (!queues.has(key)) queues.set(key, [])
    return queues.get(key)
  }

  function enqueue(cmd, inst) {
    const id = ++seq
    const item = { id, ...cmd }
    const q = bucket(inst || activeInst)
    q.push(item)
    // 指令在队列里最多活 6 秒，面板没开就当过期
    setTimeout(() => {
      const cur = q.indexOf(item)
      if (cur >= 0) q.splice(cur, 1)
    }, 6000).unref?.()
    return id
  }

  async function send(cmd, timeoutMs = 2500, inst) {
    if (!latest) return { ok: false, err: '游戏浮窗还没打开（左侧栏 🌻 或右下角胶囊），或还没开始一局' }
    const id = enqueue(cmd, inst)
    const ack = await new Promise((res) => {
      const t = setTimeout(() => {
        acks.delete(id)
        res(null)
      }, timeoutMs)
      t.unref?.()
      acks.set(id, (v) => {
        clearTimeout(t)
        acks.delete(id)
        res(v)
      })
    })
    if (!ack) return { ok: true, err: '', pending: true }
    return { ok: !!ack.ok, err: String(ack.err || '') }
  }

  // ---------- 局面 -> 给 AI 看的文本 ----------
  function boardText(s) {
    if (!s) return '（还没有局面数据）'
    if (!s.game) return `没有对局在跑。现状：progress=${s.progress ?? '-'}，result=${s.result || '-'}`
    const rows = s.rows || 5
    const cols = s.cols || 9
    const plants = new Map()
    for (const p of s.plants || []) plants.set(`${p.r},${p.c}`, p)
    const zByRow = new Map()
    for (const z of s.zombies || []) {
      if (!zByRow.has(z.r)) zByRow.set(z.r, [])
      zByRow.get(z.r).push(z)
    }
    const lines = []
    const status = s.result ? `已结束(${s.result})` : s.paused ? '暂停' : '进行中'
    const deck = Array.isArray(s.deck) ? s.deck : []
    const deckText = deck.map((t) => `${t}:${(PLANTS[t] || {}).name || '?'}(${(PLANTS[t] || {}).cost || '?'})`).join(' / ')
    lines.push(
      `波次 ${Math.max(0, s.wave)}/${s.max_wave}  阳光 ${s.sun}  僵尸 ${s.zombie_count}  状态 ${status}  速度 ${s.speed}x  进度 ${s.progress}`,
    )
    lines.push(`本关卡组（只能用这些）：${deckText || '未读取到'}`)
    const allowed = Array.isArray(s.rows_allowed) && s.rows_allowed.length ? s.rows_allowed : null
    if (allowed) lines.push(`本关只有 ${allowed.length} 路，可用行：${allowed.join('、')}（其它行种不了）`)
    const head = ['    ' + Array.from({ length: cols }, (_, c) => String(c).padStart(2)).join('')]
    lines.push(...head)
    const rowList = allowed || Array.from({ length: rows }, (_, i) => i)
    for (const r of rowList) {
      const cells = []
      for (let c = 0; c < cols; c++) {
        const p = plants.get(`${r},${c}`)
        cells.push(p ? String(p.type).padStart(2) : ' .')
      }
      const zs = (zByRow.get(r) || []).map((z) => `x=${Math.round(z.x)} hp=${Math.round(z.hp)}`).join(' | ')
      const mower = (s.mowers || []).find((m) => m.r === r)
      lines.push(`r${r} ${cells.join('')}${zs ? '   ← ' + zs : ''}${mower && mower.moving ? '  [推车出发]' : ''}`)
    }
    lines.push(`格子坐标：行 0..${rows - 1}（上→下），列 0..${cols - 1}（左=家门口→右=僵尸来的方向）。数字=植物类型（1豌豆 2葵 3樱桃 4坚果 5土豆雷 6冰豆 8双发）。`)
    return lines.join('\n')
  }

  function meta() {
    return {
      hasGame: hasGame(),
      latestAt,
      lastLog,
      autoplay: { on: autoplay.on, intervalSec: autoplay.intervalSec },
      build: 3,
    }
  }

  // ---------- HTTP ----------
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${ROUTE}/game`,
        resource: async (req) => {
          const url = new URL(req.url, 'http://x')
          let rel = decodeURIComponent(url.pathname.slice(`${ROUTE}/game`.length)) || '/'
          if (rel === '/' || rel === '') rel = '/index.html'
          const file = resolve(GAME_DIR, '.' + rel)
          if (!file.startsWith(GAME_DIR + sep) && file !== GAME_DIR) return new Response('forbidden', { status: 403 })
          const ext = extname(file)

          // 构建版本号：pck/wasm 变了就换 URL，避免浏览器把旧构建永久缓存
          const ver = buildVersion()
          const versioned = /^\/index-[a-z0-9]+(\.audio(?:\.position)?\.worklet\.js|\.pck|\.wasm)$/.exec(rel)
          if (versioned) {
            const real = resolve(GAME_DIR, './index' + versioned[1])
            const rst = statSync(real)
            return new Response(Readable.toWeb(createReadStream(real)), {
              headers: {
                'content-type': MIME[extname(real)] || MIME['.' + versioned[1]] || 'application/octet-stream',
                'content-length': String(rst.size),
                'cache-control': 'public, max-age=31536000, immutable',
              },
            })
          }
          if (!existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404 })
          const st = statSync(file)
          if (ext === '.html') {
            let html = readFileSync(file, 'utf8')
            html = html
              .replace('"executable":"index"', `"executable":"index-${ver}"`)
              .replace('{"index.pck":', `{"mainPack":"index-${ver}.pck","index.pck":`)
            return new Response(html, {
              headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
            })
          }
          // 每次导出 pck 都会变，用 ETag 做校验缓存：未变 304，变了才重传（139MB 全量）
          const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
          if (req.headers.get('if-none-match') === etag) {
            return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } })
          }
          return new Response(Readable.toWeb(createReadStream(file)), {
            headers: {
              'content-type': MIME[ext] || 'application/octet-stream',
              'content-length': String(st.size),
              'cache-control': 'no-cache',
              etag,
            },
          })
        },
      }),
    'pvz static',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/tick`,
        handler: async (req, res) => {
          const state = await readJson(req)
          if (state && typeof state === 'object') {
            // 每个页面 = 一个游戏实例；状态和指令都按实例分桶，
            // 否则两个标签页会互相覆盖局面、还会把同一条指令各执行一次。
            const inst = String(state.inst || 'novel')
            latestByInst.set(inst, state)
            latest = state
            latestAt = Date.now()
            activeInst = inst
            activeAt = Date.now()
            const done = Number(state?.campaign?.done)
            if (Number.isFinite(done) && done > hostProgress) {
              hostProgress = done
              writeProgress(done)
            }
            const q = bucket(inst)
            const cmds = q.slice()
            q.length = 0
            sendJson(res, { cmds })
            return
          }
          sendJson(res, { cmds: [] })
        },
      }),
    'pvz tick',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/ack`,
        handler: async (req, res) => {
          const ack = await readJson(req)
          const fn = acks.get(ack.id)
          if (fn) fn(ack)
          if (!ack.ok) log(`指令 #${ack.id} 失败：${ack.err}`)
          sendJson(res, { ok: true })
        },
      }),
    'pvz ack',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/state`,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://x')
          const want = url.searchParams.get('inst') || ''
          const st = want ? latestByInst.get(want) || null : latest
          sendJson(res, { state: st, meta: meta(), inst: activeInst })
        },
      }),
    'pvz state',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/ctl`,
        handler: async (req, res) => {
          const body = await readJson(req)
          const action = String(body.action || '')
          let r = { ok: false, err: 'unknown action' }
          if (action === 'start') {
            const lv = String(body.level || '')
            const camp = campaignRaw()
            r = await send({
              cmd: 'start',
              level: lv.startsWith('i:') ? lv : LEVELS[lv] || '',
              campaign: camp,
              auto: !!body.auto,
              progress: hostProgress,
            }, 2500, body.inst)
          }
          else if (action === 'choose') r = await send({ cmd: 'choose', deck: Array.isArray(body.deck) ? body.deck : [] }, 2500, body.inst)
          else if (action === 'restart') r = await send({ cmd: 'restart' }, 2500, body.inst)
          else if (action === 'pause') r = await send({ cmd: 'pause', on: true }, 2500, body.inst)
          else if (action === 'resume') r = await send({ cmd: 'pause', on: false }, 2500, body.inst)
          else if (action === 'speed') r = await send({ cmd: 'speed', v: Number(body.v) || 1 }, 2500, body.inst)
          else if (action === 'close') {
            // 面板点了「关闭」= 结束这一局并把这个实例从宿主里摘掉
            const inst = String(body.inst || '')
            if (inst) {
              latestByInst.delete(inst)
              queues.delete(inst)
              if (activeInst === inst) { activeInst = ''; latest = null; latestAt = 0 }
            }
            r = { ok: true, err: '' }
          }
          else if (action === 'quit') r = await send({ cmd: 'quit' }, 2500, body.inst)
          else if (action === 'reset') r = await send({ cmd: 'reset' }, 2500, body.inst)
          else if (action === 'plant') r = await send({ cmd: 'plant', r: Number(body.r), c: Number(body.c), type: Number(body.type) }, 2500, body.inst)
          else if (action === 'rules') r = await send({ cmd: 'rules', id: String(body.id || 'classic') }, 2500, body.inst)
          else if (action === 'endless') r = await send({ cmd: 'endless', auto: autoplay.on }, 8000)
          else if (action === 'autoplay') {
            if (body.on) startAutoplay()
            else stopAutoplay()
            r = { ok: true, err: '' }
          }
          log(`${action} → ${r.ok ? 'ok' : r.err}`)
          sendJson(res, r)
        },
      }),
    'pvz ctl',
  )

  // ---------- AI 接管 ----------
  const autoplay = { on: false, intervalSec: 8, agent: null, timer: null, busyUntil: 0 }

  function startAutoplay(agent, intervalSec) {
    if (agent) autoplay.agent = agent
    if (intervalSec) autoplay.intervalSec = Math.max(3, Math.min(30, intervalSec))
    autoplay.on = true
    autoplay.busyUntil = 0
    if (!autoplay.timer) {
      autoplay.timer = setInterval(autoplayTick, 1000)
      autoplay.timer.unref?.()
    }
    log(`AI 接管开启（每 ${autoplay.intervalSec}s 决策一次）`)
    return autoplay.agent
  }

  function stopAutoplay() {
    autoplay.on = false
    log('AI 接管关闭')
  }

  /** 代打用的独立 agent：它的对话不进用户的聊天，吐槽通过 pvz_say 回到面板 */
  let coach = null
  let coachBroken = false
  async function ensureCoach() {
    if (coach || coachBroken) return coach
    try {
      const handle = await ctx.agentLoop.createAgent(ctx, {
        sessionId: `pvz-coach-${Math.random().toString(36).slice(2, 8)}`,
        meta: { cwd: process.cwd(), isSeeded: false, origin: 'subagent' },
      })
      coach = handle.agent
      ctx.effect(() => () => { handle.dispose().catch(() => {}) }, 'pvz coach')
      log('教练已就位', 'ai')
    } catch (e) {
      coachBroken = true
      log(`教练创建失败：${e.message}`, 'err')
    }
    return coach
  }

  function resolveAgent() {
    if (autoplay.agent) return autoplay.agent
    try {
      const roots = ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
      if (roots && roots.length) autoplay.agent = roots[0]
    } catch {
      /* ignore */
    }
    return autoplay.agent
  }

  function autoplayTick() {
    if (!autoplay.on) return
    if (!coach) ensureCoach()
    const agent = coach || resolveAgent()
    if (!agent) {
      log('没有可用的会话 agent（先在对话里说句话，或让 AI 调一次 pvz_autoplay）')
      return
    }
    if (!hasGame()) return
    // 选卡阶段：AI 代打时直接按本关可用植物开打，不等人点
    if (latest && latest.choosing) {
      const deck = Array.isArray(latest.pool) ? latest.pool.slice(0, latest.slots || latest.pool.length) : []
      send({ cmd: 'choose', deck }).catch(() => {})
      autoplay.busyUntil = Date.now() + 3000
      return
    }
    if (Date.now() < autoplay.busyUntil) return
    autoplay.busyUntil = Date.now() + autoplay.intervalSec * 1000
    const prompt = coach
      ? [
          '【植物大战僵尸 · 自动对局】',
          boardText(latest),
          '',
          '你正在替玩家打这一局。这一步：',
          '1) 需要操作就调 pvz_plant / pvz_shovel（一次可以调多次）；',
          '2) 然后用 pvz_say 说一句吐槽（短、口语、有个性，别写操作步骤）。',
          '只能种「本关卡组」里的植物。不要在回复里长篇解释。',
        ].join('\n')
      : [
          '【PVZ 自动对局 · 该你出手了】',
          boardText(latest),
          '',
          '按上面局面决定这一步做什么：需要就调 pvz_plant / pvz_shovel，然后回用户一两句吐槽（短、口语、别写步骤说明）。如果局面平稳没操作，就只说一句吐槽。',
          '注意：只能种「本关卡组」里列出的植物，别的种不了（会被拒）。',
        ].join('\n')
    try {
      // followup 收的是完整 UserMessage：id / role 缺一不可，
      // 否则会以 id-less 的形式进 inbox 并落盘，导致该会话之后加载校验失败。
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
    } catch (e) {
      log(`唤醒失败：${e.message}`)
    }
  }

  // ---------- 工具 ----------
  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_say',
          description:
            '在游戏侧栏的「动态」里说一句话（AI 代打时的吐槽/战报）。只在代打时使用，不要用它跟用户闲聊。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '一句短话，20 字以内最好' } },
            required: ['text'],
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args) {
            const text = String(args.text || '').trim().slice(0, 80)
            if (text) log(text, 'ai')
            return { text: '已显示在面板动态里。' }
          },
        },
      ),
    'pvz_say',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_launch',
          description:
            '打开/开始一局植物大战僵尸。游戏画面在全局浮窗里（左侧栏 🌻 打开，或由界面自动打开）；本工具只负责让游戏开始一局，不填关卡＝按原版进度打下一关。',
          parameters: {
            type: 'object',
            properties: {
              level: { type: 'string', description: '关卡代号（1-1/1-2/…）；不填＝按原版进度打下一关' },
            },
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args) {
            const level = args.level ? String(args.level) : ''
            const r = await send({ cmd: 'start', level: level ? LEVELS[level] || '' : '' }, 6000)
            return {
              text: r.ok
                ? `开局了${level ? '（' + level + '）' : '（按进度下一关）'}。${r.pending ? '（指令已排队，等面板把游戏跑起来）' : ''}用 pvz_board 看局面。`
                : `没能开始：${r.err}`,
            }
          },
        },
        { when: () => true },
      ),
    'pvz_launch',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_board',
          description: '读取当前这局的局面：波次、阳光、每行植物与僵尸位置/血量、推车状态。AI 每步都该先看它。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: outSchema, render: renderText },
          async execute() {
            return { text: boardText(latest) }
          },
        },
        { when: () => true },
      ),
    'pvz_board',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_plant',
          description:
            '在指定格种一株植物。坐标为 row 0-4（上→下）、col 0-8（左=家门口，右=僵尸来的方向）。类型见 pvz_board 的说明。阳光不够或格子不可种会返回错误。',
          parameters: {
            type: 'object',
            properties: {
              row: { type: 'integer', description: '行 0-4' },
              col: { type: 'integer', description: '列 0-8' },
              type: { type: 'integer', description: '植物类型：1豌豆 2向日葵 3樱桃 4坚果 5土豆雷 6寒冰 8双发' },
            },
            required: ['row', 'col', 'type'],
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args) {
            const r = await send({ cmd: 'plant', r: Number(args.row), c: Number(args.col), type: Number(args.type) })
            const p = PLANTS[Number(args.type)]
            log(`种 ${p ? p.name : args.type} (r${args.row},c${args.col}) → ${r.ok ? 'ok' : r.err}`, 'ai')
            return {
              text: r.ok
                ? `已种下${p ? p.name : '植物'} @ (r${args.row}, c${args.col})`
                : `种不了：${r.err}`,
            }
          },
        },
        { when: () => true },
      ),
    'pvz_plant',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_shovel',
          description: '铲掉某格上的植物。',
          parameters: {
            type: 'object',
            properties: { row: { type: 'integer' }, col: { type: 'integer' } },
            required: ['row', 'col'],
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args) {
            const r = await send({ cmd: 'shovel', r: Number(args.row), c: Number(args.col) })
            return { text: r.ok ? `已铲掉 (r${args.row}, c${args.col})` : `铲不了：${r.err}` }
          },
        },
        { when: () => true },
      ),
    'pvz_shovel',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_control',
          description: '控制这一局：暂停 / 继续 / 重开 / 调速 / 退出。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['pause', 'resume', 'restart', 'speed', 'quit'] },
              speed: { type: 'number', description: 'action=speed 时用，0.25~4' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args) {
            const a = String(args.action)
            const map = {
              pause: { cmd: 'pause', on: true },
              resume: { cmd: 'pause', on: false },
              restart: { cmd: 'restart' },
              speed: { cmd: 'speed', v: Number(args.speed) || 1 },
              quit: { cmd: 'quit' },
            }
            const r = await send(map[a] || { cmd: 'ping' })
            return { text: r.ok ? `已执行 ${a}` : `失败：${r.err}` }
          },
        },
        { when: () => true },
      ),
    'pvz_control',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        {
          name: 'pvz_autoplay',
          description:
            '让 AI 自己接管这一局：开启后会每隔若干秒把局面推给当前会话的 AI，让它自己决策并吐槽。用户自己玩时应当关闭。',
          parameters: {
            type: 'object',
            properties: {
              on: { type: 'boolean', description: 'true 接管，false 停止' },
              intervalSec: { type: 'integer', description: '决策间隔秒数，默认 8' },
            },
            required: ['on'],
            additionalProperties: false,
          },
          output: { schema: outSchema, render: renderText },
          async execute(args, exec) {
            if (args.on) {
              const agent = exec?.agent
              if (!agent) return { text: '拿不到当前会话的 agent，无法接管' }
              startAutoplay(agent, args.intervalSec)
              return { text: `AI 接管已开启，每 ${autoplay.intervalSec} 秒看一次局面。` }
            }
            stopAutoplay()
            return { text: 'AI 接管已关闭。' }
          },
        },
        { when: () => true },
      ),
    'pvz_autoplay',
  )

  ctx.effect(() => () => stopAutoplay(), 'pvz autoplay dispose')
}
