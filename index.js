/**
 * 卡拉彼丘 Wiki 查询插件 for Yunzai-Bot
 * 移植自 astrbot_plugin_klbq_wiki
 *
 * 功能：
 * - 查询角色资料、武器资料、角色武器
 * - 查询角色皮肤列表与皮肤详情
 * - 查询近期角色生日、当前赛季、随机喵言喵语
 * - 支持图片卡片渲染（puppeteer），失败回退文字
 * - 支持合并转发消息发送皮肤图片
 *
 * 命令前缀：- 或 #klbq / /klbq / #卡拉彼丘 / #卡丘
 * 例如：-心夏、#klbq 心夏、#卡丘 心夏 皮肤
 */

import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { WikiClient, escapeHtml, unescapeHtml, cleanText } from './lib/wiki.js'
import { buildAliasMap, ROLE_FIELDS, WEAPON_FIELDS } from './lib/aliases.js'
import { ImageCache } from './lib/image-cache.js'

// puppeteer 渲染器：Yunzai 内置的全局渲染器
let puppeteer = null
try {
  puppeteer = (await import('../../lib/puppeteer/puppeteer.js')).default
} catch (err) {
  logger.warn('[KlbqWiki] puppeteer 渲染器加载失败，将使用纯文字输出')
}

// segment 消息段：Yunzai 全局对象
const segment = global.segment || (await import('../../lib/segment/onebot11.js')).default

