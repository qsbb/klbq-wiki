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

/** 默认配置 */
const DEFAULT_CONFIG = {
  birthday_count: 5,
  render_image: true,
  cat_language_image: false,
  send_detail_link: true,
  image_timeout: 8,
  text_fallback: true,
  grid_columns: 2,
  card_width: 760,
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

/** 读取渲染设置 */
function renderSettings(config) {
  const columns = Math.max(1, Math.min(4, parseInt(config.grid_columns) || 2))
  const cardWidth = Math.max(420, Math.min(1200, parseInt(config.card_width) || 760))
  const timeout = Math.max(1, Math.min(60, parseFloat(config.image_timeout) || 8))
  const fallback = !!config.text_fallback
  return { columns, cardWidth, timeout, fallback }
}

/** 帮助文本 */
function helpText() {
  return (
    '卡拉彼丘 Wiki 查询帮助\n' +
    '\n【角色与武器】\n' +
    '-心夏　或　#klbq 心夏　查询角色资料\n' +
    '-空境　或　#klbq 空境　查询武器资料\n' +
    '-心夏武器　查询角色武器\n' +
    '\n【皮肤】\n' +
    '-心夏 皮肤　查看皮肤列表\n' +
    '-心夏 休日冒险　查询指定皮肤\n' +
    '-心夏 私服　查询私服皮肤\n' +
    '宿舍皮、私皮等同于私服\n' +
    '\n【其他】\n' +
    '-生日　查看近期角色生日\n' +
    '-赛季　查看赛季结束时间\n' +
    '-喵言喵语　随机喵言喵语\n' +
    '\n支持 - 和 #klbq / /klbq / #卡拉彼丘 / #卡丘 前缀，支持角色别名。'
  )
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
          // 排除 -数字（负数）情况
          reg: /^(?:-(?:$|\D)|(?:\/|#)(?:klbq|卡拉彼丘|卡丘)(?:\s|$))/i,
          fnc: 'onKlbqCommand',
          log: true,
        },
      ],
    })
    this.wiki = new WikiClient()
    this.config = loadConfig()
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
      return await this.sendTextCard(e, '使用帮助', helpText(), '指令说明')
    }

    try {
      // 生日
      if (query === '生日' || query === '角色生日') {
        return await this.handleBirthday(e)
      }
      // 喵言喵语
      if (query === '喵言喵语' || query === '随机喵言喵语') {
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

  /** 通用：发送文字卡片（可选渲染为图片） */
  async sendTextCard(e, title, text, kind = '查询结果', tip = '', thumb = '') {
    const renderImage = !!this.config.render_image
    if (renderImage && puppeteer) {
      const img = await this.renderImage(title, kind, [{ label: '内容', value: text }], thumb, tip)
      if (img) {
        await e.reply(segment.image(`base64://${img.toString('base64')}`))
        return true
      }
    }
    await e.reply(text)
    return true
  }

  /** 渲染图片卡片 */
  async renderImage(title, kind, items, thumb, tip) {
    const { columns, cardWidth, timeout } = renderSettings(this.config)
    try {
      const safeItems = items.map((i) => ({
        label: escapeHtml(i.label),
        value: escapeHtml(i.value),
      }))
      // saveId 必须是文件系统安全名（不能含 URL 编码字符或中文）
      // 因为 puppeteer 的 file:// URL 会自动解码 %XX，导致文件名不匹配
      const saveId = 'card_' + Date.now()
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile: CARD_TEMPLATE,
        saveId,
        imgType: 'jpeg',
        quality: 88,
        title: escapeHtml(title),
        kind: escapeHtml(kind),
        items: safeItems,
        thumb: thumb || '',
        tip: tip ? escapeHtml(tip) : '',
        grid_columns: columns,
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

  /** 发送查询结果 */
  async sendResult(e, title, pageUrl, fields, thumb = '') {
    const isWeapon = this.wiki.isWeapon(fields, title)
    const items = this.wiki.itemsForOutput(fields, isWeapon)
    const finalItems = items.length ? items : [{ label: '简介', value: '暂无可提取的结构化信息。' }]
    const kind = isWeapon ? '武器资料' : '角色资料'
    const weapon = fields['武器'] || ''
    const tip = !isWeapon && weapon ? `提示：可继续使用 #klbq ${weapon} 查询${title}的武器。` : ''

    const { fallback } = renderSettings(this.config)
    const renderImage = !!this.config.render_image

    if (renderImage && puppeteer) {
      const img = await this.renderImage(title, kind, finalItems, thumb, tip)
      if (img) {
        await e.reply(segment.image(`base64://${img.toString('base64')}`))
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

    const lines = [`最近 ${count} 个角色生日（Asia/Shanghai）：`]
    for (const item of upcoming.slice(0, count)) {
      const when = item.days === 0 ? '今天' : `还有 ${item.days} 天`
      lines.push(`${item.month}月${item.day}日　${item.name}（${when}）`)
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
    const tip = '输入 #klbq 角色名 皮肤名 查询皮肤详情'

    const renderImage = !!this.config.render_image
    if (renderImage && puppeteer) {
      const img = await this.renderImage(roleName, '皮肤列表', items, thumb, tip)
      if (img) {
        await e.reply(segment.image(`base64://${img.toString('base64')}`))
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
}
