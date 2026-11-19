/**
 * 卡拉彼丘战绩查询客户端（数据源：dakanu.com）
 *
 * 站点没有公开的接入文档对外，接口是逐个实测确认的：
 * - GET /api/search/players?q=      昵称或 UID → 候选玩家（playerId）
 * - GET /api/summoner/{playerId}    玩家全量数据（258KB 量级，上游偏慢）
 * - GET /api/rankings?type=&page=   排行榜（9 种榜）
 * - GET /api/rankings/types         榜单类型清单
 * - GET /api/meta                   模式名 / 角色名 / 赛事名映射
 *
 * 已知边界（实测）：
 * - /api/resolve/{id} 恒 404，昵称解析必须走 search/players
 * - 国际服 ?region=global 返回 409 session_required，只支持国服
 * - 不存在的玩家返回 404 not_found，detail 里夹着上游 nginx 的 404 页
 * - 未观察到限流（12 连发全 200），但单次 1.2–2.9s，槽位压力在站方，要自己压并发
 * - 站点有 Turnstile 验证码，目前只在特定风控场景触发，常规查询不涉及
 *
 * 这里只做「取数 + 数据整形」，渲染与发送在 index.js。
 */

const DEFAULT_BASE_URL = 'https://www.dakanu.com'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36'

/** 单次查询默认超时（毫秒）。summoner 首次拉取实测 2.6s，留足余量 */
const DEFAULT_TIMEOUT = 25000

/** 默认缓存时长（秒）：玩家数据变动不快，5 分钟内重复查询直接吃缓存 */
const DEFAULT_CACHE_TTL = 300

/**
 * 段位表
 *
 * 从站点前端 tierLabels 分块提取，是唯一权威来源：
 * segment 是游戏内的段位序号，1–30 依次对应 9 个段位。
 * 至纯物质 / 升格分子 各 3 小段，虚空原子起 4 小段，束缚电子起 5 小段，
 * 无限超弦与奇点没有小段。
 */
export const TIER_TABLE = [
  { id: 'substance', name: '至纯物质', fromSeg: 1, toSeg: 3, divisions: ['III', 'II', 'I'], color: '#6c7178' },
  { id: 'molecule', name: '升格分子', fromSeg: 4, toSeg: 6, divisions: ['III', 'II', 'I'], color: '#c07a52' },
  { id: 'atom', name: '虚空原子', fromSeg: 7, toSeg: 10, divisions: ['IV', 'III', 'II', 'I'], color: '#9aa7b5' },
  { id: 'proton', name: '聚变质子', fromSeg: 11, toSeg: 14, divisions: ['IV', 'III', 'II', 'I'], color: '#d0a63c' },
  { id: 'neutron', name: '自由中子', fromSeg: 15, toSeg: 18, divisions: ['IV', 'III', 'II', 'I'], color: '#28b3a4' },
  { id: 'electron', name: '束缚电子', fromSeg: 19, toSeg: 23, divisions: ['V', 'IV', 'III', 'II', 'I'], color: '#3f8fd6' },
  { id: 'quark', name: '禁闭夸克', fromSeg: 24, toSeg: 28, divisions: ['V', 'IV', 'III', 'II', 'I'], color: '#9b5cd6' },
  { id: 'superstring', name: '无限超弦', fromSeg: 29, toSeg: 29, divisions: [], color: '#d94a44' },
  { id: 'singularity', name: '奇点', fromSeg: 30, toSeg: 30, divisions: [], color: '#d84a4a' },
]

/** 奇点底分（站点用它判断是否够格进奇点） */
export const SINGULARITY_FLOOR = 2800

/**
 * 段位序号 → { 段位, 小段 }
 * @param {number|null|undefined} segment
 * @returns {{tier:Object, division:string, segment:number}|null}
 */
export function tierOf(segment) {
  if (segment == null) return null
  const seg = Math.trunc(Number(segment))
  if (!Number.isFinite(seg) || seg < 1) return null
  const tier = TIER_TABLE.find(t => seg >= t.fromSeg && seg <= t.toSeg)
  if (!tier) return null
  return { tier, division: tier.divisions[seg - tier.fromSeg] ?? '', segment: seg }
}

/**
 * 段位序号 → 展示文案，如「奇点」「禁闭夸克 III」「未定级」
 * @param {number|null|undefined} segment
 */
export function tierLabel(segment) {
  const info = tierOf(segment)
  if (!info) return '未定级'
  return info.division ? `${info.tier.name} ${info.division}` : info.tier.name
}

/** 取段位主色，用于卡片着色 */
export function tierColor(segment) {
  return tierOf(segment)?.tier?.color || '#6c7178'
}

/**
 * 段位分 → 段位序号
 *
 * 得分榜（段位榜）里没有真实的 segment —— 站点对所有 entry 都填 30，
 * 它自己的前端也是拿分数反推的（tierLabels 里的 divisionScore → segment）：
 * 每 100 分一段，2800 分及以上算奇点。
 *
 * @param {number} score 段位分
 * @param {number} [floor] 奇点底分
 * @returns {number|null}
 */
export function segmentFromScore(score, floor = SINGULARITY_FLOOR) {
  const n = Number(score)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= floor) return 30
  return Math.min(29, Math.max(1, Math.ceil(Math.trunc(n) / 100)))
}

/** 秒 → 「12:34」 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0))
  const m = Math.floor(s / 60)
  const rest = s % 60
  return `${m}:${String(rest).padStart(2, '0')}`
}

/** unix 秒 → 「11-13 20:14」（本地时区） */
export function formatDateTime(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n * 1000)
  const p = x => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** unix 秒 → 「2026-10-23」 */
