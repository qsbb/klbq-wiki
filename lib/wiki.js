/**
 * 卡拉彼丘 Wiki API 客户端与 HTML 解析器
 * 移植自 astrbot_plugin_klbq_wiki/main.py 的 Wiki 请求与解析逻辑
 *
 * 对应关系：
 * - aiohttp.ClientSession -> fetch (Node 18+ 内置)
 * - BeautifulSoup -> cheerio
 * - HTMLParser -> 自定义正则 + cheerio
 * - asyncio.Semaphore -> 简单的并发计数器
 */

import * as cheerio from 'cheerio'
import { FIELD_ALIASES, ROLE_FIELDS, WEAPON_FIELDS } from './aliases.js'

const API_URL = 'https://wiki.biligame.com/klbq/api.php'
const PAGE_URL = 'https://wiki.biligame.com/klbq/{}'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://wiki.biligame.com/klbq/%E9%A6%96%E9%A1%B5',
}

/** HTML 实体解码 */
export function unescapeHtml(text = '') {
  if (!text) return ''
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** HTML 转义 */
export function escapeHtml(text = '') {
  if (text == null) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** URL 编码（保持中文等字符安全） */
function urlEncode(str) {
  return encodeURIComponent(String(str))
}

/** 清理文本：合并空白 */
export function cleanText(text = '') {
  text = unescapeHtml(text)
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]+/g, ' ')
  return text.trim()
}

/** 清理字段标签 */
function cleanLabel(label = '') {
  label = cleanText(label).replace(/[：:]+$/, '')
  label = label.replace(/[[\]（）()]/g, '')
  return label.trim()
}

/** 紧凑值 */
function compactValue(value = '') {
  value = cleanText(value)
  value = value.replace(/- /g, '')
  value = value.replace(/\s*：\s*/g, ':')
  value = value.replace(/\s+/g, ' ')
  return value
}

/**
 * Wiki API 客户端
 */
export class WikiClient {
  /**
   * @param {Object} options
   * @param {import('./image-cache.js').ImageCache} options.imageCache 图片缓存实例（可选）
   */
  constructor(options = {}) {
    this._cache = new Map()
    this._semaphore = 4
    this._active = 0
    this._queue = []
    this._imageCache = options.imageCache || null
  }

  /** 将远程图片 URL 通过缓存转成本地路径（若缓存可用） */
  async _cacheImage(url) {
    if (!url || !this._imageCache) return url
    return await this._imageCache.get(url)
  }

