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
  async apiGet(params) {
    const url = new URL(API_URL)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v))
    }
    try {
      const resp = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) {
        const text = await resp.text()
        logger.warn(`[KlbqWiki] API HTTP ${resp.status}: ${text.slice(0, 200)}`)
        return null
      }
      return await resp.json()
    } catch (err) {
      logger.warn(`[KlbqWiki] API 请求失败: ${err}`)
      return null
    }
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

    // 武器表格与伤害表格
    this._extractWeaponTables(tables, fields)
    this._extractWeaponFeelText(html, fields)
    const weapon = this._extractWeaponLink(links, title)
    if (weapon && !('武器' in fields)) fields['武器'] = weapon
    return fields
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
    const cell = $('td[itemprop=birthDate]').first()
    if (cell.length) text = cell.text().trim()
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
    try {
      new Date(2000, month - 1, day)
    } catch {
      return null
    }
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
}

/** 判断 a 是否为 b 的子集 */
function isSubset(a, b) {
  for (const v of a) if (!b.has(v)) return false
  return true
}