export function formatDate(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n * 1000)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** unix 秒 → 相对时间，如「3 小时前」 */
export function formatRelative(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const diff = Date.now() / 1000 - n
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return formatDateTime(n)
}

/** 0.6149 → 「61.5%」 */
export function formatPercent(rate, digits = 1) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/** 数字带千分位，空值给「—」 */
export function formatNumber(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return digits > 0
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : Math.round(n).toLocaleString('zh-CN')
}

/** 带正负号的差值，如「+18」「-16」 */
export function formatDelta(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return '0'
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n))
}

/**
 * 业务错误：把上游的 code 收成固定的几类，方便上层决定文案
 * - not_found     玩家不存在
 * - session       上游没有可用会话（国际服 / 站点未登录）
 * - rate_limited  被限流
 * - timeout       上游超时
 * - upstream      上游返回了别的错误
 * - network       网络层失败（DNS / 连接重置）
 */
export class StatsError extends Error {
  constructor(code, message, detail = '') {
    super(message)
    this.name = 'StatsError'
    this.code = code
    this.detail = detail
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 从多个同名账号里挑一个主号
 *
 * 同名重复账号在小号上很常见，等级是最稳的区分依据（实测 500 vs 137）。
 * 这里只做「按等级降序取第一个」，是否会挑错由调用方用 ambiguous 判断。
 */
function pickPrincipal(list) {
  return [...list].sort((a, b) => {
    const la = Number(a.level) || 0
    const lb = Number(b.level) || 0
    if (lb !== la) return lb - la
    // 等级也一样时，服务端标了 indexed 的优先
    return Number(b.indexed !== false) - Number(a.indexed !== false)
  })[0]
}

/**
 * 把上游的 code 归一到 StatsError.code
 */
function normalizeCode(code, httpStatus) {
  const c = String(code || '').toLowerCase()
  if (c === 'not_found') return 'not_found'
  if (c === 'session_required' || c === 'session') return 'session'
  if (c === 'rate_limited' || httpStatus === 429) return 'rate_limited'
  if (c === 'invalid_api_key') return 'upstream'
  if (httpStatus === 404) return 'not_found'
  return 'upstream'
}

/**
 * dakanu.com 数据客户端
 */
export class DakanuClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] 站点根地址
   * @param {number} [options.timeout] 单次请求超时（毫秒）
   * @param {number} [options.cacheTtl] 默认缓存时长（秒）
   * @param {number} [options.concurrency] 并发上限，避免给站方压力
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeout = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_TIMEOUT
    this.cacheTtl = Number.isFinite(options.cacheTtl) ? Number(options.cacheTtl) : DEFAULT_CACHE_TTL
    this.concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 3