const PLUGIN_NAME = 'klbq-wiki'
const CONFIG_DIR = `./plugins/${PLUGIN_NAME}/config`
const CONFIG_FILE = `${CONFIG_DIR}/config.yaml`
const CARD_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/card.html`
const HELP_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/help.html`
const BIRTHDAY_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/birthday.html`

/** 默认配置 */
const DEFAULT_CONFIG = {
  birthday_count: 5,
  render_image: true,
  cat_language_image: false,
  // 默认关闭：单独发送 Wiki 链接可能触发其他插件（如 lin-plugin 复读只因）的 bug
  // 图片卡片已包含完整资料，链接非必需。如需开启请手动设置为 true
  send_detail_link: false,
  image_timeout: 8,
  text_fallback: true,
  grid_columns: 2,
  card_width: 760,
  // 图片缓存：查询过的角色立绘、皮肤图等会存到 data/images/，避免重复网络下载
  image_cache: true,
  // 图片缓存有效期（天），0 表示永不过期
  image_cache_ttl: 30,
  // 更新成功后自动重启 Yunzai（通过 redis 标记 + process.exit，依赖 PM2 自动重启）
  auto_restart: true,
  // 自动重启前等待秒数（确保消息发送完成）
  restart_delay: 3,
  custom_aliases: '',
}

/** 加载配置 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG }
    const text = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = YAML.parse(text) || {}
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch (err) {
    logger.warn(`[KlbqWiki] 配置加载失败，使用默认值: ${err}`)
    return { ...DEFAULT_CONFIG }
  }
}

/** 保存配置到 YAML 文件 */
function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    const lines = ['# 卡拉彼丘 Wiki 查询插件配置', '# 修改后重启 Yunzai 生效（使用 -设置 命令修改会自动保存）', '']
    const descriptions = {
      birthday_count: '# 【生日查询】返回角色数量（1-20）',
      render_image: '# 【功能开关】将查询结果渲染为图片卡片',
      cat_language_image: '# 【喵言喵语】使用图片发送',
      send_detail_link: '# 【详情链接】发送 Wiki 链接',
      image_timeout: '# 【图片渲染】超时时间（秒，1-60）',
      text_fallback: '# 【图片渲染】失败或超时后回退文字',
      grid_columns: '# 【图片布局】每行格子数（1-4）',
      card_width: '# 【图片布局】卡片最小宽度（像素，420-1200）',
      image_cache: '# 【图片缓存】将查询过的图片缓存到本地，避免重复下载',
      image_cache_ttl: '# 【图片缓存】有效期（天，0 表示永不过期）',
      auto_restart: '# 【插件更新】更新成功后自动重启 Yunzai（需 PM2 等进程管理器）',
      restart_delay: '# 【插件更新】自动重启前等待秒数（1-30，确保消息发送完成）',
      custom_aliases: '# 【别名】自定义别名映射，每行一条，格式：别名=页面标题',
    }
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (descriptions[key]) lines.push(descriptions[key])
      const v = config[key] !== undefined ? config[key] : value
      if (typeof v === 'string' && v.includes('\n')) {
        lines.push(`${key}: |`, `  ${v.split('\n').join('\n  ')}`)
      } else if (typeof v === 'string' && v === '') {
        lines.push(`${key}: ''`)
      } else {
        lines.push(`${key}: ${v}`)
      }
      lines.push('')
    }
    fs.writeFileSync(CONFIG_FILE, lines.join('\n'), 'utf8')
    return true
  } catch (err) {
    logger.error(`[KlbqWiki] 配置保存失败: ${err}`)
    return false
  }
}

/**
 * 配置项元数据：用于 -设置 命令的展示和修改
 * type: boolean / number / string
 * group: 分组
 * label: 中文显示名（图片卡片中展示）
 * key 仍用于命令匹配与修改（-设置 <key> <值>）
 */
const CONFIG_META = {
  render_image:      { type: 'boolean', group: '功能开关', label: '图片渲染',   desc: '将查询结果渲染为图片卡片（关闭后发送纯文字）' },
  send_detail_link:  { type: 'boolean', group: '功能开关', label: '详情链接',   desc: '查询结果后发送 Wiki 链接（关闭可避免触发其他插件复读检测）' },
  text_fallback:     { type: 'boolean', group: '功能开关', label: '文字回退',   desc: '图片渲染失败或超时后回退文字' },
  cat_language_image:{ type: 'boolean', group: '功能开关', label: '喵言图片',   desc: '喵言喵语使用图片发送' },
  auto_restart:      { type: 'boolean', group: '插件更新', label: '自动重启',   desc: '更新成功后自动重启 Yunzai（需 PM2 等进程管理器自动拉起）' },
  birthday_count:    { type: 'number',  group: '查询设置', label: '生日数量',   desc: '生日查询返回角色数量（1-20）' },
  restart_delay:     { type: 'number',  group: '插件更新', label: '重启延时',   desc: '自动重启前等待秒数（1-30，确保消息发送完成）' },
  grid_columns:      { type: 'number',  group: '图片布局', label: '列数',       desc: '图片卡片每行格子数（1-4）' },
  card_width:        { type: 'number',  group: '图片布局', label: '卡片宽度',   desc: '图片卡片最小宽度（420-1200 像素）' },
  image_timeout:     { type: 'number',  group: '图片布局', label: '渲染超时',   desc: '图片渲染超时时间（1-60 秒）' },
  image_cache:       { type: 'boolean', group: '图片布局', label: '图片缓存',   desc: '将查询过的角色立绘、皮肤图缓存到本地，避免重复下载' },
  image_cache_ttl:   { type: 'number',  group: '图片布局', label: '缓存有效期', desc: '图片缓存有效期（天，0 表示永不过期）' },
}

/** 读取渲染设置 */
function renderSettings(config) {
  const columns = Math.max(1, Math.min(4, parseInt(config.grid_columns) || 2))
  const cardWidth = Math.max(420, Math.min(1200, parseInt(config.card_width) || 760))
  const timeout = Math.max(1, Math.min(60, parseFloat(config.image_timeout) || 8))
  const fallback = !!config.text_fallback
  return { columns, cardWidth, timeout, fallback }
}

/** 格式化字节数为人类可读字符串 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  // 整数值不显示小数（1.0 → 1），非整数保留 1 位小数（1.5 → 1.5）
  const formatted = value < 10 && !Number.isInteger(value) ? value.toFixed(1) : Math.round(value)
  return `${formatted} ${units[i]}`
}

/**
 * 从用户消息中提取命令前缀
 * 用于在卡片提示中显示与用户指令一致的前缀
 * 例如：-心夏 → '-'，#klbq 心夏 → '#klbq'，#卡拉彼丘心夏 → '#卡拉彼丘'
 * 前缀与关键词之间有无空格均可
 * @param {string} msg 原始消息
 * @returns {string} 前缀（不含尾部空格），无法识别时返回 '-'
 */
function extractPrefix(msg) {
  if (!msg) return '-'
  // 匹配 - 前缀
  if (/^-\s*/.test(msg)) return '-'
  // 匹配 #klbq / /klbq / #卡拉彼丘 / /卡拉彼丘 / #卡丘 / /卡丘 前缀
  // 不要求前缀后有空白，兼容 #klbq心夏 等无空格写法
  const m = msg.match(/^(?:\/|#)(?:klbq|卡拉彼丘|卡丘)/i)
  if (m) return m[0]
  return '-'
}

/** 帮助文本 */
/** 帮助分组数据（用于图片渲染） */
function helpData() {
  return [
    {
      name: '角色与武器',
      items: [
        { name: '-心夏 / #klbq 心夏', desc: '查询角色资料' },
        { name: '-空境 / #klbq 空境', desc: '查询武器资料' },
        { name: '-心夏武器', desc: '查询角色武器' },
      ],
    },
    {
      name: '皮肤',
      items: [
        { name: '-心夏 皮肤', desc: '查看皮肤列表' },
        { name: '-心夏 休日冒险', desc: '查询指定皮肤' },
        { name: '-心夏 私服', desc: '查询私服皮肤' },
        { name: '宿舍皮 / 私皮', desc: '等同于私服' },
      ],
    },
    {
      name: '其他',
      items: [
        { name: '-生日', desc: '查看近期角色生日' },
        { name: '-赛季', desc: '查看赛季结束时间' },
        { name: '-喵言喵语 / -喵', desc: '随机喵言喵语' },
      ],
    },
    {
      name: '插件管理（仅主人）',
      items: [
        { name: '-卡拉彼丘更新', desc: '拉取插件最新版本（默认自动重启）' },
        { name: '-卡拉彼丘强制更新', desc: '丢弃本地改动并强制更新' },
        { name: '-更新资源', desc: '预下载全部角色立绘和皮肤图到本地缓存' },
        { name: '-设置', desc: '查看与修改插件配置' },
      ],
    },
    {
      name: '命令前缀',
      items: [
        { name: '- / #klbq / /klbq', desc: '前缀与关键词之间有无空格均可' },
        { name: '#卡拉彼丘 / #卡丘', desc: '支持角色别名查询' },
      ],
    },
  ]
}

/**
 * 卡拉彼丘 Wiki 查询插件主类
 */
export class KlbqWikiPlugin extends plugin {
  constructor() {
    super({
      name: '卡拉彼丘Wiki查询',
      dsc: '查询卡拉彼丘角色、武器、皮肤、生日、赛季与喵言喵语等 Biligame Wiki 信息',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // 支持多种前缀：-心夏 或 #klbq 心夏 / /klbq 心夏 / #卡拉彼丘 心夏 / #卡丘 心夏
          // 前缀与关键词之间有无空格均可：#klbq心夏、#卡拉彼丘心夏 同样匹配
          // 排除 -数字（负数）情况
          reg: /^(?:-(?:$|\D)|(?:\/|#)(?:klbq|卡拉彼丘|卡丘))/i,
          fnc: 'onKlbqCommand',
          log: true,
        },
      ],
    })
    this.config = loadConfig()
    // 图片缓存实例：根据配置决定是否启用
    this.imageCache = new ImageCache({
      enabled: this.config.image_cache !== false,
      ttl: (parseInt(this.config.image_cache_ttl) || 30) * 86400,
    })
    this.wiki = new WikiClient({ imageCache: this.imageCache })
    this.aliasMap = buildAliasMap(this.config.custom_aliases)
  }

  /** 主命令入口 */
  async onKlbqCommand(e) {
    const msg = (e.msg || '').trim()
    // 提取关键词：去掉前缀 - 或 #klbq / /klbq / #卡拉彼丘 / #卡丘 等
    const query = msg
      .replace(/^-\s*/, '')
      .replace(/^(?:\/|#)(?:klbq|卡拉彼丘|卡丘)\s*/i, '')
      .trim()
    logger.info(`[KlbqWiki] 收到查询: msg=${msg}, query=${query}`)
    return await this.handleQuery(e, query)
  }

  /** 分派查询 */
  async handleQuery(e, query) {
    // 帮助
    if (!query || query.toLowerCase() === 'help' || query === '帮助') {
      return await this.sendHelp(e)
    }

    try {
      // 插件更新
      if (query === '卡拉彼丘更新' || query === '更新') {
        return await this.handleUpdate(e, false)
      }
      if (query === '卡拉彼丘强制更新' || query === '强制更新') {
        return await this.handleUpdate(e, true)
      }
      // 更新图片资源缓存
      if (query === '更新资源' || query === '卡拉彼丘更新资源' || query === '缓存资源' || query === '预下载') {
        return await this.handleFetchResources(e)
      }
      // 插件设置
      if (query === '设置' || query === '卡拉彼丘设置' || query === '配置') {
        return await this.handleSettings(e)
      }
      // 生日
      if (query === '生日' || query === '角色生日') {
        return await this.handleBirthday(e)
      }
      // 喵言喵语（-喵 为简写）
      if (query === '喵' || query === '喵言喵语' || query === '随机喵言喵语') {
        return await this.handleCatLanguage(e)
      }
      // 赛季
      if (query === '赛季' || query === '赛季结束') {
        return await this.handleSeason(e)
      }
      // 皮肤：角色名 皮肤名
      const parts = query.split(/\s+/)
      if (parts.length === 2) {
        if (parts[1] === '武器' || parts[1] === '的武器') {
          return await this.handleLookup(e, `${parts[0]}武器`)
        }
        return await this.handleSkin(e, parts[0], parts[1])
      }

      // 角色或武器查询
      return await this.handleLookup(e, query)
    } catch (err) {
      logger.error(`[KlbqWiki] 查询异常: query=${query}, error=${err}`)
      logger.error(err.stack || err)
      return await this.sendTextCard(e, '查询失败', `查询"${query}"时发生错误，已写入后台日志。`, '错误提示')
    }
  }

  /** 发送帮助卡片（分组图片，失败回退文字） */
  async sendHelp(e) {
    const groups = helpData()
    if (this.config.render_image && puppeteer) {
      const img = await this.renderHelp('使用帮助', '指令说明', groups)
      if (img) {
        await e.reply(img)
        return true
      }
      // 渲染失败回退文字
      const { fallback } = renderSettings(this.config)
      if (!fallback) {
        await e.reply('帮助图片渲染失败，请稍后重试。')
        return true
      }
    }
    // 文字回退：拼装分组文本
    const lines = ['卡拉彼丘 Wiki 查询帮助']
    for (const g of groups) {
      lines.push(`\n【${g.name}】`)
      for (const item of g.items) {
        lines.push(`${item.name}　${item.desc}`)
      }
    }
    await e.reply(lines.join('\n'))
    return true
  }

  /** 通用：发送文字卡片（可选渲染为图片） */
  async sendTextCard(e, title, text, kind = '查询结果', tip = '', thumb = '') {
    const renderImage = !!this.config.render_image
    if (renderImage && puppeteer) {
      const img = await this.renderImage(title, kind, [{ label: '内容', value: text }], thumb, tip)
      if (img) {
        // puppeteer.screenshot 已返回 segment 对象，直接发送
        await e.reply(img)
        return true
      }
    }
    await e.reply(text)
    return true
  }

  /** 渲染图片卡片，返回 segment 对象或 false */
  async renderImage(title, kind, items, thumb, tip) {
    const { columns, cardWidth, timeout } = renderSettings(this.config)
    try {
      // art-template 的 {{}} 默认会 HTML 转义，无需手动 escapeHtml
      // 否则会双重转义导致 < > 等字符显示为 &lt; &gt;
      const actualColumns = Math.min(columns, items.length || 1)
      // saveId 必须是文件系统安全名（不能含 URL 编码字符或中文）
      // 因为 puppeteer 的 file:// URL 会自动解码 %XX，导致文件名不匹配
      const saveId = 'card_' + Date.now()
      // 注意：Yunzai 的 puppeteer.screenshot 已返回 segment 对象，
      // 无需再用 segment.image() 包装，直接返回即可
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile: CARD_TEMPLATE,
        saveId,
        imgType: 'jpeg',
        quality: 88,
        title,
        kind,
        items,
        thumb: thumb || '',
        tip: tip || '',
        grid_columns: actualColumns,
        card_width: cardWidth,
        pageGotoParams: {
          timeout: timeout * 1000,
          waitUntil: 'networkidle2',
        },
      })
    } catch (err) {
      logger.warn(`[KlbqWiki] 图片渲染失败: ${err}`)
      return null
    }
  }

  /** 渲染分组卡片（帮助/设置），返回 segment 对象或 null */
  async renderHelp(title, kind, groups) {
    const { cardWidth, timeout } = renderSettings(this.config)
    try {
      // art-template 的 {{}} 默认会 HTML 转义，无需手动 escapeHtml
      const saveId = 'help_' + Date.now()
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile: HELP_TEMPLATE,
        saveId,
        imgType: 'jpeg',
        quality: 88,
        title,
        kind,
        groups,
        card_width: cardWidth,
        pageGotoParams: {
          timeout: timeout * 1000,
          waitUntil: 'networkidle2',
        },
      })
    } catch (err) {
      logger.warn(`[KlbqWiki] 分组卡片渲染失败: ${err}`)
      return null
    }
  }

  /** 发送查询结果 */
  async sendResult(e, title, pageUrl, fields, thumb = '') {
    const isWeapon = this.wiki.isWeapon(fields, title)
    const items = this.wiki.itemsForOutput(fields, isWeapon)
    const finalItems = items.length ? items : [{ label: '简介', value: '暂无可提取的结构化信息。' }]
    const kind = isWeapon ? '武器资料' : '角色资料'
    const weapon = fields['武器'] || ''
    // 提示前缀跟随用户发送的指令，如 -心夏 → '-'，#klbq 心夏 → '#klbq'
    const prefix = extractPrefix(e.msg)
    const tip = !isWeapon && weapon ? `提示：可继续使用 ${prefix} ${weapon} 查询${title}的武器。` : ''

    const { fallback } = renderSettings(this.config)
    const renderImage = !!this.config.render_image

    if (renderImage && puppeteer) {
      const img = await this.renderImage(title, kind, finalItems, thumb, tip)
      if (img) {
        // puppeteer.screenshot 已返回 segment 对象，直接发送
        await e.reply(img)
        if (this.config.send_detail_link) await e.reply(pageUrl)
        return true
      }
      if (!fallback) {
        await e.reply(`"${title}"图片渲染失败，请稍后重试。`)
        return true
      }
    }

    // 文字回退
    await e.reply(this.wiki.textOutput(title, finalItems, tip))
    if (this.config.send_detail_link) await e.reply(pageUrl)
    return true
  }

  /** 角色/武器查询 */
  async handleLookup(e, query) {
    const page = await this.wiki.lookup(query, this.aliasMap)
    if (!page) {
      const searchUrl =
        'https://wiki.biligame.com/klbq/Special:%E6%90%9C%E7%B4%A2?' +
        new URLSearchParams({ search: query }).toString()
      await this.sendTextCard(e, '未找到条目', `未找到"${query}"的卡拉彼丘 Wiki 条目。`, '查询提示')
      await e.reply(searchUrl)
      return true
    }

    const title = page.title || this.aliasMap.get(query.toLowerCase()) || query
    const pageUrl = this.wiki.pageUrl(title)
    const html = await this.wiki.queryPageHtml(title)
    const fields = html ? this.wiki.extractInfo(html, title) : { 名称: title }

    if (!fields['简介']) {
      const extract = cleanText(page.extract || '')
      if (extract) {
        fields['简介'] = extract.slice(0, 220).replace(/\s+$/, '') + (extract.length > 220 ? '...' : '')
      }
    }

    const fallbackThumb = page.thumbnail?.source || ''
    const thumb = await this.wiki.enhanceThumb(title, html || '', fields, fallbackThumb)

    return await this.sendResult(e, title, pageUrl, fields, thumb)
  }

  /** 生日查询 */
  async handleBirthday(e) {
    const rows = await this.wiki.birthdays()
    if (!rows.length) throw new Error('Wiki 暂无可解析的角色生日数据')

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const upcoming = []
    for (const row of rows) {
      let target = new Date(today.getFullYear(), row.month - 1, row.day)
      if (target < today) {
        target = new Date(today.getFullYear() + 1, row.month - 1, row.day)
      }
      const days = Math.floor((target - today) / 86400000)
      upcoming.push({ days, month: row.month, day: row.day, name: row.name })
    }

    const count = Math.max(1, Math.min(20, parseInt(this.config.birthday_count) || 5))
    upcoming.sort((a, b) => a.days - b.days || a.month - b.month || a.day - b.day || a.name.localeCompare(b.name))

    const list = upcoming.slice(0, count)
    const hero = list[0]
    const others = list.slice(1)

    // 尝试获取最近生日角色的随机立绘
    let artUrl = ''
    if (this.config.render_image && puppeteer) {
      try {
        artUrl = (await this.wiki.getCharacterArt(hero.name)) || ''
      } catch (err) {
        logger.warn(`[KlbqWiki] 获取 ${hero.name} 立绘失败: ${err}`)
      }
    }

    const when = (days) => (days === 0 ? '今天' : days === 1 ? '明天' : `还有 ${days} 天`)
    const dateStr = (m, d) => `${m}月${d}日`

    // 图片渲染
    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: BIRTHDAY_TEMPLATE,
          saveId: 'birthday_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: '近期角色生日',
          kind: `最近 ${count} 个角色生日（Asia/Shanghai）`,
          hero: {
            name: hero.name,
            date: dateStr(hero.month, hero.day),
            countdown: when(hero.days),
            art: artUrl,
          },
          others: others.map((item) => ({
            name: item.name,
            date: dateStr(item.month, item.day),
            countdown: when(item.days),
          })),
          card_width: cardWidth,
          pageGotoParams: {
            timeout: timeout * 1000,
            waitUntil: 'networkidle2',
          },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 生日卡片渲染失败: ${err}`)
        if (!fallback) {
          await e.reply('生日卡片渲染失败，请稍后重试。')
          return true
        }
      }
    }

    // 文字回退
    const lines = [`最近 ${count} 个角色生日（Asia/Shanghai）：`]
    for (const item of list) {
      lines.push(`${dateStr(item.month, item.day)}　${item.name}（${when(item.days)}）`)
    }
    return await this.sendTextCard(e, '近期角色生日', lines.join('\n'), '生日查询')
  }

  /** 喵言喵语 */
  async handleCatLanguage(e) {
    const lines = await this.wiki.catLanguageLines()
    if (!lines.length) throw new Error('"喵言喵语"页面没有可解析内容')
    const text = lines[Math.floor(Math.random() * lines.length)]
    if (!this.config.cat_language_image) {
      await e.reply(text)
      return true
    }
    return await this.sendTextCard(e, '喵言喵语', text, '随机语录')
  }

  /** 赛季查询 */
  async handleSeason(e) {
    const info = await this.wiki.seasonInfo()
    return await this.sendTextCard(e, info.title, info.text, '赛季信息')
  }

  /** 皮肤查询 */
  async handleSkin(e, roleQuery, skinQuery) {
    const role = this.aliasMap.get(roleQuery.toLowerCase()) || roleQuery
    let page = await this.wiki.queryPage(role)
    if (!page) {
      const found = await this.wiki.searchTitle(role)
      page = found ? await this.wiki.queryPage(found) : null
    }
    if (!page) {
      return await this.sendTextCard(e, '未找到角色', `未找到角色"${roleQuery}"。`, '查询提示')
    }

    const roleName = page.title || role
    const html = await this.wiki.queryPageHtml(roleName)
    if (!html) throw new Error(`无法获取"${roleName}"角色页面`)

    const skins = this.wiki.parseSkins(html)
    if (!skins.length) throw new Error(`"${roleName}"页面没有可解析的皮肤资料`)

    // 别名映射
    if (skinQuery === '宿舍皮' || skinQuery === '私皮') skinQuery = '私服'

    // 列出全部皮肤
    if (skinQuery === '皮肤') {
      return await this._sendSkinList(e, roleName, skins, page, html)
    }

    // 筛选皮肤
    let matches
    if (skinQuery === '私服') {
      matches = skins.filter((s) => s.quality === '私服')
    } else {
      matches = skins.filter((s) => s.name === skinQuery)
      if (!matches.length) {
        matches = skins.filter(
          (s) => s.name.includes(skinQuery) || skinQuery.includes(s.name),
        )
      }
    }

    if (!matches.length) {
      return await this.sendTextCard(e, '未找到皮肤', `未找到"${roleName}"的皮肤"${skinQuery}"。`, '查询提示')
    }

    if (matches.length > 1) {
      const text =
        '找到多个候选：\n' +
        matches.map((s) => `- ${s.name}（${s.quality}）`).join('\n')
      return await this.sendTextCard(e, `${roleName}皮肤候选`, text, '皮肤查询')
    }

    return await this._sendSkinDetail(e, roleName, skins, matches[0])
  }

  /** 发送皮肤列表 */
  async _sendSkinList(e, roleName, skins, page, html) {
    const groups = {}
    for (const skin of skins) {
      if (!groups[skin.quality]) groups[skin.quality] = []
      groups[skin.quality].push(skin.name)
    }
    const order = ['默认', '私服', '传说', '完美', '卓越', '稀有', '普通', '未知']
    const items = order
      .filter((q) => groups[q])
      .map((q) => ({ label: q, value: groups[q].join('、') }))

    const pageUrl = this.wiki.pageUrl(roleName)
    const fallbackThumb = page.thumbnail?.source || ''
    const thumb = await this.wiki.enhanceThumb(roleName, html, { 名称: roleName }, fallbackThumb)
    // 提示前缀跟随用户发送的指令
    const prefix = extractPrefix(e.msg)
    const tip = `输入 ${prefix} 角色名 皮肤名 查询皮肤详情`

    const renderImage = !!this.config.render_image
    if (renderImage && puppeteer) {
      const img = await this.renderImage(roleName, '皮肤列表', items, thumb, tip)
      if (img) {
        // puppeteer.screenshot 已返回 segment 对象，直接发送
        await e.reply(img)
        if (this.config.send_detail_link) await e.reply(pageUrl)
        return true
      }
    }

    const lines = [`${roleName}皮肤列表：`]
    for (const item of items) {
      lines.push(`\n【${item.label}】\n${item.value}`)
    }
    await e.reply(lines.join(''))
    if (this.config.send_detail_link) await e.reply(pageUrl)
    return true
  }

  /** 发送皮肤详情（合并转发图片） */
  async _sendSkinDetail(e, roleName, skins, selected) {
    // 传说皮肤合并基础形态及进阶形态
    let related = [selected]
    if (selected.quality === '传说') {
      const base = selected.name.split('-')[0]
      related = skins.filter(
        (s) =>
          s.quality === '传说' &&
          (s.name === base || s.name.startsWith(base + '-')),
      )
    }

    const forwardMsg = []
    let imageCount = 0
    for (const skin of related) {
      const urls = await this.wiki.skinImages(roleName, skin.name)
      imageCount += urls.length
      const details = [`${roleName} · ${skin.name}`, `品质：${skin.quality}`]
      if (skin.intro) details.push(`介绍：${skin.intro}`)
      if (skin.obtain) details.push(`获得方式：${skin.obtain}`)

      const message = [details.join('\n')]
      for (const url of urls) {
        message.push(segment.image(url))
      }
      forwardMsg.push({
        user_id: e.user_id || 10000,
        nickname: '卡拉彼丘 Wiki',
        message,
      })
    }

    // 没有图片时退化为文字卡片
    if (!imageCount) {
      const details = selected.intro || selected.obtain || '暂无更多文字资料。'
      const anchor = this.wiki.pageUrl(roleName) + '#' + encodeURIComponent(`skin_pane_${selected.name}`)
      const text = `${roleName} · ${selected.name}（${selected.quality}）\n${details}`
      await this.sendTextCard(e, selected.name, text, '皮肤详情')
      if (this.config.send_detail_link) await e.reply(anchor)
      return true
    }

    // 发送合并转发
    try {
      const msg = await this._makeForwardMsg(e, forwardMsg)
      await e.reply(msg)
    } catch (err) {
      logger.warn(`[KlbqWiki] 合并转发发送失败，改为逐条发送: ${err}`)
      for (const node of forwardMsg) {
        for (const seg of node.message) {
          await e.reply(seg)
        }
      }
    }

    if (this.config.send_detail_link) {
      const anchor =
        this.wiki.pageUrl(roleName) +
        '#' +
        encodeURIComponent(`skin_pane_${selected.name}`)
      await e.reply(anchor)
    }
    return true
  }

  /** 构造合并转发消息 */
  async _makeForwardMsg(e, forwardMsg) {
    if (e.group?.makeForwardMsg) return await e.group.makeForwardMsg(forwardMsg)
    if (e.friend?.makeForwardMsg) return await e.friend.makeForwardMsg(forwardMsg)
    if (Bot.makeForwardMsg) return await Bot.makeForwardMsg(forwardMsg)
    throw new Error('当前适配器不支持合并转发消息')
  }

  /**
   * 插件设置：查看和修改配置
   * 用法：
   *   -设置            查看所有配置
   *   -设置 项名        查看指定项详情
   *   -设置 项名 值      修改指定项
   *   -设置 项名 on/off  布尔项快捷开关
   *   -设置 重置         恢复全部默认配置
   */
  async handleSettings(e) {
    // 仅主人可用
    if (!e.isMaster) {
      await e.reply('仅主人可使用设置功能。')
      return true
    }

    // 刷新配置（确保读到最新值）
    this.config = loadConfig()

    // 解析参数：支持 "项名 值" 或 "项名" 或空
    const raw = (e.msg || '').replace(/^(-|(?:\/|#)(?:klbq|卡拉彼丘|卡丘))\s*/i, '').trim()
    const args = raw.replace(/^设置|卡拉彼丘设置|配置/, '').trim().split(/\s+/).filter(Boolean)

    // 无参数：列出所有配置
    if (args.length === 0) {
      return await this._settingsList(e)
    }

    const key = args[0]

    // 重置全部
    if (key === '重置' || key === 'reset' || key === '默认') {
      this.config = { ...DEFAULT_CONFIG }
      const ok = saveConfig(this.config)
      await e.reply(ok ? '✅ 已恢复全部默认配置并保存。' : '❌ 配置保存失败，请查看日志。')
      return true
    }

    // 查找配置项（支持模糊匹配）
    const matchedKey = this._matchConfigKey(key)
    if (!matchedKey) {
      await e.reply(`❌ 未找到配置项 "${key}"。\n发送 -设置 查看所有可用配置项。`)
      return true
    }

    // 仅查看单项
    if (args.length === 1) {
      const meta = CONFIG_META[matchedKey]
      const value = this.config[matchedKey]
      const lines = [
        `【${matchedKey}】`,
        `说明：${meta.desc}`,
        `类型：${meta.type}`,
        `当前值：${this._formatValue(value, meta.type)}`,
        '',
        `修改方法：`,
        `-设置 ${matchedKey} <新值>`,
      ]
      if (meta.type === 'boolean') {
        lines.push(`-设置 ${matchedKey} on  或  -设置 ${matchedKey} off`)
      }
      await e.reply(lines.join('\n'))
      return true
    }

    // 修改配置
    const newValue = args.slice(1).join(' ')
    return await this._settingsUpdate(e, matchedKey, newValue)
  }

  /** 列出所有配置 */
  async _settingsList(e) {
    // 按 CONFIG_META 的 group 字段分组
    const groupMap = {}
    const groupOrder = []
    for (const [key, meta] of Object.entries(CONFIG_META)) {
      if (!groupMap[meta.group]) {
        groupMap[meta.group] = []
        groupOrder.push(meta.group)
      }
      groupMap[meta.group].push({ key, ...meta })
    }
    // 构造分组数据
    const groups = groupOrder.map((groupName) => ({
      name: groupName,
      items: groupMap[groupName].map((item) => {
        const value = this.config[item.key]
        const valueStr = this._formatValue(value, item.type)
        // 显示名：中文 label + 英文 key（便于修改时输入）
        return { name: `${item.label}（${item.key}）`, desc: item.desc, value: valueStr }
      }),
    }))
    // 追加一个"使用方法"分组
    groups.push({
      name: '使用方法',
      items: [
        { name: '-设置 <项名> <值>', desc: '修改配置并自动保存' },
        { name: '-设置 <项名> on/off', desc: '布尔项快捷开关' },
        { name: '-设置 重置', desc: '恢复全部默认配置' },
      ],
    })

    // 尝试图片渲染
    if (this.config.render_image && puppeteer) {
      const img = await this.renderHelp('插件配置', '设置', groups)
      if (img) {
        await e.reply(img)
        return true
      }
      const { fallback } = renderSettings(this.config)
      if (!fallback) {
        await e.reply('设置图片渲染失败，请稍后重试。')
        return true
      }
    }
    // 文字回退
    const lines = ['卡拉彼丘 Wiki 插件配置', '']
    for (const g of groups) {
      lines.push(`【${g.name}】`)
      for (const item of g.items) {
        const valueStr = item.value ? ` = ${item.value}` : ''
        lines.push(`• ${item.name}${valueStr}`)
        if (item.desc) lines.push(`  ${item.desc}`)
      }
      lines.push('')
    }
    await e.reply(lines.join('\n'))
    return true
  }

  /** 修改单项配置 */
  async _settingsUpdate(e, key, rawValue) {
    const meta = CONFIG_META[key]
    let value
    if (meta.type === 'boolean') {
      const v = rawValue.toLowerCase()
      if (['on', 'true', '1', '开', '开启', '是'].includes(v)) value = true
      else if (['off', 'false', '0', '关', '关闭', '否'].includes(v)) value = false
      else {
        await e.reply(`❌ ${key} 是布尔类型，请使用 on/off、true/false、开/关。`)
        return true
      }
    } else if (meta.type === 'number') {
      value = Number(rawValue)
      if (isNaN(value)) {
        await e.reply(`❌ ${key} 是数字类型，请输入有效数字。`)
        return true
      }
      // 范围校验
      const ranges = {
        birthday_count: [1, 20],
        grid_columns: [1, 4],
        card_width: [420, 1200],
        image_timeout: [1, 60],
        image_cache_ttl: [0, 365],
        restart_delay: [1, 30],
      }
      if (ranges[key]) {
        const [min, max] = ranges[key]
        if (value < min || value > max) {
          await e.reply(`❌ ${key} 取值范围 ${min}-${max}，当前输入 ${value}。`)
          return true
        }
        // 整数校验
        if (key !== 'image_timeout' && !Number.isInteger(value)) {
          await e.reply(`❌ ${key} 必须是整数。`)
          return true
        }
      }
    } else {
      value = rawValue
    }

    const oldValue = this.config[key]
    this.config[key] = value
    const ok = saveConfig(this.config)
    if (ok) {
      await e.reply(
        `✅ 配置已更新并保存：\n${key}\n${this._formatValue(oldValue, meta.type)} → ${this._formatValue(value, meta.type)}\n\n重启 Yunzai 后完全生效。`,
      )
    } else {
      this.config[key] = oldValue
      await e.reply('❌ 配置保存失败，请查看日志。')
    }
    return true
  }

  /** 格式化配置值用于显示 */
  _formatValue(value, type) {
    if (type === 'boolean') return value ? '✅ 开启' : '❌ 关闭'
    if (value === '' || value == null) return '(空)'
    return String(value)
  }

  /** 模糊匹配配置项名 */
  _matchConfigKey(input) {
    if (CONFIG_META[input]) return input
    const lower = input.toLowerCase()
    for (const key of Object.keys(CONFIG_META)) {
      if (key.toLowerCase() === lower) return key
    }
    // 前缀匹配
    const candidates = Object.keys(CONFIG_META).filter(k =>
      k.toLowerCase().startsWith(lower) || k.toLowerCase().includes(lower),
    )
    return candidates.length === 1 ? candidates[0] : null
  }

  /**
   * 更新图片资源：预下载所有角色的立绘和皮肤图到本地缓存
   * 仅主人可用。执行期间会逐步回复进度，避免长时间无响应。
   */
  async handleFetchResources(e) {
    if (!e.isMaster) {
      await e.reply('仅主人可使用更新资源功能。')
      return true
    }

    // 若缓存未启用，提示用户
    if (this.config.image_cache === false) {
      await e.reply(
        '⚠️ 当前图片缓存（image_cache）已关闭，预下载的图片不会被使用。\n' +
        '请先开启缓存：\n-设置 image_cache on'
      )
      return true
    }

    // 开始前的缓存统计
    const before = this.imageCache.stats()
    await e.reply(
      `📦 开始预下载全部角色立绘和皮肤图到本地...\n` +
      `当前缓存：${before.count} 个文件，${formatBytes(before.sizeBytes)}\n` +
      `这可能需要几分钟，请耐心等待。`
    )

    const startTime = Date.now()
    let lastReportTime = Date.now()
    let lastRoleName = ''

    try {
      const result = await this.wiki.fetchAllResources({
        onStart: (total) => {
          logger.info(`[KlbqWiki] 开始预下载 ${total} 个角色的资源`)
        },
        onRole: (role, idx, total, ok, fail) => {
          lastRoleName = role
          // 每 5 个角色或超过 15 秒未汇报，发送一次进度
          if (idx % 5 === 0 || Date.now() - lastReportTime > 15000) {
            lastReportTime = Date.now()
            e.reply?.(`⏳ 进度：${idx}/${total}（${Math.round((idx / total) * 100)}%）\n当前：${role}`)
              .catch(() => {})
          }
        },
      })

      const after = this.imageCache.stats()
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const newCount = Math.max(0, after.count - before.count)
      const newSize = Math.max(0, after.sizeBytes - before.sizeBytes)

      await e.reply(
        `✅ 资源预下载完成！\n` +
        `\n📊 本次统计：` +
        `\n- 角色数量：${result.roles}` +
        `\n- 立绘下载：${result.arts} 张` +
        `\n- 皮肤下载：${result.skins} 张` +
        `\n- 成功：${result.ok}，失败：${result.fail}` +
        `\n- 耗时：${elapsed} 秒` +
        `\n\n💾 本地缓存：` +
        `\n- 新增文件：${newCount} 个` +
        `\n- 新增大小：${formatBytes(newSize)}` +
        `\n- 总计文件：${after.count} 个` +
        `\n- 总计大小：${formatBytes(after.sizeBytes)}` +
        `\n- 存储目录：${after.dir}` +
        `\n\n之后查询角色和皮肤将直接读取本地缓存，图片加载速度大幅提升。`
      )
      return true
    } catch (err) {
      logger.error(`[KlbqWiki] 资源预下载失败: ${err}`)
      logger.error(err.stack || err)
      const after = this.imageCache.stats()
      await e.reply(
        `❌ 资源预下载过程中断：${err.message || err}\n` +
        `已缓存 ${after.count} 个文件。可稍后重新执行 -更新资源 继续。`
      )
      return true
    }
  }

  /**
   * 插件更新
   * @param e 消息事件
   * @param force 是否强制更新（强制更新会丢弃本地改动）
   */
  async handleUpdate(e, force = false) {
    // 仅主人可用
    if (!e.isMaster) {
      await e.reply('仅主人可使用更新功能。')
      return true
    }

    const pluginDir = path.resolve('plugins/klbq-wiki')
    const gitDir = path.join(pluginDir, '.git')
    if (!fs.existsSync(gitDir)) {
      await e.reply('插件目录不是 git 仓库，无法通过 git 更新。\n请手动重新克隆：\ngit clone https://github.com/qsbb/klbq-wiki.git ./plugins/klbq-wiki/')
      return true
    }

    const cmd = force
      ? 'git reset --hard HEAD && git clean -fd && git pull --ff-only'
      : 'git pull --ff-only'

    await e.reply(force ? '开始强制更新 klbq-wiki...' : '开始更新 klbq-wiki...')
    logger.info(`[KlbqWiki] 执行更新: ${cmd}`)

    try {
      const { execSync } = await import('node:child_process')
      const output = execSync(cmd, {
        cwd: pluginDir,
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const text = (output || '').trim()
      logger.info(`[KlbqWiki] 更新输出: ${text}`)

      // 判断是否有新提交
      const isUpToDate = /Already up to date|已经是最新|up-to-date/i.test(text)
      if (isUpToDate) {
        await e.reply('klbq-wiki 已是最新版本，无需更新。')
      } else {
        // 读取最新版本号
        let version = '未知'
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
          version = pkg.version || '未知'
        } catch {}
        const lines = [
          'klbq-wiki 更新成功！',
          `当前版本：v${version}`,
          '',
          '更新日志：',
          text.split('\n').slice(0, 15).join('\n'),
        ]
        await e.reply(lines.join('\n'))
        // 自动重启
        if (this.config.auto_restart) {
          await this.restartBot(e)
        } else {
          await e.reply('请重启 Yunzai 以使更新生效。')
        }
      }
      return true
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message
      logger.error(`[KlbqWiki] 更新失败: ${stderr}`)

      // 常见错误诊断
      let hint = ''
      if (/local changes|would be overwritten|Your local changes/i.test(stderr)) {
        hint = '\n本地有改动冲突，可使用 -卡拉彼丘强制更新 丢弃本地改动后重试。'
      } else if (/diverged|different histories|no common ancestor/i.test(stderr)) {
        hint = '\n本地分支与远程分歧，可使用 -卡拉彼丘强制更新 重置为远程版本。'
      } else if (/Permission denied|could not read username|Authentication failed/i.test(stderr)) {
        hint = '\n认证失败，请检查 git 凭据配置。'
      } else if (/not a git repository|does not appear to be a git repository/i.test(stderr)) {
        hint = '\n插件目录不是 git 仓库，请重新克隆。'
      } else if (/timeout|TIMEDOUT/i.test(stderr)) {
        hint = '\n更新超时（60秒），请检查网络后重试。'
      }

      await e.reply(`klbq-wiki 更新失败：\n${stderr.split('\n').slice(0, 8).join('\n')}${hint}`)
      return true
    }
  }

  /**
   * 自动重启 Yunzai
   * 采用 Yunzai 官方重启机制：通过 redis 设置 Yz:restart 标记，然后 process.exit
   * 依赖 PM2 等进程管理器自动拉起进程；重启后 Yunzai 会读取标记并发送"重启完成"消息
   * @param e 消息事件
   */
  async restartBot(e) {
    const delay = Math.max(1, Math.min(30, parseInt(this.config.restart_delay) || 3))
    await e.reply(
      [
        `✅ 更新完成，${delay} 秒后将自动重启 Yunzai 以使更新生效...`,
        '',
        '重启机制：通过 redis 标记 + process.exit 实现',
        '• 若使用 PM2 / npm start 等进程管理器，将自动拉起新进程',
        '• 若直接运行 node app.js，需手动重新启动',
        `• 可通过 -设置 auto_restart off 关闭自动重启`,
      ].join('\n'),
    )

    // 延时等待消息发送完成
    await new Promise((resolve) => setTimeout(resolve, delay * 1000))

    // 设置 Yunzai 官方重启标记（重启后 Yunzai 会读取并发送提示消息）
    try {
      const redis = global.redis || (await import('../../lib/db/redis.js')).default
      if (redis && typeof redis.set === 'function') {
        const data = JSON.stringify({
          isMaster: !!e.isMaster,
          uin: e?.self_id || global.Bot?.uin || 0,
          time: Date.now(),
        })
        // 设置 5 分钟过期，避免重启失败后残留
        await redis.set('Yz:restart', data, { EX: 300 })
        logger.info('[KlbqWiki] 已设置 Yz:restart 标记')
      }
    } catch (err) {
      logger.warn(`[KlbqWiki] 设置重启标记失败（不影响重启）: ${err}`)
    }

    logger.info('[KlbqWiki] 正在退出进程以触发自动重启...')
    // 退出进程：PM2 等进程管理器会自动重启
    // 使用 exit code 1 让 PM2 识别为异常退出并重启
    process.exit(1)
  }
}