  /** 带并发限制的异步任务调度 */
  async _withSemaphore(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this._active++
        try {
          resolve(await fn())
        } catch (err) {
          reject(err)
        } finally {
          this._active--
          if (this._queue.length > 0) {
            this._queue.shift()()
          }
        }
      }
      if (this._active < this._semaphore) {
        run()
      } else {
        this._queue.push(run)
      }
    })
  }

  /** 读取缓存 */
  _cacheGet(key, ttl = 21600) {
    const entry = this._cache.get(key)
    if (!entry) return null
    if (Date.now() / 1000 - entry.time < ttl) return entry.value
    this._cache.delete(key)
    return null
  }

  /** 写入缓存 */
  _cacheSet(key, value) {
    this._cache.set(key, { time: Date.now() / 1000, value })
    return value
  }

  /** GET 请求 Wiki API */
  async apiGet(params, retries = 2) {
    const url = new URL(API_URL)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v))
    }
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(20000),
        })
        if (!resp.ok) {
          const text = await resp.text()
          logger.warn(`[KlbqWiki] API HTTP ${resp.status}: ${text.slice(0, 200)}`)
          // 5xx 错误可重试，4xx 不重试
          if (resp.status >= 500 && attempt < retries) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
            logger.mark(`[KlbqWiki] API 请求重试 ${attempt + 1}/${retries}`)
            continue
          }
          return null
        }
        return await resp.json()
      } catch (err) {
        lastErr = err
        logger.warn(`[KlbqWiki] API 请求失败 (尝试 ${attempt + 1}/${retries + 1}): ${err}`)
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
          logger.mark(`[KlbqWiki] API 请求重试 ${attempt + 1}/${retries}`)
          continue
        }
      }
    }
    logger.warn(`[KlbqWiki] API 请求最终失败（已重试 ${retries} 次）: ${lastErr}`)
    return null
  }

  /** opensearch 搜索条目 */
  async searchTitle(keyword) {
    const data = await this.apiGet({
      action: 'opensearch',
      format: 'json',
      formatversion: '2',
      search: keyword,
      namespace: '0',
      limit: '1',
    })
    if (Array.isArray(data) && data.length >= 2 && data[1] && data[1].length > 0) {
      return String(data[1][0])
    }
    return null
  }

  /** query 条目摘要与缩略图 */
  async queryPage(title) {
    const data = await this.apiGet({
      action: 'query',
      format: 'json',
      formatversion: '2',
      redirects: '1',
      prop: 'extracts|pageimages',
      titles: title,
      explaintext: '1',
      pithumbsize: '800',
    })
    const pages = (data || {}).query?.pages || []
    if (!pages.length) return null
    if (pages[0].missing) return null
    return pages[0]
  }

  /** parse 条目完整 HTML */
  async queryPageHtml(title) {
    const data = await this.apiGet({
      action: 'parse',
      format: 'json',
      formatversion: '2',
      page: title,
      prop: 'text|displaytitle',
      redirects: '1',
    })
    if (data && typeof data === 'object') {
      return data.parse?.text || null
    }
    return null
  }

  /** 构造页面 URL */
  pageUrl(title) {
    return PAGE_URL.replace('{}', urlEncode(title))
  }

  /** 生成候选标题列表（处理 · 和空格的变体） */
  queryCandidates(title) {
    const candidates = [title]
    if (title.includes('·')) candidates.push(title.replace(/·/g, ''))
    if (title.includes(' ')) candidates.push(title.replace(/ /g, ''))
    return [...new Set(candidates.filter(Boolean))]
  }

  /** 主查询：根据关键词返回页面 */
  async lookup(keyword, aliasMap) {
    // 先尝试 "角色武器"
    const weaponPage = await this.lookupRoleWeapon(keyword, aliasMap)
    if (weaponPage) return weaponPage

    const resolved = aliasMap.get(keyword.toLowerCase()) || keyword
    for (const candidate of this.queryCandidates(resolved)) {
      const page = await this.queryPage(candidate)
      if (page) return page
    }
    const title = await this.searchTitle(resolved)
    if (!title) return null
    return await this.queryPage(title)
  }

  /** 查询角色对应的武器页面 */
  async lookupRoleWeapon(keyword, aliasMap) {
    if (!keyword.endsWith('武器') && !keyword.endsWith('的武器')) return null
    let roleQuery = keyword
    if (roleQuery.endsWith('的武器')) roleQuery = roleQuery.slice(0, -3)
    else if (roleQuery.endsWith('武器')) roleQuery = roleQuery.slice(0, -2)
    roleQuery = roleQuery.trim()
    if (!roleQuery) return null

    const roleTitle = aliasMap.get(roleQuery.toLowerCase()) || roleQuery
    let rolePage = await this.queryPage(roleTitle)
    if (!rolePage) {
      const found = await this.searchTitle(roleTitle)
      rolePage = found ? await this.queryPage(found) : null
    }
    if (!rolePage) return null

    const html = await this.queryPageHtml(rolePage.title || roleTitle)
    const fields = html ? this.extractInfo(html, rolePage.title || roleTitle) : {}
    const weapon = fields['武器']
    return weapon ? await this.queryPage(weapon) : null
  }

  /**
   * 从页面 HTML 中提取结构化字段
   * 移植自 _WikiTableParser + _extract_info
   */
  extractInfo(html, title) {
    if (!html) return { 名称: title }
    const $ = cheerio.load(html)

    const fields = { 名称: title }
    const links = []
    const tables = []

    // 收集所有链接
    $('a').each((_, el) => {
      const text = cleanText($(el).text())
      const href = $(el).attr('href') || ''
      if (text && href) links.push([text, href])
    })

    // 收集所有表格行
    $('table').each((_, table) => {
      const rows = []
      $(table)
        .find('tr')
        .each((_, tr) => {
          const cells = []
          $(tr)
            .find('td, th')
            .each((_, cell) => {
              // 处理 <br> 为换行
              $(cell).find('br').replaceWith('\n')
              const text = cleanText($(cell).text())
              if (text) cells.push(text)
            })
          if (cells.length) rows.push(cells)
        })
      if (rows.length >= 2) tables.push(rows)
    })

    // 从所有行中提取字段
    const allRows = []
    $('tr').each((_, tr) => {
      const cells = []
      $(tr)
        .find('td, th')
        .each((_, cell) => {
          $(cell).find('br').replaceWith('\n')
          const text = cleanText($(cell).text())
          if (text) cells.push(text)
        })
      if (cells.length) allRows.push(cells)
    })

    for (const row of allRows) {
      if (row.length >= 2) {
        const label = cleanLabel(row[0])
        const value = cleanText(row.slice(1).join(' '))
        if (label === '卡拉彼丘画师协会' || label === '画师协会') continue
        if (label && value && !(label in fields)) fields[label] = value
      } else if (row.length === 1 && !('名称' in fields)) {
        fields['名称'] = row[0]
      }
    }

    // 字段别名归一
    for (const [canonical, candidates] of Object.entries(FIELD_ALIASES)) {
      if (canonical in fields) continue
      for (const candidate of candidates) {
        if (candidate in fields) {
          fields[canonical] = fields[candidate]
          break
        }
      }
    }

    // 新版角色页组件（Wiki 改版后角色资料不再是表格）
    this._extractRolePanels($, fields)

    // 武器表格与伤害表格
    this._extractWeaponTables(tables, fields)
    this._extractWeaponFeelText(html, fields)
    const weapon = this._extractWeaponLink(links, title)
    if (weapon && !('武器' in fields)) fields['武器'] = weapon
    return fields
  }

  /**
   * 从新版角色页组件中提取角色资料
   *
   * Wiki 改版后，角色页信息由 klbq-* 组件承载，不再是 <tr><th>/<td> 表格：
   * - .klbq-role-header__name-en / __name-ja    英文名、日文名
   * - .klbq-role-info > span + strong           身份/性别/年龄/生日/身高/体重/活动区域
   * - .klbq-role-badge                          阵营徽章与定位徽章（定位徽章内含 .role-profession）
   * - .klbq-role-trait                          超弦体特性（多个）
   * - .klbq-role-voice__item                    声优（中文/日文）
   * - .klbq-role-lifestyle__item                兴趣爱好、饮食习惯
   * - .klbq-role-quote / .klbq-role-observation  个性语录、观测记录
   * - .klbq-role-info__intro-text               简介
   * - .klbq-weapon-card-mini                    角色武器与武器类型
   * 仅在字段为空时写入，不覆盖表格解析结果
   */
  _extractRolePanels($, fields) {
    const set = (key, value) => {
      const text = cleanText(value)
      if (text && !fields[key]) fields[key] = text
    }
    // 取出元素文本，忽略内嵌的 style/script（Wiki 会把 CSS 塞进组件里）
    const panelText = (el) => {
      const clone = $(el).clone()
      clone.find('style, script').remove()
      return cleanText(clone.text())
    }
    // 组件文本形如 "标签值"，去掉开头的标签得到值
    const valueAfterLabel = (el, label) => {
      const full = panelText(el)
      if (!label) return full
      return full.startsWith(label) ? full.slice(label.length).trim() : full
    }

    // 英文名 / 日文名
    set('英文名', $('.klbq-role-header__name-en').first().text())
    set('日文名', $('.klbq-role-header__name-ja').first().text())

    // 基础信息（身份/性别/年龄/生日/身高/体重/活动区域）
    $('.klbq-role-info').each((_, el) => {
      const node = $(el)
      const label = cleanLabel(node.find('span').first().text())
      const value = cleanText(node.find('strong').first().text())
      if (label && value) set(label, value)
    })

    // 阵营徽章与定位徽章
    $('.klbq-role-badge').each((_, el) => {
      const node = $(el)
      const isProfession = node.find('.role-profession').length > 0
        || /定位/.test(String(node.find('a').first().attr('title') || ''))
      const text = panelText(el)
      if (!text) return
      if (isProfession) set('定位', text)
      else set('阵营', text)
    })

    // 超弦体特性（◆ 前缀，多条合并）
    const traits = []
    $('.klbq-role-trait').each((_, el) => {
      const text = panelText(el).replace(/^[◆◇\s]+/, '')
      if (text) traits.push(text)
    })
    if (traits.length) set('超弦体特性', traits.join('、'))

    // 声优（中文/日文）
    const voices = []
    $('.klbq-role-voice__item').each((_, el) => {
      const node = $(el)
      const lang = cleanLabel(node.find('span').first().text())
      const name = valueAfterLabel(el, lang)
      if (name) voices.push(lang ? `${lang} ${name}` : name)
    })
    if (voices.length) set('声优', voices.join(' / '))

    // 兴趣爱好、饮食习惯
    $('.klbq-role-lifestyle__item').each((_, el) => {
      const label = cleanLabel($(el).find('span').first().text())
      const value = valueAfterLabel(el, label)
      if (label && value) set(label, value)
    })

    // 个性语录与观测记录
    const quote = cleanText($('.klbq-role-quote__text').first().text())
    const author = cleanText($('.klbq-role-quote__author').first().text())
    if (quote) set('个性语录', author ? `${quote} ${author}` : quote)
    set('观测语录', $('.klbq-role-observation__text').first().text())

    // 简介：角色页简介区块优先于其他来源
    const intro = cleanText($('.klbq-role-info__intro-text').first().text())
    if (intro) fields['简介'] = intro

    // 角色武器与武器类型
    set('武器', $('.klbq-weapon-card-mini__name').first().text())
    set('武器类型', $('.klbq-weapon-card-mini__type').first().text())
  }

  /** 从武器表格中提取伤害与系数 */
  _extractWeaponTables(tables, fields) {
    for (const table of tables) {
      if (table.length < 2) continue
      const header = table[0].map(c => cleanLabel(c))
      const headerSet = new Set(header)
      if (isSubset(new Set(['头部', '上肢', '下肢']), headerSet)) {
        this._extractDamageTable(table, fields)
      } else if (table.some(row => row.join(' ').includes('基础伤害'))) {
        this._extractCoefficientTable(table, fields)
      }
    }
  }

  _extractDamageTable(table, fields) {
    const header = table[0].map(c => cleanLabel(c))
    for (const row of table.slice(1)) {
      if (row.length < 4 || !/\d+\s*米/.test(row[0])) continue
      const distance = row[0].replace(/\s+/g, '')
      const parts = []
      for (let i = 0; i < header.length - 1 && i + 1 < row.length; i++) {
        parts.push(`${header[i + 1]} ${compactValue(row[i + 1])}`)
      }
      fields[`${distance}伤害`] = parts.join('；')
    }
  }

  _extractCoefficientTable(table, fields) {
    const flat = []
    for (const row of table) {
      for (const cell of row) {
        const t = cleanText(cell)
        if (t) flat.push(t)
      }
    }
    for (let i = 0; i < flat.length; i++) {
      const cell = flat[i]
      if (cell === '基础伤害' && i + 1 < flat.length) {
        if (!('基础伤害' in fields)) fields['基础伤害'] = flat[i + 1]
      } else if (['头部', '上肢', '下肢'].includes(cell) && i + 1 < flat.length) {
        if (!('部位系数' in fields)) fields['部位系数'] = ''
        fields['部位系数'] = (fields['部位系数'] + ` ${cell} ${flat[i + 1]}；`).trim()
      }
    }
  }

  /** 从武器感受文本中正则提取时间字段 */
  _extractWeaponFeelText(html, fields) {
    let text = html.replace(/<br\s*\/?>/gi, '\n')
    text = text.replace(/<[^>]+>/g, ' ')
    text = cleanText(text)
    const patterns = {
      拉栓时间: /拉栓时间[:：]\s*([^\s]+秒)/,
      后坐力恢复时间: /后坐力恢复时间[:：]\s*([^\s]+秒)/,
      蓄力时间: /蓄力时间[:：]\s*([^\s]+秒)/,
      等待开镜时间: /等待开镜时间[:：]\s*([^\s]+秒)/,
      初段蓄力时间: /初段蓄力时间[:：]\s*([^\s]+秒)/,
      完成蓄力时间: /完成蓄力时间[:：]\s*([^\s]+秒)/,
      卸弹匣时间: /卸弹匣[:：]\s*([^\s]+秒)/,
      装弹匣时间: /装弹匣[:：]\s*([^\s]+秒)/,
      上膛结束时间: /上膛\/结束[:：]\s*([^\s]+秒)/,
    }
    for (const [label, pattern] of Object.entries(patterns)) {
      const m = text.match(pattern)
      if (m) fields[label] = m[1]
    }
    const reloadParts = []
    if (fields['卸弹匣时间']) reloadParts.push(`卸弹匣 ${fields['卸弹匣时间']}`)
    if (fields['装弹匣时间']) reloadParts.push(`装弹匣 ${fields['装弹匣时间']}`)
    if (fields['上膛结束时间']) reloadParts.push(`上膛/结束 ${fields['上膛结束时间']}`)
    if (reloadParts.length) fields['换弹动作时间'] = reloadParts.join('；')
  }

  /** 从链接列表中提取武器页面标题 */
  _extractWeaponLink(links, title) {
    const skipTexts = new Set([title, '首页', '语音', '画廊', '誓约', '档案馆'])
    for (let i = 0; i < Math.min(80, links.length); i++) {
      const [text, href] = links[i]
      if (text === '武器') {
        const target = this._titleFromHref(href)
        if (target && target !== title) return target
        if (i + 1 < links.length) return links[i + 1][0]
      }
    }
    for (const [text, href] of links.slice(0, 80)) {
      if (skipTexts.has(text) || text === '武器') continue
      if (href.startsWith('/klbq/') && !href.includes('action=edit') && !href.includes('分类:')) {
        return text
      }
    }
    return ''
  }

  _titleFromHref(href) {
    if (!href.startsWith('/klbq/')) return ''
    let t = href.slice('/klbq/'.length).split('#')[0].split('?')[0]
    if (!t || t.startsWith('分类:')) return ''
    return decodeURIComponent(t).replace(/_/g, ' ').trim()
  }

  /** 判断页面是否为武器 */
  isWeapon(fields, title) {
    // 角色页带有这些字段时优先判定为角色：
    // 角色页也会给出"武器类型"（如 狙击步枪），否则会被误判为武器页
    const roleOnlyFields = ['性别', '生日', '身份', '定位', '阵营', '声优', '身高', '体重', '年龄', '超弦体特性']
    if (roleOnlyFields.some((key) => fields[key])) return false
    const markers = [title, fields['武器类型'] || '', fields['类型'] || '', fields['弹匣容量'] || '', fields['射速'] || ''].join(' ')
    return ['步枪', '冲锋枪', '机枪', '霰弹枪', '手枪', '武器', '射速', '弹匣'].some(w => markers.includes(w))
  }

  /** 为输出准备字段列表 */
  itemsForOutput(fields, isWeapon) {
    const template = isWeapon ? WEAPON_FIELDS : ROLE_FIELDS
    const items = []
    for (const label of template) {
      let value = fields[label]
      if (value) {
        if (value.length > 260) value = value.slice(0, 260).replace(/\s+$/, '') + '...'
        items.push({ label, value })
      }
    }
    return items.slice(0, 24)
  }

  /** 文本输出 */
  textOutput(title, items, tip = '') {
    const lines = [`卡拉彼丘 Wiki：${title}`, '']
    for (const item of items) lines.push(`${item.label}：${item.value}`)
    if (tip) lines.push('', tip)
    return lines.join('\n')
  }

  /** 获取分类下的所有页面 */
  async categoryMembers(category) {
    const members = []
    let cmcontinue = ''
    while (true) {
      const params = {
        action: 'query',
        format: 'json',
        formatversion: '2',
        list: 'categorymembers',
        cmtitle: `分类:${category}`,
        cmnamespace: '0',
        cmlimit: 'max',
      }
      if (cmcontinue) params.cmcontinue = cmcontinue
      const data = await this.apiGet(params)
      if (!data) throw new Error(`无法读取分类:${category}`)
      for (const item of data.query?.categorymembers || []) {
        if (item.title) members.push(item.title)
      }
      cmcontinue = data.continue?.cmcontinue || ''
      if (!cmcontinue) return members.filter(n => n)
    }
  }

  /** 解析角色生日 */
  parseBirthday(html) {
    if (!html) return null
    const $ = cheerio.load(html)
    let text = ''

    // 新版角色页：<div class="klbq-role-info"><span>生日</span><strong>12月12日</strong></div>
    $('.klbq-role-info').each((_, el) => {
      const node = $(el)
      if (cleanLabel(node.find('span').first().text()) !== '生日') return
      const value = cleanText(node.find('strong').first().text())
      if (value) {
        text = value
        return false
      }
    })

    // 旧版页面：itemprop 标记
    if (!text) {
      const cell = $('td[itemprop=birthDate]').first()
      if (cell.length) text = cell.text().trim()
    }

    // 旧版页面：表格行
    if (!text) {
      $('tr').each((_, tr) => {
        const cells = $(tr).find('th, td')
        if (cells.length >= 2 && cleanLabel($(cells[0]).text()) === '生日') {
          text = $(cells[1]).text().trim()
          return false
        }
      })
    }

    let m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
    if (!m) m = text.match(/(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/)
    if (!m) return null
    const month = Number(m[1])
    const day = Number(m[2])
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
    return [month, day]
  }

  /** 获取所有角色生日列表 */
  async birthdays() {
    const cached = this._cacheGet('birthdays')
    if (cached) return cached
    const names = await this.categoryMembers('超弦体')

    const load = async (name) => {
      return this._withSemaphore(async () => {
        const html = await this.queryPageHtml(name)
        const birthday = html ? this.parseBirthday(html) : null
        return birthday ? { name, month: birthday[0], day: birthday[1] } : null
      })
    }

    const results = await Promise.all(names.map(load))
    const rows = results.filter(Boolean)
    return this._cacheSet('birthdays', rows)
  }

  /** 增强缩略图：从页面中找到更好的图片 URL */
  async enhanceThumb(title, html, fields, fallback) {
    try {
      const $ = cheerio.load(html)
      const weapon = this.isWeapon(fields, title)
      const filenames = []
      if (weapon) {
        const user = fields['使用者'] || fields['归属角色'] || fields['角色']
        if (user) filenames.push(`${user}-weapon.png`)
        const scopes = $('.weapon-table').length ? $('.weapon-table') : $('table')
        scopes.find('img').each((_, img) => {
          const name = $(img).attr('alt') || ''
          if (name) filenames.push(name)
        })
      } else {
        const excluded = ['生日', '壁纸', '表情', '模型']
        $('img').each((_, img) => {
          const name = decodeURIComponent($(img).attr('alt') || '')
          if (title.includes(name) || name.includes(title)) {
            if (name.includes('立绘') && !excluded.some(w => name.includes(w))) {
              filenames.push(name)
            }
          }
        })
        // 从分类中查找
        const category = await this.apiGet({
          action: 'query',
          format: 'json',
          formatversion: '2',
          generator: 'categorymembers',
          gcmtitle: `分类:${title}`,
          gcmnamespace: '6',
          gcmlimit: 'max',
          prop: 'imageinfo',
          iiprop: 'url',
        })
        const urls = []
        for (const page of category?.query?.pages || []) {
          const name = (page.title || '').replace(/^文件:/, '')
          const info = page.imageinfo || []
          if (name.includes(title) && name.includes('立绘')) {
            if (!['生日', '壁纸', '表情', '模型'].some(w => name.includes(w)) && info.length) {
              urls.push(info[0].url || '')
            }
          }
        }
        const validUrls = urls.filter(Boolean)
        if (validUrls.length) {
          return await this._cacheImage(validUrls[Math.floor(Math.random() * validUrls.length)])
        }
      }
      const urlMap = await this.imageUrls(filenames)
      const urls = [...urlMap.values()]
      if (urls.length) {
        const picked = weapon ? urls[0] : urls[Math.floor(Math.random() * urls.length)]
        return await this._cacheImage(picked)
      }
    } catch (err) {
      logger.warn(`[KlbqWiki] 增强图片获取失败: ${err}`)
    }
    return await this._cacheImage(fallback)
  }

  /**
   * 获取角色的随机立绘 URL（不依赖页面 HTML，直接走分类查询）
   * 用于生日卡片等只需要角色立绘的场景
   * @param {string} title 角色名
   * @returns {Promise<string|null>} 立绘 URL，失败返回 null
   */
  async getCharacterArt(title) {
    try {
      const category = await this.apiGet({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'categorymembers',
        gcmtitle: `分类:${title}`,
        gcmnamespace: '6',
        gcmlimit: 'max',
        prop: 'imageinfo',
        iiprop: 'url',
      })
      const urls = []
      const excluded = ['生日', '壁纸', '表情', '模型', '头像', '图标', '武器', '皮肤', '宿舍', 'cg', 'CG']
      for (const page of category?.query?.pages || []) {
        const name = (page.title || '').replace(/^文件:/, '')
        const info = page.imageinfo || []
        if (name.includes(title) && name.includes('立绘')) {
          if (!excluded.some((w) => name.includes(w)) && info.length) {
            urls.push(info[0].url || '')
          }
        }
      }
      const validUrls = urls.filter(Boolean)
      if (validUrls.length) {
        return await this._cacheImage(validUrls[Math.floor(Math.random() * validUrls.length)])
      }
    } catch (err) {
      logger.warn(`[KlbqWiki] 获取角色立绘失败: ${err}`)
    }
    return null
  }

  /**
   * 批量预下载所有角色的立绘和皮肤图到本地缓存
   * @param {Object} hooks 进度回调
   * @param {(total: number) => void} hooks.onStart 开始时回调（角色总数）
   * @param {(role: string, idx: number, total: number, ok: number, fail: number) => void} hooks.onRole 每个角色完成时回调
   * @returns {Promise<{ roles: number, arts: number, skins: number, ok: number, fail: number }>}
   */
  async fetchAllResources(hooks = {}) {
    const result = { roles: 0, arts: 0, skins: 0, ok: 0, fail: 0 }
    let roleNames = []
    try {
      roleNames = await this.categoryMembers('超弦体')
    } catch (err) {
      logger.warn(`[KlbqWiki] 获取角色列表失败: ${err}`)
      return result
    }
    result.roles = roleNames.length
    if (hooks.onStart) hooks.onStart(roleNames.length)

    for (let i = 0; i < roleNames.length; i++) {
      const role = roleNames[i]
      let roleOk = 0
      let roleFail = 0

      // 1. 角色立绘
      try {
        const art = await this.getCharacterArt(role)
        if (art && !art.startsWith('http')) {
          result.arts++
          roleOk++
        } else if (art) {
          // 回退到远程 URL 算失败
          roleFail++
        }
      } catch (_) {
        roleFail++
      }

      // 2. 皮肤图：解析角色页面的皮肤列表，逐个获取
      try {
        const html = await this.queryPageHtml(role)
        const skins = this.parseSkins(html)
        for (const skin of skins) {
          try {
            const urls = await this.skinImages(role, skin.name)
            result.skins += urls.length
            for (const u of urls) {
              if (u && !u.startsWith('http')) roleOk++
              else if (u) roleFail++
            }
          } catch (_) {
            // 单个皮肤失败跳过
          }
        }
      } catch (_) {
        // 角色页面获取失败跳过
      }

      result.ok += roleOk
      result.fail += roleFail
      if (hooks.onRole) hooks.onRole(role, i + 1, roleNames.length, roleOk, roleFail)
    }

    return result
  }

  /** 批量获取文件图片 URL */
  async imageUrls(filenames) {
    const result = new Map()
    const titles = [...new Set(filenames.filter(Boolean).map(n => `文件:${n.replace(/^文件:/, '')}`))]
    for (let i = 0; i < titles.length; i += 50) {
      const chunk = titles.slice(i, i + 50)
      const data = await this.apiGet({
        action: 'query',
        format: 'json',
        formatversion: '2',
        redirects: '1',
        prop: 'imageinfo',
        iiprop: 'url',
        titles: chunk.join('|'),
      })
      if (!data) continue
      for (const page of data.query?.pages || []) {
        const info = page.imageinfo || []
        if (info.length && info[0].url) {
          const filename = (page.title || '').replace(/^文件:/, '')
          result.set(filename, info[0].url)
          result.set(filename.replace(' 背面', '_背面'), info[0].url)
        }
      }
    }
    return result
  }

  /** 解析皮肤列表 */
  parseSkins(html) {
    if (!html) return []
    const $ = cheerio.load(html)
    const group = $('.klbq-skin-group').first()
    if (!group.length) return []

    const qualityNames = {
      '0': '默认',
      '1': '普通',
      '2': '稀有',
      '3': '卓越',
      '4': '完美',
      '5': '传说',
      '6': '私服',
    }
    const qualities = {}
    group.find('li[data-quality]').each((_, li) => {
      const q = qualityNames[$(li).attr('data-quality')] || $(li).attr('data-quality') || '未知'
      $(li)
        .find('a[href^="#skin_pane_"]')
        .each((_, a) => {
          qualities[cleanText($(a).text())] = q
        })
    })

    const skins = []
    group.find('.tab-pane[id^="skin_pane_"]').each((_, pane) => {
      const id = $(pane).attr('id') || ''
      const name = cleanText(id.replace(/^skin_pane_/, '').replace(/_/g, ' '))
      if (!name) return
      const text = cleanText($(pane).text())
      let obtain = ''
      let intro = ''
      $(pane)
        .find('tr')
        .each((_, tr) => {
          const cells = $(tr).find('th, td')
          if (cells.length >= 2) {
            const label = cleanLabel($(cells[0]).text())
            const value = cleanText($(cells[1]).text())
            if (label.includes('获得') || label.includes('获取')) obtain = value
            else if (label.includes('介绍') || label.includes('描述')) intro = value
          }
        })
      skins.push({
        name,
        quality: qualities[name] || '未知',
        intro,
        obtain,
        text,
      })
    })
    return skins
  }

  /** 从 Wiki 文件链接或图片节点提取文件名 */
  _imageFilename($, scope) {
    const anchor = scope.is('a') ? scope : scope.closest('a.image')
    const href = anchor.attr('href') || ''
    try {
      const decoded = decodeURIComponent(href).replace(/_/g, ' ')
      const marker = decoded.indexOf('文件:')
      if (marker >= 0) return decoded.slice(marker + 3).split(/[?#]/)[0]
    } catch (_) {
      // URL 解码失败时回退 alt
    }
    const img = scope.is('img') ? scope : scope.find('img').first()
    return cleanText(img.attr('alt') || '').replace(/^文件:/, '')
  }

  /** 解析角色技能，并将技能图标转为可渲染的本地缓存路径 */
  async roleSkills(role, html = '') {
    if (!html) html = await this.queryPageHtml(role)
    if (!html) return []
    const $ = cheerio.load(html)
    const heading = $('#角色技能').closest('h2')
    if (!heading.length) return []
    const section = heading.nextUntil('h2')
    let table = section.find('.resp-tabs-container > .resp-tab-content').first().find('table.role-skill-table').first()
    if (!table.length) table = section.find('table.role-skill-table').first()
    if (!table.length) return []

    const skills = []
    table.find('tr').each((_, tr) => {
      const row = $(tr)
      const nameCell = row.children('td.skill-name').first()
      const infoCell = row.children('td.skill-info').first()
      if (!nameCell.length || !infoCell.length) return
      const name = cleanText(nameCell.clone().find('a.image, img').remove().end().text())
      const description = cleanText(infoCell.text())
      const type = cleanText(row.prevAll('tr').first().find('th').text()) || '角色技能'
      const imageNode = nameCell.find('a.image, img').first()
      const iconFile = this._imageFilename($, imageNode)
      if (name && description) skills.push({ type, name, description, iconFile, icon: '' })
    })

    const urls = await this.imageUrls(skills.map((item) => item.iconFile))
    for (const item of skills) {
      const remote = urls.get(item.iconFile) || ''
      item.icon = remote ? await this._cacheImage(remote) : ''
    }
    return skills
  }

  /** 解析角色觉醒效果：按游戏模式分组，含激活消耗与描述，各模式内容相同时合并 */
  async roleAwakenings(role, html = '') {
    if (!html) html = await this.queryPageHtml(role)
    if (!html) return []
    const $ = cheerio.load(html)
    const heading = $('#弦能增幅网络').closest('h2')
    if (!heading.length) return []
    const section = heading.nextUntil('h2')

    // 消耗点按背景色归类：蓝/橙/绿（Wiki 模板固定三色）
    const colorName = (style) => {
      const m = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(style || '')
      if (!m) return ''
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      if (b > 200 && r < 180) return { cls: 'blue', name: '蓝' }
      if (r > 200 && g > 120 && g < 210 && b < 100) return { cls: 'orange', name: '橙' }
      if (g > 180 && r > 100 && r < 180 && b < 150) return { cls: 'green', name: '绿' }
      return ''
    }

    const parseTable = (table) => {
      const $t = $(table)
      const costs = []
      $t.find('tr').first().find('span.label').each((_, sp) => {
        const $sp = $(sp)
        const color = colorName($sp.attr('style'))
        const value = cleanText($sp.text())
        if (color && /^\d+$/.test(value)) {
          costs.push({ ...color, value, zero: value === '0' })
        }
      })
      const trs = $t.find('tr').toArray()
      for (let i = 0; i < trs.length; i++) {
        const m = cleanText($(trs[i]).text()).match(/^觉醒\s*(\d+)\s*[：:]?$/)
        if (!m) continue
        const name = i + 1 < trs.length ? cleanText($(trs[i + 1]).text()) : ''
        const description = i + 2 < trs.length ? cleanText($(trs[i + 2]).text()) : ''
        if (!name || !description) return null
        return { index: m[1], name, description, costs, hasCosts: costs.length > 0 }
      }
      return null
    }

    const parsePanel = (scope) => {
      const awakenings = []
      scope.find('table').each((_, table) => {
        if (!/觉醒\s*\d/.test($(table).text())) return
        const item = parseTable(table)
        if (item && !awakenings.some((a) => a.index === item.index)) awakenings.push(item)
      })
      awakenings.sort((a, b) => Number(a.index) - Number(b.index))
      return awakenings
    }

    const groups = []
    const container = section.find('.resp-tabs-container').first()
    if (container.length) {
      const tabs = container.prev('.resp-tabs-list').length
        ? container.prev('.resp-tabs-list')
        : section.find('.resp-tabs-list').first()
      const names = tabs.find('li').map((_, li) => cleanText($(li).text())).get()
      let panels = container.children('.resp-tab-content')
      if (!panels.length) panels = container.find('.resp-tab-content')
      panels.each((idx, panel) => {
        const awakenings = parsePanel($(panel))
        if (awakenings.length) groups.push({ mode: names[idx] || '', awakenings })
      })
    }
    // 无标签页结构时，把整个章节视为一组
    if (!groups.length) {
      const awakenings = parsePanel(section)
      if (awakenings.length) groups.push({ mode: '', awakenings })
    }

    // 各模式觉醒内容一致时合并为一组，展示更紧凑
    const signature = (g) => JSON.stringify(g.awakenings)
    if (groups.length > 1 && groups.every((g) => signature(g) === signature(groups[0]))) {
      return [{ mode: '', awakenings: groups[0].awakenings }]
    }
    return groups.filter((g) => g.awakenings.length)
  }

  /** 解析"地图"总览页：按模式分组返回地图名称与缩略图 */
  async mapModes() {
    const cached = this._cacheGet('map_modes', 21600)
    if (cached) return cached
    const html = await this.queryPageHtml('地图')
    if (!html) throw new Error('无法获取"地图"页面')

    const $ = cheerio.load(html)
    const modes = []
    $('.mw-parser-output').find('h2, h3').each((_, el) => {
      const heading = $(el)
      const mode = cleanText(heading.find('.mw-headline').first().text())
      if (!mode || !/模式/.test(mode)) return
      const maps = []
      heading.nextUntil('h2, h3').filter('.nav-chara').find('a[title]').each((__, a) => {
        const node = $(a)
        const name = cleanText(node.attr('title') || '')
        if (!name || maps.some((m) => m.name === name)) return
        const img = node.find('img').first()
        // 取 300px 缩略图地址，渲染卡片足够清晰且下载快
        const src = img.attr('src') || ''
        maps.push({ name, image: src })
      })
      if (maps.length) modes.push({ mode, maps })
    })

    // 缩略图批量转本地缓存路径，避免大量图片串行下载
    const maps = modes.flatMap((group) => group.maps).filter((map) => map.image)
    if (this._imageCache && maps.length) {
      const localImages = await this._imageCache.getMany(maps.map((map) => map.image))
      maps.forEach((map, index) => { map.image = localImages[index] })
    }
    return this._cacheSet('map_modes', modes)
  }

  /** 解析地图资料、地形图及地图概览图片 */
  async mapInfo(title, html = '', fallbackDescription = '') {
    if (!html) html = await this.queryPageHtml(title)
    if (!html) return null
    const $ = cheerio.load(html)
    const terrainHeading = $('#地形图').closest('h2')
    const galleryHeading = $('#地图概览').closest('h2')
    if (!terrainHeading.length && !galleryHeading.length) return null

    const modes = []
    const platforms = []
    $('.wiki-jump-btn a').each((_, a) => {
      const text = cleanText($(a).text())
      if (!text) return
      if (/PC|移动|安卓|iOS/i.test(text)) platforms.push(text)
      else modes.push(text)
    })

    const collectFiles = (heading, selector = 'a.image') => {
      const files = []
      if (!heading.length) return files
      heading.nextUntil('h2').find(selector).each((_, node) => {
        const file = this._imageFilename($, $(node))
        if (file && !files.includes(file)) files.push(file)
      })
      return files
    }
    const terrainFiles = collectFiles(terrainHeading)
    const galleryFiles = collectFiles(galleryHeading, '.bwiki-swiper .swiper-slide a.image, a.image')
    const allFiles = [...new Set([...terrainFiles, ...galleryFiles])]
    const urls = await this.imageUrls(allFiles)
    const resolveImages = async (files) => {
      const images = []
      for (const file of files) {
        const remote = urls.get(file) || ''
        if (remote) images.push(await this._cacheImage(remote))
      }
      return images
    }

    let description = cleanText(fallbackDescription || '')
    if (!description) {
      // 该 Wiki 的 API 不支持 extracts 参数，fallback 恒为空；
      // 改从页面"简介"章节提取首个非空段落
      const introHeading = $('#简介').closest('h2')
      if (introHeading.length) {
        introHeading.nextUntil('h2').each((_, el) => {
          if (description || el.tagName !== 'p') return
          const clone = $(el).clone()
          clone.find('style, script').remove()
          description = cleanText(clone.text())
        })
      }
    }
    if (description.length > 300) description = description.slice(0, 300).replace(/\s+$/, '') + '...'
    return {
      title,
      description,
      modes: [...new Set(modes)],
      platforms: [...new Set(platforms)],
      terrain: await resolveImages(terrainFiles),
      gallery: await resolveImages(galleryFiles),
    }
  }

  /** 获取皮肤图片（优先本地缓存） */
  async skinImages(role, skin) {
    const names = [`${role}时装-${skin}.jpg`, `${role}时装-${skin}_背面.jpg`, `${role}-${skin}立绘.png`]
    const urls = await this.imageUrls(names)
    const remoteUrls = []
    for (const name of names) {
      if (urls.has(name)) remoteUrls.push(urls.get(name))
    }
    // 通过缓存批量转成本地路径，避免每次查询重复下载
    if (this._imageCache && remoteUrls.length) {
      return await this._imageCache.getMany(remoteUrls)
    }
    return remoteUrls
  }

  /** 获取兑换码列表：提取月份、兑换码、奖励和有效期，过滤明确失效的条目 */
  async redeemCodes() {
    const cached = this._cacheGet('redeem_codes', 1800)
    if (cached) return cached
    const html = await this.queryPageHtml('兑换码')
    if (!html) throw new Error('无法获取"兑换码"页面')

    const $ = cheerio.load(html)
    const now = new Date()
    const rows = []
    let section = ''

    $('.mw-parser-output').children().each((_, el) => {
      const node = $(el)
      if (el.tagName === 'h2') {
        section = cleanText(node.find('.mw-headline').first().text() || node.text()).replace(/\[编辑\]$/, '')
        return
      }
      node.find('.cdkey-entry-card').each((__, card) => {
        const item = $(card)
        const code = cleanText(item.find('.cdkey-entry-card__code').first().text())
        const reward = cleanText(item.find('.cdkey-entry-card__rewards').first().text()) || '奖励未知'
        const timeText = cleanText(item.find('.cdkey-entry-card__time').first().text()).replace(/^有效期至[：:]?\s*/, '')
        if (!code || /失效|过期/i.test(timeText)) return

        let expired = false
        const m = timeText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{1,2}))?/)
        if (m) {
          const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 23), Number(m[5] || 59), 59)
          expired = end.getTime() < now.getTime()
        }
        if (!expired) rows.push({ section, code, reward, expires: timeText || '未知' })
      })
    })

    // 页面可能在不同月份重复收录同一兑换码，保留最新出现的一条
    const unique = []
    const seen = new Set()
    for (const row of rows) {
      const key = row.code.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(row)
    }
    return this._cacheSet('redeem_codes', unique)
  }

  /**
   * 角色语音：解析"<角色>/语音台词"页面
   *
   * 页面按分类（宿舍/对局/时装…）分节，每节一个 .voice-table：
   *   <th rowspan="3">场景名</th> 后跟 中/日/英 三行，每行含
   *   隐藏 a.internal（音频直链）与台词文本 td（日文/英文行带 lang 属性）
   *
   * @param {string} role 角色条目标题（如"心夏"、"米雪儿·李"）
   * @returns {Promise<Array<{category:string,voices:Array<{scene:string,lang:string,text:string,file:string}>}>>}
   */
  async roleVoices(role) {
    const cached = this._cacheGet(`voices:${role}`)
    if (cached) return cached
    const html = await this.queryPageHtml(`${role}/语音台词`)
    if (!html) return null

    const $ = cheerio.load(html)
    const groups = []
    $('.mw-parser-output .voice-table').each((_, table) => {
      const $table = $(table)
      const heading = $table.prevAll('h2').first()
      const category = cleanText(heading.find('.mw-headline').first().text() || heading.text())
      const voices = []
      let scene = ''
      $table.find('tr').each((_, tr) => {
        const row = $(tr)
        const th = row.find('th').first()
        if (th.length) scene = cleanText(th.text())
        const tds = row.find('td')
        if (tds.length < 2) return
        const textTd = tds.last()
        const langAttr = String(textTd.attr('lang') || '').toLowerCase()
        const file = row.find('a.internal').first().attr('href') || ''
        let lang = 'CN'
        if (langAttr.startsWith('ja')) lang = 'JP'
        else if (langAttr.startsWith('en')) lang = 'EN'
        else if (/\sJP\./i.test(file)) lang = 'JP'
        else if (/\sEN\./i.test(file)) lang = 'EN'
        const text = cleanText(textTd.text())
        if (!text && !file) return
        voices.push({ scene, lang, text, file })
      })
      if (voices.length) groups.push({ category, voices })
    })
    return this._cacheSet(`voices:${role}`, groups)
  }

  /**
   * 公告列表：解析"公告资讯"页
   * 页面用 .klbq-notice-item 罗列公告，按年份分节、节内从新到旧；
   * 这里统一按发布日期倒序排序，保证序号 1 始终是最新公告。
   * @returns {Promise<Array<{title:string,date:string}>>}
   */
  async announcements() {
    const cached = this._cacheGet('announcements', 1800)
    if (cached) return cached
    const html = await this.queryPageHtml('公告资讯')
    if (!html) throw new Error('无法获取"公告资讯"页面')

    const $ = cheerio.load(html)
    const rows = []
    const seen = new Set()
    $('.klbq-notice-item').each((_, el) => {
      const item = $(el)
      const title = cleanText(item.find('.klbq-notice-item__title a').first().text())
        || cleanText(item.find('.klbq-notice-item__title').first().text())
      if (!title || seen.has(title)) return
      seen.add(title)
      const date = cleanText(item.find('.klbq-notice-item__time').first().text())
      rows.push({ title, date, time: parseNoticeDate(date) })
    })

    const list = rows
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .map(({ title, date }) => ({ title, date }))
    return this._cacheSet('announcements', list)
  }

  /**
   * 公告详情：解析单条公告页面
   * 结构：.klbq-notice-header（类型/发布时间/发布渠道）+ .mw-parser-output 正文
   * 正文按块返回，保留标题层级，去掉目录、编辑链接、导航与样式
   * @param {string} title 公告条目标题
   * @returns {Promise<{title:string,tag:string,published:string,blocks:Array<{type:string,text:string}>}|null>}
   */
  async announcementDetail(title) {
    const html = await this.queryPageHtml(title)
    if (!html) return null

    const $ = cheerio.load(html)
    const tag = cleanText($('.klbq-notice-header__tag').first().text())
    const published = cleanText($('.klbq-notice-header__time').first().text()).replace(/^发布于\s*/, '')

    const content = $('.mw-parser-output').first().clone()
    content
      .find('.klbq-breadcrumb-bar, #toc, .toc, .mw-editsection, .klbq-notice-header, .navbox, .klbq-navbox, .noprint, style, script')
      .remove()

    const blocks = []
    const push = (type, text) => {
      const value = cleanText(text)
      if (!value) return
      const last = blocks[blocks.length - 1]
      if (last && last.type === type && last.text === value) return
      blocks.push({ type, text: value })
    }

    content.find('h1, h2, h3, h4, h5, p, li').each((_, el) => {
      const node = $(el)
      if (/^h[1-5]$/.test(el.tagName)) {
        push('heading', node.find('.mw-headline').first().text() || node.text())
        return
      }
      if (el.tagName === 'li') {
        // 去掉嵌套列表，只保留本层级文本（子项会各自成为一条）
        const clone = node.clone()
        clone.find('ul, ol').remove()
        push('item', clone.text())
        return
      }
      // p：跳过含块级子元素的容器
      if (node.find('p, li, h1, h2, h3, h4, h5').length) return
      push('text', node.text())
    })

    return { title, tag, published, blocks }
  }

  /** 获取喵言喵语列表 */
  async catLanguageLines() {
    const cached = this._cacheGet('cat_language')
    if (cached) return cached
    const html = await this.queryPageHtml('喵言喵语')
    if (!html) throw new Error('无法获取"喵言喵语"页面')
    const $ = cheerio.load(html)
    let nodes = $('.CatLanguage > ul > li')
    if (!nodes.length) nodes = $('.CatLanguage li')
    const lines = []
    nodes.each((_, li) => {
      $(li).find('sup.reference').remove()
      const text = cleanText($(li).text())
      if (text) lines.push(text)
    })
    this._cacheSet('cat_language', lines)
    return lines
  }

  /** 获取赛季信息 */
  async seasonInfo() {
    const html = await this.queryPageHtml('首页')
    if (!html) throw new Error('无法获取 Wiki 首页')
    const $ = cheerio.load(html)
    const timer = $('.eventTimer[data-info="赛季"]').first()
    if (!timer.length) throw new Error('首页没有找到赛季计时器')

    const card = timer.closest('.klbq-activity-card')
    let title = '当前赛季'
    if (card.length) {
      const titleNode = card.find('.klbq-activity-card__title, .title, h2, h3, h4').first()
      if (titleNode.length) {
        title = cleanText(titleNode.text())
      } else {
        const cardText = cleanText(card.text())
        if (cardText.includes('赛季')) {
          title = cardText.split('赛季')[0].replace(/[ ：:]+$/, '') + '赛季'
        }
      }
    }

    const endRaw = (timer.attr('data-end') || '').trim()
    if (!endRaw) throw new Error('赛季计时器缺少结束时间')

    let end
    try {
      const normalized = endRaw.replace(/Z$/, '+00:00')
      end = new Date(normalized)
      if (isNaN(end.getTime())) throw new Error('invalid')
    } catch {
      const patterns = [
        /(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/,
        /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/,
      ]
      let matched = false
      for (const p of patterns) {
        const m = endRaw.match(p)
        if (m) {
          end = new Date(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4] || 0),
            Number(m[5] || 0),
            Number(m[6] || 0),
          )
          matched = true
          break
        }
      }
      if (!matched) throw new Error(`无法解析赛季结束时间：${endRaw}`)
    }

    const now = new Date()
    const seconds = Math.floor((end.getTime() - now.getTime()) / 1000)
    let status
    if (seconds <= 0) {
      status = '已结束'
    } else {
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      status = `剩余 ${days} 天 ${hours} 小时`
    }

    const pad = (n) => String(n).padStart(2, '0')
    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(end.getHours())}:${pad(end.getMinutes())}`

    return {
      title,
      status,
      endStr,
      text: `状态：${status}\n结束时间：${endStr}（Asia/Shanghai）`,
    }
  }

  /**
   * 获取 Wiki 首页所有倒计时事件（赛季/活动/奖池等）
   * 返回数组，每项包含 type/title/start/end/status/daysRemaining/daysTotal/progress
   * 按结束时间升序排列（最快结束的排前面）
   */
  async calendarEvents() {
    const html = await this.queryPageHtml('首页')
    if (!html) throw new Error('无法获取 Wiki 首页')
    const $ = cheerio.load(html)
    const timers = $('.eventTimer')
    if (!timers.length) throw new Error('首页没有找到任何倒计时事件')

    const now = Date.now()
    const events = []

    timers.each((_, timer) => {
      const $t = $(timer)
      const type = ($t.attr('data-info') || '未知').trim()
      const endRaw = ($t.attr('data-end') || '').trim()
      const startRaw = ($t.attr('data-start') || '').trim()
      if (!endRaw) return

      // 找到所属卡片标题、图片、链接
      const card = $t.closest('.klbq-activity-card')
      let title = ''
      let image = ''
      let url = ''
      if (card.length) {
        const titleNode = card.find('.klbq-activity-card__title, .title, h2, h3, h4').first()
        if (titleNode.length) {
          title = cleanText(titleNode.text())
        }
        // 图片：优先 src，回退 data-src
        const img = card.find('.klbq-activity-card__image-wrapper img, img').first()
        if (img.length) {
          image = img.attr('data-src') || img.attr('src') || ''
          // 协议补全
          if (image.startsWith('//')) image = 'https:' + image
        }
        // 详情链接
        const link = card.find('a[href]').first()
        if (link.length) {
          const href = link.attr('href') || ''
          if (href.startsWith('/')) {
            url = 'https://wiki.biligame.com' + href
          } else if (href.startsWith('http')) {
            url = href
          }
        }
      }
      if (!title) title = `${type}事件`

      const end = parseDate(endRaw)
      const start = startRaw ? parseDate(startRaw) : null
      if (!end) return

      const endMs = end.getTime()
      const startMs = start ? start.getTime() : endMs
      const totalMs = Math.max(1, endMs - startMs)
      const elapsedMs = Math.max(0, Math.min(totalMs, now - startMs))
      const remainingMs = Math.max(0, endMs - now)

      const daysRemaining = Math.floor(remainingMs / 86400000)
      const hoursRemaining = Math.floor((remainingMs % 86400000) / 3600000)
      const daysTotal = Math.floor(totalMs / 86400000)

      let status
      if (remainingMs <= 0) {
        status = '已结束'
      } else if (now < startMs) {
        const daysToStart = Math.floor((startMs - now) / 86400000)
        status = daysToStart > 0 ? `${daysToStart} 天后开始` : '即将开始'
      } else {
        status = daysRemaining > 0 ? `剩 ${daysRemaining} 天 ${hoursRemaining} 小时` : `剩 ${hoursRemaining} 小时`
      }

      const pad = (n) => String(n).padStart(2, '0')
      const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(end.getHours())}:${pad(end.getMinutes())}`
      const startStr = start
        ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}`
        : ''

      events.push({
        type,
        title,
        image,
        url,
        start: startStr,
        end: endStr,
        status,
        daysRemaining,
        daysTotal,
        progress: Math.round((elapsedMs / totalMs) * 100),
        ended: remainingMs <= 0,
        notStarted: now < startMs,
      })
    })

    // 按结束时间升序（未结束的在前，已结束的在后）
    events.sort((a, b) => {
      if (a.ended !== b.ended) return a.ended ? 1 : -1
      return a.daysRemaining - b.daysRemaining
    })

    return events
  }
}

/**
 * 解析 Wiki 倒计时日期字符串
 * 支持 "2026/7/30 05:59"、"2026-07-30 05:59" 等格式
 */
function parseDate(raw) {
  if (!raw) return null
  try {
    const normalized = raw.replace(/\//g, '-').replace(/Z$/, '+00:00')
    const d = new Date(normalized)
    if (!isNaN(d.getTime())) return d
  } catch {}
  const m = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
    )
  }
  return null
}

/**
 * 解析公告发布日期（"2026年9月14日"，可带时间）
 * @returns {number} 毫秒时间戳，无法解析时返回 0
 */
function parseNoticeDate(raw) {
  if (!raw) return 0
  const m = String(raw).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{1,2}))?/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
    return isNaN(d.getTime()) ? 0 : d.getTime()
  }
  const d = parseDate(raw)
  return d ? d.getTime() : 0
}

/** 判断 a 是否为 b 的子集 */
function isSubset(a, b) {
  for (const v of a) if (!b.has(v)) return false
  return true
}