    /** @type {Map<string, {expiresAt:number, value:any}>} */
    this._cache = new Map()
    /** @type {Map<string, Promise<any>>} 同一个 key 的并发请求合并成一次 */
    this._inflight = new Map()
    this._active = 0
    this._queue = []
    this._meta = null
    this._metaExpiresAt = 0
  }

  /** 可在运行时改地址/超时（配合 -设置 改配置后重建实例） */
  configure(options = {}) {
    if (options.baseUrl) this.baseUrl = String(options.baseUrl).replace(/\/+$/, '')
    if (Number(options.timeout) > 0) this.timeout = Number(options.timeout)
    if (Number.isFinite(options.cacheTtl)) this.cacheTtl = Number(options.cacheTtl)
    if (Number(options.concurrency) > 0) this.concurrency = Number(options.concurrency)
    this._cache.clear()
  }

  /** 清空缓存 */
  clearCache() {
    this._cache.clear()
    this._meta = null
    this._metaExpiresAt = 0
  }

  // ── 基础请求 ────────────────────────────────────────────────

  async _withSlot(fn) {
    if (this._active >= this.concurrency) {
      await new Promise(resolve => this._queue.push(resolve))
    }
    this._active++
    try {
      return await fn()
    } finally {
      this._active--
      const next = this._queue.shift()
      if (next) next()
    }
  }

  _cacheGet(key) {
    const hit = this._cache.get(key)
    if (!hit) return undefined
    if (hit.expiresAt && hit.expiresAt < Date.now()) {
      this._cache.delete(key)
      return undefined
    }
    return hit.value
  }

  _cacheSet(key, value, ttlSeconds) {
    const ttl = ttlSeconds ?? this.cacheTtl
    // ttl <= 0 表示不缓存（但仍返回数据）
    if (ttl > 0) {
      this._cache.set(key, { value, expiresAt: Date.now() + ttl * 1000 })
    }
    return value
  }

  async _fetchJson(url, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: `${this.baseUrl}/`,
        },
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new StatsError('timeout', `查询超时（${Math.round(timeoutMs / 1000)} 秒）`)
      }
      throw new StatsError('network', `网络请求失败：${err?.message || err}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // 上游出错时会返回 nginx 的 HTML 页
    }

    if (!json) {
      if (res.status === 404) throw new StatsError('not_found', '上游没有这个条目')
      throw new StatsError('upstream', `上游返回了非 JSON 响应（HTTP ${res.status}）`, text.slice(0, 200))
    }

    if (!res.ok || json.ok === false) {
      throw new StatsError(
        normalizeCode(json.code, res.status),
        json.error || `上游返回错误（HTTP ${res.status}）`,
        typeof json.detail === 'string' ? json.detail : ''
      )
    }

    return json
  }

  /**
   * GET 一个接口，带缓存、并发槽与一次重试
   * @param {string} pathname 以 / 开头的路径
   * @param {Object} [options]
   * @param {number} [options.ttl] 缓存秒数，0 表示不缓存
   * @param {number} [options.timeout] 单独指定超时
   * @param {number} [options.retries] 网络类错误重试次数
   */
  async _get(pathname, options = {}) {
    const url = this.baseUrl + pathname
    const cached = this._cacheGet(url)
    if (cached !== undefined) return cached

    // 同一 URL 并发请求合并，避免同时打多次
    const pending = this._inflight.get(url)
    if (pending) return pending

    const task = this._withSlot(async () => {
      const retries = options.retries ?? 1
      let lastError = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const data = await this._fetchJson(url, options.timeout || this.timeout)
          return this._cacheSet(url, data, options.ttl)
        } catch (err) {
          lastError = err
          // 只有「再问一次可能有不同答案」的错误才重试。
          // not_found / session 是确定性结果，重试纯属浪费站方资源；
          // upstream（502/503 后端升级、上游排队冷却）和 network 都是瞬时的，必须重试。
          const retryable = err instanceof StatsError &&
            (err.code === 'upstream' || err.code === 'network' || err.code === 'rate_limited')
          if (!retryable) throw err
          if (attempt < retries) await sleep(1200 * (attempt + 1))
        }
      }
      // 重试仍失败时，退回上一条过期缓存（有总比没有强），否则抛错
      const stale = this._cache.get(url)
      if (stale?.value !== undefined) {
        logger?.warn?.(`[KlbqWiki] ${pathname} 上游不可用，使用过期缓存（${lastError?.code || 'error'}）`)
        return stale.value
      }
      throw lastError
    })

    this._inflight.set(url, task)
    try {
      return await task
    } finally {
      this._inflight.delete(url)
    }
  }

  // ── 对外接口 ────────────────────────────────────────────────

  /** 模式 / 角色 / 赛季 名称映射，缓存 6 小时 */
  async meta() {
    if (this._meta && this._metaExpiresAt > Date.now()) return this._meta
    const data = await this._get('/api/meta', { ttl: 6 * 3600 })
    this._meta = {
      modes: data.modes || {},
      roles: data.roles || {},
      seasons: data.seasons || [],
    }
    this._metaExpiresAt = Date.now() + 6 * 3600 * 1000
    return this._meta
  }

  /** 昵称 / UID → 候选玩家列表（缓存 60 秒） */
  async searchPlayers(query) {
    const q = String(query || '').trim()
    if (!q) throw new StatsError('not_found', '请输入玩家昵称或 UID')
    const data = await this._get(`/api/search/players?q=${encodeURIComponent(q)}`, { ttl: 60 })
    return Array.isArray(data.suggestions) ? data.suggestions : []
  }

  /**
   * 解析一个查询词到唯一的 playerId
   *
   * 优先级：UID 精确命中 → 当前昵称精确命中 → 第一个精确 → 第一个候选。
   * 不精确时把候选列表一并返回，让上层提示用户「匹配到多个账号」。
   * @returns {Promise<{player:Object, candidates:Object[], confident:boolean}>}
   */
  async resolvePlayer(query) {
    const q = String(query || '').trim()
    const list = await this.searchPlayers(q)
    // indexed=false 的条目点进去大概率查不到，但不绝对，排在后面
    const usable = list.filter(item => item && item.playerId)
    if (!usable.length) {
      throw new StatsError('not_found', `没有找到「${q}」对应的玩家`)
    }

    // 纯数字按 UID 处理：站点的搜索是模糊的，查一个不存在的 UID 时它会拿
    // 「曾用名里含这串数字」的玩家来凑数（实测 999999999999 → 完全不同的人），
    // 所以 UID 必须真的对上，否则宁可报找不到。
    if (/^\d{5,}$/.test(q)) {
      const byUid = usable.find(item => String(item.playerId) === q)
      if (byUid) return { player: byUid, candidates: usable, confident: true }
      // 也有人把昵称起成纯数字
      const byNickname = usable.find(item => item.exact && String(item.nickname) === q)
      if (byNickname) return { player: byNickname, candidates: usable, confident: true }
      throw new StatsError('not_found', `没有找到 UID 为 ${q} 的玩家`)
    }

    const indexedFirst = [...usable].sort((a, b) => Number(b.indexed !== false) - Number(a.indexed !== false))
    const exact = indexedFirst.filter(item => item.exact)

    // 同一个昵称可能被多个账号占用（实测「Maker寒冬」与「maker寒冬」都是 exact），
    // 站点的返回顺序会变，靠「第一个精确匹配」会随缘查错人。
    // 先找大小写也完全一致的；仍有多个时用等级挑一个主号（小号等级低），
    // 挑不出唯一解就交给上层让用户确认。
    let best = null
    let ambiguous = false

    const exactCaseSensitive = exact.filter(item => String(item.nickname ?? item.matchedName ?? '') === q)
    if (exactCaseSensitive.length === 1) {
      best = exactCaseSensitive[0]
    } else if (exactCaseSensitive.length > 1) {
      best = pickPrincipal(exactCaseSensitive)
    }

    if (!best) {
      const byUid = exact.find(item => item.matchedBy === 'uid')
      if (byUid) {
        best = byUid
      } else if (exact.length === 1) {
        best = exact[0]
      } else if (exact.length > 1) {
        // 全是大小写不同的同名账号，按等级挑主号
        best = pickPrincipal(exact)
      } else {
        best = indexedFirst[0]
      }
    }

    // 若最高等级还有并列，说明是几个体量相当的号，别猜
    if (best && exact.length > 1) {
      const topLevel = Number(best.level) || 0
      const sameLevel = exact.filter(item => (Number(item.level) || 0) === topLevel)
      if (exact.length > 1 && sameLevel.length > 1) ambiguous = true
    }

    return {
      player: best,
      candidates: indexedFirst,
      confident: Boolean(best.exact && best.indexed !== false && !ambiguous),
      ambiguous,
    }
  }

  /**
   * 玩家全量数据
   * @param {string|number} playerId
   */
  async summoner(playerId) {
    const id = String(playerId || '').trim()
    if (!id) throw new StatsError('not_found', '缺少玩家 ID')
    const data = await this._get(`/api/summoner/${encodeURIComponent(id)}`, {
      ttl: this.cacheTtl,
      retries: 1,
    })
    if (!data.profile) throw new StatsError('upstream', '上游没有返回玩家资料')
    return data.profile
  }

  /** 榜单类型清单 */
  async rankTypes() {
    const data = await this._get('/api/rankings/types', { ttl: 6 * 3600 })
    return Array.isArray(data.types) ? data.types : []
  }

  /**
   * 排行榜
   * @param {Object} [options]
   * @param {number} [options.type] 榜单类型 code，默认 1（段位榜）
   * @param {number} [options.page] 页码，从 1 开始
   * @param {number} [options.pageSize] 每页条数
   * @param {number} [options.seasonId] 赛季 ID
   */
  async rankings(options = {}) {
    const type = Number(options.type) || 1
    const page = Math.max(1, Number(options.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 20))
    const params = new URLSearchParams({
      type: String(type),
      page: String(page),
      page_size: String(pageSize),
    })
    if (Number(options.seasonId) > 0) params.set('season_id', String(options.seasonId))
    const data = await this._get(`/api/rankings?${params.toString()}`, { ttl: 300 })
    return data
  }

  /**
   * 单局详情
   *
   * 站点只对最近若干场返回完整详情（`hasDetail: false` 的对局仍能查到，但没有分回合数据）。
   * @param {string} roomId 对局 ID（19 位数字）
   */
  async matchDetail(roomId) {
    const id = String(roomId || '').trim()
    if (!/^\d{6,}$/.test(id)) {
      throw new StatsError('not_found', '对局 ID 应为纯数字（从最近对局的 roomId 获取）')
    }
    const data = await this._get(`/api/match/${encodeURIComponent(id)}`, { ttl: 3600, retries: 1 })
    if (!Array.isArray(data.teams) || !data.teams.length) {
      throw new StatsError('not_found', '这一场没有可用的记分板数据')
    }
    return data
  }

  /**
   * 战队查询
   *
   * 站点只提供搜索接口，没有成员列表端点（`/api/clans/{id}` 是 404）。
   * 按名称搜索时上游可能直接 422（`clan_search rejected with code 100`），
   * 说明站点的名称索引不完整，按 ID 才稳。
   * @param {Object} options
   * @param {string} [options.name] 战队名称
   * @param {string} [options.clanId] 战队 ID
   * @param {number} [options.limit] 返回条数
   */
  async searchClans(options = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(10, Math.max(1, Number(options.limit) || 5))) })
    const name = String(options.name || '').trim()
    const clanId = String(options.clanId || '').trim()
    if (clanId) params.set('clan_id', clanId)
    else if (name) params.set('name', name)
    else throw new StatsError('not_found', '请提供战队名称或战队 ID')

    const data = await this._get(`/api/clans/search?${params.toString()}`, { ttl: 600 })
    const clans = Array.isArray(data.clans) ? data.clans : []
    if (!clans.length) throw new StatsError('not_found', '没有找到这支战队')
    return clans
  }

  /**
   * 封神榜（官方安全巡检查封记录）
   *
   * 注意：上游虽然接受 `query` 参数，但**完全忽略它** —— 传任何值都返回同一批
   * 按等级排序的记录（实测 total 恒为 10477，传不存在的昵称也一样）。
   * 所以「查某人」不能依赖上游过滤，只能翻页在本地筛。
   * 全量 1 万多条不可能一次拉完，这里扫前 `scanPages` 页就停：
   * 命中就返回命中项，没命中要说清「只扫了前 N 条」，不能假装查了整个榜。
   *
   * 上游把玩家 ID 与昵称做了打码（`maskedId` / `maskedNick`），但原始 `playerId`
   * 与 `nickname` 仍在响应里 —— 这正是本地筛选能成立的原因，展示时用打码版本。
   *
   * @param {Object} [options]
   * @param {string} [options.query] 玩家 UID 或昵称，留空则取榜单
   * @param {number} [options.offset] 偏移（仅榜单模式）
   * @param {number} [options.limit] 条数
   * @param {number} [options.scanPages] 查询个人时最多扫几页（每页 50）
   */
  async bannedPlayers(options = {}) {
    const query = String(options.query || '').trim()
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 15))

    if (!query) {
      const params = new URLSearchParams({
        offset: String(Math.max(0, Number(options.offset) || 0)),
        limit: String(limit),
      })
      return await this._get(`/api/banned-players?${params.toString()}`, { ttl: 600 })
    }

    // 查个人：翻页本地筛
    const pageSize = 50
    const scanPages = Math.max(1, Math.min(20, Number(options.scanPages) || 6))
    const needle = query.toLowerCase()
    const hits = []
    let scanned = 0
    let total = 0
    let exhausted = false

    for (let page = 0; page < scanPages; page++) {
      const offset = page * pageSize
      const data = await this._get(
        `/api/banned-players?offset=${offset}&limit=${pageSize}`,
        { ttl: 600, retries: 1 }
      )
      const entries = Array.isArray(data.entries) ? data.entries : []
      total = Number(data.total) || total
      scanned += entries.length

      for (const item of entries) {
        const candidates = [item.playerId, item.nickname, item.maskedId, item.maskedNick]
          .filter(Boolean)
          .map(value => String(value).toLowerCase())
        if (candidates.some(value => value === needle || value.includes(needle))) {
          hits.push(item)
        }
      }

      if (!data.hasMore || entries.length < pageSize) {
        exhausted = true
        break
      }
      // 已经找够了就别继续翻
      if (hits.length >= limit) break
    }

    return {
      ok: true,
      entries: hits.slice(0, limit),
      total: hits.length,
      scanned,
      grandTotal: total,
      exhausted,
      query,
    }
  }
}

// ── 数据整形：把上游 profile 变成卡片能直接用的结构 ─────────────

/**
 * 玩家生涯卡
 * @param {Object} profile summoner 返回的 profile
 * @param {Object} meta { modes, roles, seasons }
 */
export function buildCareerCard(profile, meta = {}) {
  const player = profile.player || {}
  const presence = profile.presence || {}
  const rank = profile.rank || {}
  const rolesMeta = meta.roles || {}
  const modesMeta = meta.modes || {}

  // 新赛季刚切换时，上游 summary 会出现 rounds/wins/losses 都是 0、
  // 但 kills/assists/damage 已经有值的自相矛盾状态（实测 S26EP6 首日）。
  // 这时用模式统计里最活跃的那个模式兜底，否则卡片会显示「0 场」却「2821 杀」。
  const summary = { ...(profile.summary || {}) }
  let rebuiltFromModes = false
  if (!(Number(summary.rounds) > 0)) {
    const modesWithRounds = (profile.modes || []).filter(item => Number(item.rounds) > 0)
    if (modesWithRounds.length) {
      const totalRounds = modesWithRounds.reduce((sum, item) => sum + Number(item.rounds || 0), 0)
      const totalWins = modesWithRounds.reduce((sum, item) => sum + Number(item.wins || 0), 0)
      summary.rounds = totalRounds
      summary.wins = totalWins
      summary.losses = Math.max(0, totalRounds - totalWins)
      summary.winRate = totalRounds > 0 ? totalWins / totalRounds : 0
      rebuiltFromModes = true
    }
  }

  const currentTier = tierLabel(rank.segment)
  const topTier = tierLabel(rank.topSegment)
  const historicalTier = rank.historicalSegment && rank.historicalSegment !== rank.topSegment
    ? tierLabel(rank.historicalSegment)
    : ''

  // 顶部横条：段位分 / 胜率 / KDA / MVP
  const belt = [
    { label: '段位分', value: formatNumber(rank.divisionScore) },
    { label: '胜率', value: formatPercent(summary.winRate) },
    { label: 'KDA', value: formatNumber(summary.kda, 2) },
    { label: 'MVP 率', value: formatPercent(summary.mvpRate) },
  ]

  // 生涯汇总
  const kv = [
    { label: '场次', value: formatNumber(summary.rounds) },
    { label: '胜 / 负', value: `${formatNumber(summary.wins)} / ${formatNumber(summary.losses)}` },
    { label: '击杀', value: formatNumber(summary.kills) },
    { label: '助攻', value: formatNumber(summary.assists) },
    { label: '死亡', value: formatNumber(summary.deaths) },
    { label: '场均伤害', value: formatNumber(summary.avgDamage) },
    { label: '回合均伤', value: formatNumber(summary.roundAveDamage) },
    { label: '爆头率', value: formatPercent(summary.headshotRate) },
  ]

  // 常用角色：按场次降序，取前 5；name 优先用 profile.roles 里的，退回 meta 的角色表
  //
  // 生化模式会用 300 段的假 roleId（实测 301/302/304/305/306），站点自己的角色表
  // 里根本没有这些 ID，前端也只能兜底显示成「角色 301」。它们不是超弦体，
  // 混进常用角色会顶掉真正的角色，所以单独拎出来只汇总场次与胜率。
  const isZombieSlot = item => Number(item.roleId) >= 300
  const realRoles = (profile.roles || []).filter(item => !isZombieSlot(item))
  const zombieSlots = (profile.roles || []).filter(item => isZombieSlot(item))

  const topRoles = [...realRoles]
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 5)
    .map(item => ({
      name: item.name || rolesMeta[String(item.roleId)] || `角色 ${item.roleId}`,
      games: formatNumber(item.count),
      winRate: formatPercent(item.winRate),
      kd: formatNumber(item.kd, 2),
      avgDamage: formatNumber(item.avgDamage),
    }))

  // 模式统计：按场次降序，取前 3
  // 生化模式由下面的独立小块承载（那里要合掉多个槽位），这里不重复列
  const topModes = [...(profile.modes || [])]
    .filter(item => !/ZOMBIE/i.test(String(item.mode || '')))
    .sort((a, b) => (b.rounds || 0) - (a.rounds || 0))
    .slice(0, 3)
    .map(item => ({
      label: item.label || modesMeta[item.mode] || item.mode || '未知模式',
      rounds: formatNumber(item.rounds),
      winRate: formatPercent(item.winRate),
      kd: formatNumber(item.kd, 2),
    }))

  // 生化汇总
  //
  // 注意：300 段槽位的 count 不能相加。同一次生化对局会同时记在多个槽位上
  // （实测 5 个槽位分别是 11/10/2/1/1，相加 25，而模式统计里生化只有 11 场），
  // 相加会把场次放大一倍多。场次与胜率一律取模式统计的生化口径，
  // 槽位只用来表示「打过几种生化身份」，K/D 取场次最多的那个槽位。
  let zombie = null
  if (zombieSlots.length) {
    const zombieMode = (profile.modes || []).find(item => /ZOMBIE/i.test(String(item.mode || '')))
    const mainSlot = [...zombieSlots].sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))[0]
    const games = zombieMode ? Number(zombieMode.rounds) || 0 : Number(mainSlot?.count) || 0
    const kills = Number(mainSlot?.kills) || 0
    const deaths = Number(mainSlot?.deaths) || 0
    zombie = {
      games: formatNumber(games),
      winRate: formatPercent(zombieMode ? zombieMode.winRate : mainSlot?.winRate),
      kd: formatNumber(deaths > 0 ? kills / deaths : kills, 2),
      slots: zombieSlots.length,
    }
  }

  const marks = []
  if (player.mark?.label) marks.push(player.mark.label)
  if (player.accountVerified) marks.push('已认证')
  if (presence.state === 'online') marks.push('在线')
  else if (presence.lastOnlineAt) marks.push(`最近在线 ${formatRelative(presence.lastOnlineAt)}`)

  const subtitleParts = [
    `Lv.${formatNumber(player.level)}`,
    currentTier,
    rank.rankPos ? `全服第 ${formatNumber(rank.rankPos)}` : '',
    profile.meta?.currentSeason || '',
  ].filter(Boolean)

  const tips = []
  if (rebuiltFromModes) tips.push('新赛季统计正在重建，场次按模式汇总')
  if (topTier && topTier !== currentTier) tips.push(`本赛季最高 ${topTier}`)
  if (historicalTier) tips.push(`历史最高 ${historicalTier}`)
  if (player.clanId) tips.push(`战队 ${player.clanId}`)

  return {
    title: player.nickname || '未知玩家',
    kind: subtitleParts.join(' · '),
    belt,
    kv,
    roles: topRoles,
    modes: topModes,
    zombie,
    tip: tips.join(' ｜ '),
    accent: tierColor(rank.segment),
    metaLine: marks.join(' ｜ '),
  }
}

/**
 * 最近对局卡
 * @param {Object} profile
 * @param {Object} [options]
 * @param {number} [options.limit] 取最近多少局
 */
export function buildMatchesCard(profile, options = {}) {
  const limit = Math.min(20, Math.max(1, Number(options.limit) || 10))
  const player = profile.player || {}
  const rolesMeta = options.meta?.roles || {}

  // matches 是最近若干场（20 条），historyMatches 更全（几百条），优先用 matches
  const source = (profile.matches?.length ? profile.matches : profile.historyMatches) || []
  const rows = source
    .slice()
    .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0))
    .slice(0, limit)
    .map(item => {
      const win = item.result === 'win'
      const draw = item.result === 'draw'
      const kda = (item.deaths || 0) > 0
        ? ((item.kills || 0) + (item.assists || 0)) / item.deaths
        : ((item.kills || 0) + (item.assists || 0))
      // 只有双方比分都拿到的模式才有「比分」；团队/枪王/自定义房间只有我方一个数，不当作比分展示
      const hasScore = item.myScore != null && item.opponentScore != null
      return {
        roomId: String(item.roomId || ''),
        time: formatDateTime(item.playedAt),
        mode: item.modeLabel || item.mode || '未知模式',
        role: rolesMeta[String(item.roleId)] || `角色 ${item.roleId}`,
        score: hasScore ? `${item.myScore} : ${item.opponentScore}` : '—',
        kda: `${item.kills || 0}/${item.deaths || 0}/${item.assists || 0}`,
        kdaValue: formatNumber(kda, 2),
        result: win ? '胜' : draw ? '平' : '负',
        resultClass: win ? 'win' : draw ? 'draw' : 'lose',
        badge: item.mvp ? 'MVP' : item.svp ? 'SVP' : '',
        badgeClass: item.mvp ? 'mvp' : 'svp',
        delta: item.divisionScoreDelta == null || item.divisionScoreDelta === 0
          ? ''
          : formatDelta(item.divisionScoreDelta),
        deltaClass: (item.divisionScoreDelta || 0) > 0 ? 'up' : 'down',
        duration: formatDuration(item.durationSeconds),
      }
    })

  const stat = rows.reduce(
    (acc, row) => {
      acc.total++
      if (row.result === '胜') acc.win++
      return acc
    },
    { total: 0, win: 0 }
  )

  const tipParts = [`最近 ${stat.total} 局 ${stat.win} 胜 ${stat.total - stat.win} 负`]
  if (profile.meta?.matchesTotal) tipParts.push(`生涯可查 ${formatNumber(profile.meta.matchesTotal)} 局`)
  if (profile.meta?.cached) tipParts.push('数据来自站点缓存')
  // 对局 ID 是查单局详情的唯一入口，不给出来用户就无从下手
  const firstRoom = rows.find(row => row.roomId)?.roomId
  if (firstRoom) tipParts.push(`查单局：-对局 ${firstRoom}`)

  return {
    title: `${player.nickname || '未知玩家'} · 最近对局`,
    kind: profile.meta?.currentSeason ? `${profile.meta.currentSeason}` : '',
    rows,
    tip: tipParts.join(' ｜ '),
    accent: tierColor(profile.rank?.segment),
  }
}

/**
 * 搭档 / 对手卡
 * @param {Object} profile
 * @param {'teammate'|'rival'} kind
 */
export function buildRelationsCard(profile, kind = 'teammate') {
  const player = profile.player || {}
  const isTeam = kind === 'teammate'
  const source = isTeam ? profile.teamUps || [] : profile.rivals || []

  const rows = [...source]
    .sort((a, b) => {
      const keyA = isTeam ? a.teamedGames : a.games
      const keyB = isTeam ? b.teamedGames : b.games
      return (keyB || 0) - (keyA || 0)
    })
    .slice(0, 15)
    .map(item => {
      const games = isTeam ? item.teamedGames : item.games
      const wins = isTeam ? item.teamedWins : item.wins
      const losses = isTeam ? item.teamedLosses : item.losses
      const draws = isTeam ? item.teamedDraws : item.draws
      const rate = isTeam ? item.teamedWinRate : item.winRate
      return {
        name: item.nickname || item.playerId,
        games: formatNumber(games),
        wins: formatNumber(wins),
        losses: formatNumber(losses),
        draws: formatNumber(draws),
        winRate: formatPercent(rate),
        rateClass: (rate || 0) >= 0.5 ? 'up' : 'down',
        last: formatRelative(isTeam ? item.lastWinAt : item.lastPlayedAt),
      }
    })

  return {
    title: `${player.nickname || '未知玩家'} · ${isTeam ? '搭档' : '对手'}`,
    kind: `${isTeam ? '同队' : '交手'} ${rows.length} 人`,
    rows,
    tip: isTeam
      ? '按同队场次排序，统计口径来自站点本地数据库'
      : '按交手场次排序，统计口径来自站点本地数据库',
    accent: tierColor(profile.rank?.segment),
    emptyText: isTeam ? '没有记录到同队玩家' : '没有记录到交手玩家',
  }
}

/**
 * 排行榜卡
 * @param {Object} data /api/rankings 的原始响应
 * @param {Object} [meta]
 */
export function buildRankingCard(data, meta = {}) {
  const entries = Array.isArray(data.entries) ? data.entries : []
  const rolesMeta = meta.roles || {}
  // 段位榜的 segment 是填充值，得从分数反推；其余榜单的 segment 要么为空，要么是另一套体系（挑战分 41 等）
  const isStarsBoard = data.rankType?.key === 'stars'

  const rows = entries.map(item => {
    let segment = null
    if (isStarsBoard) {
      segment = segmentFromScore(item.score)
    } else {
      const raw = Number(item.segment)
      if (Number.isFinite(raw) && raw >= 1 && raw <= 30) segment = raw
    }
    return {
      position: formatNumber(item.position),
      name: item.nickname || item.playerId,
      tier: segment ? tierLabel(segment) : '',
      tierColor: segment ? tierColor(segment) : '#6c7178',
      score: formatNumber(item.score),
      delta: formatDelta(item.scoreDelta),
      deltaClass: (item.scoreDelta || 0) > 0 ? 'up' : (item.scoreDelta || 0) < 0 ? 'down' : '',
      games: formatNumber(item.totalGames),
      wins: formatNumber(item.wins),
      totalGames: Number(item.totalGames) || 0,
      // 部分榜单（团队乱斗、挑战）上游不给总场次，这时只显示胜场，避免出现「1,625/0」
      gamesLabel: Number(item.totalGames) > 0
        ? `${formatNumber(item.wins)}/${formatNumber(item.totalGames)}`
        : formatNumber(item.wins),
      winRate: item.totalGames ? formatPercent(item.wins / item.totalGames) : '—',
      region: item.region || '',
      roles: (item.roles || []).map(id => rolesMeta[String(id)] || id).filter(Boolean).join(' / '),
    }
  })

  const typeLabel = data.rankType?.label || '排行榜'
  const metric = data.metricLabel || '分数'
  // 指标本身就是胜场时，"胜/场" 列纯属重复，直接省掉
  const showGames = metric !== '胜场'
  for (const row of rows) {
    if (!showGames) row.gamesLabel = ''
  }
  // 有榜单（挑战榜等）上游不给总场次，那一列就只有胜场，表头跟着改
  const anyTotalGames = rows.some(row => Number(row.totalGames) > 0)
  // 挑战榜/团队榜这类没有段位口径的榜，整列都是「—」，不如不显示
  const showTier = rows.some(row => row.tier)
  return {
    title: typeLabel,
    kind: `${metric} · 第 ${data.start ?? 1}–${data.end ?? rows.length} 名`,
    scoreLabel: metric,
    showGames,
    gamesHeader: anyTotalGames ? '胜/场' : '胜场',
    showTier,
    rows,
    tip: data.day ? `数据日 ${data.day} ｜ 全站共 ${formatNumber(data.total)} 条` : '',
    emptyText: '这个榜单暂时没有数据',
  }
}

/**
 * 单局详情卡
 *
 * 队伍按总击杀降序，胜方在前。每个玩家给 K/D/A、伤害、得分，
 * 并用 isTarget 标出查询的那一位（从最近对局点进来时上游会带上）。
 * @param {Object} detail matchDetail 的原始响应
 * @param {Object} [meta]
 */
export function buildMatchCard(detail, meta = {}) {
  const rolesMeta = meta.roles || {}
  const teams = [...(detail.teams || [])].map(team => {
    const players = [...(team.players || [])].map(item => ({
      name: item.nickname || item.playerId,
      role: item.roleName || rolesMeta[String(item.roleId)] || `角色 ${item.roleId}`,
      kda: `${item.kills ?? 0}/${item.deaths ?? 0}/${item.assists ?? 0}`,
      kills: Number(item.kills) || 0,
      damage: formatNumber(item.damage),
      score: formatNumber(item.score),
      badge: item.mvp ? 'MVP' : item.svp ? 'SVP' : '',
      badgeClass: item.mvp ? 'mvp' : 'svp',
      isTarget: Boolean(item.isTarget),
    }))
    const totalKills = players.reduce((sum, item) => sum + item.kills, 0)
    return {
      label: team.label || team.id || '阵营',
      totalKills,
      totalKillsText: formatNumber(totalKills),
      players: players.sort((a, b) => b.kills - a.kills),
    }
  })
  teams.sort((a, b) => b.totalKills - a.totalKills)

  // 分回合：上游只给「上半场/下半场」两级，且部分对局为空数组
  const rounds = (detail.rounds || []).map(round => ({
    label: round.roundLabel || round.roundTypeKey || '回合',
    players: (round.players || [])
      .map(item => ({
        name: item.nickname || item.playerId,
        role: rolesMeta[String(item.roleId)] || `角色 ${item.roleId}`,
        kda: `${item.kills ?? 0}/${item.deaths ?? 0}/${item.assists ?? 0}`,
        damage: formatNumber(item.damage),
        isTarget: Boolean(item.isTarget),
      }))
      .sort((a, b) => (b.damage === '—' ? 0 : 1) - (a.damage === '—' ? 0 : 1)),
  }))

  const target = teams.flatMap(team => team.players).find(item => item.isTarget)
  const tips = []
  if (!detail.hasDetail) tips.push('站点只对最近若干场保留完整记分板')
  if (!rounds.length) tips.push('这一场没有分回合数据')

  return {
    title: `对局 ${detail.roomId || ''}`.trim(),
    kind: teams.map(team => `${team.label} ${team.totalKillsText} 杀`).join('  ·  ') || '记分板',
    teams,
    rounds,
    target: target ? `${target.name}（${target.role}）${target.kda}` : '',
    tip: tips.join(' ｜ '),
    emptyText: '这一场没有可用的记分板数据',
  }
}

/**
 * 战队卡
 * @param {Array} clans searchClans 的返回
 */
export function buildClanCard(clans) {
  const rows = clans.map(item => ({
    name: item.name || '未知战队',
    id: String(item.clanId || ''),
    level: formatNumber(item.level),
    members: formatNumber(item.memberCount),
    intro: item.intro || '',
  }))
  return {
    title: rows.length === 1 ? rows[0].name : `找到 ${rows.length} 支战队`,
    kind: rows.length === 1 ? `战队 ID ${rows[0].id}` : '',
    rows,
    tip: '站点只提供战队概况，没有成员名单',
    emptyText: '没有找到战队',
  }
}

/**
 * 封神榜卡
 *
 * 上游同时给了原始昵称和打码昵称，这里一律用打码版（maskedNick / maskedId），
 * 避免把封禁记录里的完整身份在群里传播。
 * @param {Object} data bannedPlayers 的返回
 * @param {Object} [options]
 * @param {string} [options.query] 用户查询词，命中时改标题
 */
export function buildBannedCard(data, options = {}) {
  const entries = Array.isArray(data.entries) ? data.entries : []
  const query = String(options.query || '').trim()

  const rows = entries.map(item => {
    const segment = Number(item.segment)
    return {
      name: item.maskedNick || item.nickname || '未知',
      id: item.maskedId || '',
      level: formatNumber(item.level),
      tier: Number.isFinite(segment) && segment >= 1 && segment <= 30 ? tierLabel(segment) : '',
      tierColor: Number.isFinite(segment) && segment >= 1 && segment <= 30 ? tierColor(segment) : '#6c7178',
      source: item.announcementTitle || '',
      date: formatDate(item.publishedAt),
    }
  })

  const tips = []
  if (query) {
    // 站点会忽略它的 query 参数，命中的记录是本地筛出来的，必须说清扫了多少
    if (data.scanned) {
      tips.push(`按 ID/昵称在前 ${formatNumber(data.scanned)} 条记录里筛出`)
    }
    if (data.exhausted === false && data.grandTotal) {
      tips.push(`全榜共 ${formatNumber(data.grandTotal)} 条，未扫完，可能还有漏`)
    }
  } else {
    if (data.total) tips.push(`全站共 ${formatNumber(data.total)} 条封禁记录`)
    if (data.hasMore) tips.push('仅显示前若干条')
  }
  tips.push('玩家 ID 与昵称按站点规则打码')

  return {
    title: query ? `封神榜 · ${query}` : '封神榜',
    kind: rows.length ? (query ? `命中 ${rows.length} 条` : `最近 ${rows.length} 条`) : '',
    rows,
    tip: tips.join(' ｜ '),
    emptyText: query ? `前 ${formatNumber(data.scanned || 0)} 条记录里没有查到「${query}」` : '封神榜暂时没有数据',
  }
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT, DEFAULT_CACHE_TTL }
