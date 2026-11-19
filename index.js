/**
 * 卡拉彼丘 Wiki 查询插件 for Yunzai-Bot
 * 移植自 astrbot_plugin_klbq_wiki
 *
 * 功能：
 * - 查询角色资料、角色技能、武器资料、角色武器与地图资料
 * - 查询角色皮肤列表与皮肤详情
 * - 查询近期角色生日、当前活动、兑换码、当前赛季、随机喵言喵语
 * - 支持图片卡片渲染（puppeteer），失败回退文字
 * - 支持合并转发消息发送皮肤图片
 *
 * 命令前缀：- 或 #klbq / /klbq / #卡拉彼丘 / #卡丘
 * 例如：-心夏、#klbq 心夏、#卡丘 心夏 皮肤
 */

import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { WikiClient, escapeHtml, unescapeHtml, cleanText } from './lib/wiki.js'
import { buildAliasMap, ROLE_FIELDS, WEAPON_FIELDS } from './lib/aliases.js'
import { ImageCache, toFileUrl } from './lib/image-cache.js'
import { isPlausibleQuery } from './lib/query-guard.js'
import {
  DakanuClient,
  StatsError,
  buildCareerCard,
  buildMatchesCard,
  buildRelationsCard,
  buildRankingCard,
  buildMatchCard,
  buildClanCard,
  buildBannedCard,
  tierLabel,
  formatNumber,
  formatPercent,
} from './lib/stats.js'

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
/** 战绩查询的视图关键词 → 内部视图名 */
const STATS_VIEW_ALIAS = {
  生涯: 'career',
  资料: 'career',
  战绩: 'career',
  对局: 'matches',
  比赛: 'matches',
  搭档: 'teammate',
  队友: 'teammate',
  对手: 'rival',
  敌人: 'rival',
}

/**
 * 排行榜关键词 → 榜单类型编号
 *
 * 站点给自己的榜单起名「极限推进榜」「晶源感染榜」，玩家嘴上说的是「推车」「生化」，
 * 这里做一层口语映射；label 本身仍会参与匹配，所以正式名也照样能用。
 */
const RANKING_KEYWORDS = {
  1: ['段位', '排位', '星星', 'stars'],
  2: ['团队', '乱斗', '团竞', 'team'],
  6: ['推车', '推进', 'pushcar', 'push'],
  7: ['挑战', '休闲', '训练', 'leisure'],
  8: ['生化', '晶源', '感染', 'zombie'],
}
const CONFIG_DIR = `./plugins/${PLUGIN_NAME}/config`
const CONFIG_FILE = `${CONFIG_DIR}/config.yaml`
const CARD_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/card.html`
const CARD_ROLE_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/card-role.html`
const HELP_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/help.html`
const BIRTHDAY_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/birthday.html`
const CALENDAR_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/calendar.html`
const ACTIVITIES_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/activities.html`
const MAP_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/map.html`
const MAP_LIST_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/maps.html`
const SKILLS_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/skills.html`
const AWAKEN_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/awaken.html`
const ANNOUNCEMENT_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/announcement.html`
const VOICE_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/voice.html`
const VOICE_SESSION_FILE = `./plugins/${PLUGIN_NAME}/data/voice-sessions.json`
// 战绩查询卡片（数据源 dakanu.com）
const STATS_CAREER_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-career.html`
const STATS_MATCHES_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-matches.html`
const STATS_RANKING_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-ranking.html`
const STATS_RELATIONS_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-relations.html`
const STATS_MATCH_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-match.html`
const STATS_CLAN_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-clan.html`
const STATS_BANNED_TEMPLATE = `./plugins/${PLUGIN_NAME}/resources/stats-banned.html`

/** 默认配置 */
const DEFAULT_CONFIG = {
  birthday_count: 5,
  // 公告列表显示条数
  announcement_count: 15,
  // 语音点选会话有效期（秒），超时后 -1 -2 不再生效
  voice_session_ttl: 300,
  // 语音文本本地缓存有效期（天，0 表示永不过期）
  voice_cache_ttl: 7,
  // 语音发送方式：false=适配器直接拉取远程 URL；true=先下载到临时目录再发送（发完即删）
  // 点选后日志显示已发送但群里看不到语音时，设为 true
  voice_send_local: false,
  // 语音全量列表渲染为图片卡片（默认开启，卡片并行渲染提速；关闭则纯文字秒发）
  voice_list_image: true,
  // 语音卡片 JPEG 质量（40-95）。文本列表用 70 已清晰，质量越低上传越快
  voice_card_quality: 70,
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
  // 查询不到条目时是否回复提示（关闭后静默忽略，避免聊天被误触发时刷屏）
  not_found_reply: true,
  // 更新成功后自动重启 Yunzai（通过 redis 标记 + process.exit，依赖 PM2 自动重启）
  auto_restart: true,
  // 自动重启前等待秒数（确保消息发送完成）
  restart_delay: 3,
  custom_aliases: '',
  // ── 战绩查询（数据源 dakanu.com）──
  // 总开关：关闭后 -战绩 / -排行 不响应
  stats_enabled: true,
  // 站点地址（自建或反代时改这里）
  stats_base_url: 'https://www.dakanu.com',
  // 单次请求超时（秒）。站点 summoner 接口实测 2~3 秒，留足余量
  stats_timeout: 25,
  // 玩家数据缓存（秒）。重复查询同一玩家时直接吃缓存，避免反复打站方
  stats_cache_ttl: 300,
  // 最近对局每卡显示条数（1-20）
  stats_match_limit: 10,
  // 排行榜每卡显示条数（1-50）
  stats_ranking_size: 20,
  // 对同一站点的并发上限（1-5），压低可减少对站方的压力
  stats_concurrency: 3,
  // 封神榜每卡显示条数（1-50）
  stats_banned_limit: 15,
  // 封神榜查个人时最多扫几页（每页 50 条）。站点会忽略它的 query 参数，只能本地筛
  stats_banned_scan_pages: 6,
}

/** 加载配置 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      // 首次运行（或更新后）自动生成带注释的默认配置文件
      // config/ 已加入 .gitignore，插件更新与强制更新均不会覆盖用户设置
      const config = { ...DEFAULT_CONFIG }
      saveConfig(config)
      return config
    }
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
      announcement_count: '# 【公告查询】公告列表显示条数（5-50）',
      voice_session_ttl: '# 【语音查询】点选会话有效期（秒，30-1800）',
      voice_cache_ttl: '# 【语音查询】语音文本本地缓存有效期（天，0 表示永不过期）',
      voice_send_local: '# 【语音查询】语音先下载再发送（适配器拉取远程失败时开启）',
      voice_list_image: '# 【语音查询】全量列表渲染图片卡片（默认开启，关闭则文字秒发）',
      voice_card_quality: '# 【语音查询】语音卡片 JPEG 质量（40-95，越小上传越快）',
      render_image: '# 【功能开关】将查询结果渲染为图片卡片',
      cat_language_image: '# 【喵言喵语】使用图片发送',
      send_detail_link: '# 【详情链接】发送 Wiki 链接',
      image_timeout: '# 【图片渲染】超时时间（秒，1-60）',
      text_fallback: '# 【图片渲染】失败或超时后回退文字',
      grid_columns: '# 【图片布局】每行格子数（1-4）',
      card_width: '# 【图片布局】卡片最小宽度（像素，420-1200）',
      image_cache: '# 【图片缓存】将查询过的图片缓存到本地，避免重复下载',
      image_cache_ttl: '# 【图片缓存】有效期（天，0 表示永不过期）',
      not_found_reply: '# 【查询提示】未找到条目时回复提示，关闭后静默忽略',
      auto_restart: '# 【插件更新】更新成功后自动重启 Yunzai（需 PM2 等进程管理器）',
      restart_delay: '# 【插件更新】自动重启前等待秒数（1-30，确保消息发送完成）',
      custom_aliases: '# 【别名】自定义别名映射，每行一条，格式：别名=页面标题',
      stats_enabled: '# 【战绩查询】总开关，关闭后 -战绩 / -排行 不响应',
      stats_base_url: '# 【战绩查询】站点地址（dakanu.com 或自建反代地址）',
      stats_timeout: '# 【战绩查询】单次请求超时（秒，5-60）',
      stats_cache_ttl: '# 【战绩查询】玩家数据缓存时长（秒，0 表示不缓存）',
      stats_match_limit: '# 【战绩查询】最近对局每卡显示条数（1-20）',
      stats_ranking_size: '# 【战绩查询】排行榜每卡显示条数（1-50）',
      stats_concurrency: '# 【战绩查询】对站点的并发上限（1-5）',
      stats_banned_limit: '# 【战绩查询】封神榜每卡显示条数（1-50）',
      stats_banned_scan_pages: '# 【战绩查询】封神榜查个人时最多扫几页（1-20，每页 50 条）',
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
  not_found_reply:   { type: 'boolean', group: '功能开关', label: '未找到提示', desc: '查询不到条目时回复提示，关闭后静默忽略' },
  auto_restart:      { type: 'boolean', group: '插件更新', label: '自动重启',   desc: '更新成功后自动重启 Yunzai（需 PM2 等进程管理器自动拉起）' },
  birthday_count:    { type: 'number',  group: '查询设置', label: '生日数量',   desc: '生日查询返回角色数量（1-20）' },
  announcement_count:{ type: 'number',  group: '查询设置', label: '公告数量',   desc: '公告列表显示条数（5-50）' },
  voice_session_ttl: { type: 'number',  group: '查询设置', label: '语音时效',   desc: '语音点选会话有效期（秒，30-1800）' },
  voice_cache_ttl:   { type: 'number',  group: '查询设置', label: '语音缓存',   desc: '语音文本本地缓存有效期（天，0 表示永不过期）' },
  voice_send_local:  { type: 'boolean', group: '查询设置', label: '语音本地下载', desc: '语音先下载到临时目录再发送（适配器拉取远程语音失败时开启）' },
  voice_list_image:  { type: 'boolean', group: '查询设置', label: '语音列表图片', desc: '语音全量列表渲染为图片卡片（默认开启，关闭则文字秒发）' },
  voice_card_quality: { type: 'number',  group: '图片布局', label: '语音卡质量', desc: '语音卡片 JPEG 质量（40-95，越小上传越快）' },
  restart_delay:     { type: 'number',  group: '插件更新', label: '重启延时',   desc: '自动重启前等待秒数（1-30，确保消息发送完成）' },
  grid_columns:      { type: 'number',  group: '图片布局', label: '列数',       desc: '图片卡片每行格子数（1-4）' },
  card_width:        { type: 'number',  group: '图片布局', label: '卡片宽度',   desc: '图片卡片最小宽度（420-1200 像素）' },
  image_timeout:     { type: 'number',  group: '图片布局', label: '渲染超时',   desc: '图片渲染超时时间（1-60 秒）' },
  image_cache:       { type: 'boolean', group: '图片布局', label: '图片缓存',   desc: '将查询过的角色立绘、皮肤图缓存到本地，避免重复下载' },
  image_cache_ttl:   { type: 'number',  group: '图片布局', label: '缓存有效期', desc: '图片缓存有效期（天，0 表示永不过期）' },
  custom_aliases:    { type: 'string',  group: '查询设置', label: '旧版别名',   desc: '每行一条：别名=页面标题（新版建议使用 config/aliases.yaml）' },
  stats_enabled:     { type: 'boolean', group: '战绩查询', label: '战绩查询',   desc: '开启 -战绩 / -排行 战绩查询（数据源 dakanu.com）' },
  stats_base_url:    { type: 'string',  group: '战绩查询', label: '站点地址',   desc: '战绩数据站点，默认 https://www.dakanu.com' },
  stats_timeout:     { type: 'number',  group: '战绩查询', label: '请求超时',   desc: '单次请求超时秒数（5-60）' },
  stats_cache_ttl:   { type: 'number',  group: '战绩查询', label: '数据缓存',   desc: '玩家数据缓存秒数（0 表示不缓存）' },
  stats_match_limit: { type: 'number',  group: '战绩查询', label: '对局条数',   desc: '最近对局每卡显示条数（1-20）' },
  stats_ranking_size:{ type: 'number',  group: '战绩查询', label: '排行条数',   desc: '排行榜每卡显示条数（1-50）' },
  stats_concurrency: { type: 'number',  group: '战绩查询', label: '并发上限',   desc: '对站点的并发请求上限（1-5）' },
  stats_banned_limit:{ type: 'number',  group: '战绩查询', label: '封神榜条数', desc: '封神榜每卡显示条数（1-50）' },
  stats_banned_scan_pages: { type: 'number', group: '战绩查询', label: '封神榜扫描页数', desc: '查个人时最多翻几页（1-20，每页 50 条）' },
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
 * 解析 git pull --ff-only 的输出，返回友好的摘要信息
 * 支持两种格式：
 *   - 中文：更新 a06ae30..72374a3 / Fast-forward
 *   - 英文：Updating a06ae30..72374a3 / Fast-forward
 */
function parseGitPullOutput(text) {
  if (!text) return null
  // 提取 commit 范围：Updating xxx..yyy 或 更新 xxx..yyy
  const rangeMatch = text.match(/(?:Updating|更新)\s+([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/i)
  // 提取变更文件统计： 5 files changed, 41 insertions(+), 7 deletions(-)
  const statsMatch = text.match(/(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/i)
  // 提取文件变更列表（按 | 分隔的行）
  const fileLines = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9_\-./]+\s*\|/.test(l))
    .map((l) => {
      const parts = l.split('|').map((s) => s.trim())
      return parts[0]
    })

  return {
    fromHash: rangeMatch ? rangeMatch[1].slice(0, 7) : null,
    toHash: rangeMatch ? rangeMatch[2].slice(0, 7) : null,
    filesChanged: statsMatch ? parseInt(statsMatch[1]) : (fileLines.length || 0),
    insertions: statsMatch ? parseInt(statsMatch[2] || 0) : 0,
    deletions: statsMatch ? parseInt(statsMatch[3] || 0) : 0,
    files: fileLines.slice(0, 10), // 最多展示 10 个文件
  }
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
        { name: '-心夏技能', desc: '查询角色技能，支持角色别名' },
        { name: '-心夏觉醒', desc: '查询角色觉醒效果与激活消耗' },
        { name: '-心夏语音', desc: '分类语音列表（中文优先），按序号点听' },
        { name: '-心夏语音 机动', desc: '关键词筛选语音，-1 ~ -N 收听' },
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
        { name: '-地图', desc: '按模式查看地图名称与图片块' },
        { name: '-88区', desc: '查询地图资料、地形图与地图概览' },
        { name: '-生日', desc: '查看近期角色生日' },
        { name: '-日历', desc: '查看活动倒计时与当月角色生日' },
        { name: '-活动', desc: '查看当前活动图片与详情' },
        { name: '-公告', desc: '列出近期公告（带序号）' },
        { name: '-公告10', desc: '查看序号 10 的公告详情' },
        { name: '-兑换码', desc: '查看 Wiki 收录的可用兑换码' },
        { name: '-赛季', desc: '查看赛季结束时间' },
        { name: '-喵言喵语 / -喵', desc: '随机喵言喵语' },
      ],
    },
    {
      name: '战绩查询',
      items: [
        { name: '-战绩 Maker寒冬', desc: '查生涯卡：段位、胜率、KDA、常用角色' },
        { name: '-战绩 Maker寒冬 对局', desc: '查最近对局（胜负、比分、K/D/A）' },
        { name: '-战绩 Maker寒冬 搭档', desc: '查同队玩家胜率' },
        { name: '-战绩 Maker寒冬 对手', desc: '查交手玩家胜率' },
        { name: '-排行 段位榜', desc: '查排行榜，可选段位/团队/推车/挑战/生化' },
        { name: '-对局 763696054851863695', desc: '查单局记分板（双方 10 人 + 分回合）' },
        { name: '-战队 168874', desc: '查战队概况，按 ID 最准' },
        { name: '-封神榜', desc: '查官方封禁记录，带 ID 或昵称可查个人' },
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
      dsc: '查询卡拉彼丘角色、技能、武器、皮肤、地图、活动、兑换码、生日与赛季等 Biligame Wiki 信息',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // 支持多种前缀：-心夏 或 #klbq 心夏 / /klbq 心夏 / #卡拉彼丘 心夏 / #卡丘 心夏
          // 前缀与关键词之间有无空格均可：#klbq心夏、#卡拉彼丘心夏 同样匹配
          // 排除纯 -数字（负数）情况，但允许 -88区、-404基地这类数字开头的地图名
          reg: /^(?:-(?:$|[^\d]|(?=[\s\S]*[\u4e00-\u9fff]))|(?:\/|#)(?:klbq|卡拉彼丘|卡丘))/i,
          fnc: 'onKlbqCommand',
          log: true,
        },
        {
          // 语音点选：-1 -2 ...（仅语音查询后的时效内有效，仅查询者本人可用）
          reg: /^-\d{1,4}$/,
          fnc: 'onVoicePick',
          log: false,
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
    // 语音点选会话：user_id -> { role, voices, expiresAt }（每个用户相互独立）
    this._voiceSessions = new Map()
    // 从磁盘恢复未过期的会话（插件热重载/重启后点选仍有效）
    this._loadVoiceSessions()
    // 战绩查询客户端（数据源 dakanu.com）
    this._reloadStatsClient()
  }

  /** 按当前配置重建战绩客户端（改了 stats_* 配置项后调用） */
  _reloadStatsClient() {
    this.stats = new DakanuClient({
      baseUrl: this.config.stats_base_url,
      timeout: (parseInt(this.config.stats_timeout) || 25) * 1000,
      cacheTtl: parseInt(this.config.stats_cache_ttl) || 0,
      concurrency: parseInt(this.config.stats_concurrency) || 3,
    })
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

  /** 命令分派规则表（正则匹配，按顺序执行，命中即返回） */
  _dispatchRules = [
    // 帮助
    { reg: /^(help|帮助)$/i, fn: (self, e) => self.sendHelp(e) },
    // 插件更新
    { reg: /^(卡拉彼丘更新|更新)$/, fn: (self, e) => self.handleUpdate(e, false) },
    { reg: /^(卡拉彼丘强制更新|强制更新)$/, fn: (self, e) => self.handleUpdate(e, true) },
    // 更新图片资源缓存
    { reg: /^(更新资源|卡拉彼丘更新资源|缓存资源|预下载)$/, fn: (self, e) => self.handleFetchResources(e) },
    // 插件设置
    { reg: /^(设置|卡拉彼丘设置|配置)$/, fn: (self, e) => self.handleSettings(e) },
    // 生日
    { reg: /^(生日|角色生日)$/, fn: (self, e) => self.handleBirthday(e) },
    // 喵言喵语
    { reg: /^(喵|喵言喵语|随机喵言喵语)$/, fn: (self, e) => self.handleCatLanguage(e) },
    // 赛季
    { reg: /^(赛季|赛季结束)$/, fn: (self, e) => self.handleSeason(e) },
    // 日历
    { reg: /^(日历|活动日历|倒计时)$/, fn: (self, e) => self.handleCalendar(e) },
    // 活动
    { reg: /^(活动|当前活动)$/, fn: (self, e) => self.handleActivities(e) },
    // 兑换码
    { reg: /^(兑换码|礼包码|cdk)$/i, fn: (self, e) => self.handleRedeemCodes(e) },
    // 公告：-公告 列出近期公告，-公告10 查看第 10 条详情
    { reg: /^(?:公告|公告资讯)(?:\s*(\d+))?$/, fn: (self, e, m) => self.handleAnnouncements(e, m[1]) },
    // 地图一览：按模式分组显示各模式的地图
    { reg: /^(地图|地图一览|全部地图|地图列表)$/, fn: (self, e) => self.handleMapList(e) },
    // 战绩：-战绩 昵称 [对局|搭档|对手]，或 -昵称 战绩（须放在皮肤规则之前，否则会被"角色 皮肤"规则吃掉）
    // 命令词后必须是空白或结尾，避免把「战绩狂人」这类昵称拆成「战绩 + 狂人」
    { reg: /^(?:查战绩|查询战绩|战绩)(?:\s+(.*))?$/, fn: (self, e, m) => self.handleStats(e, (m[1] || '').trim()) },
    { reg: /^(.+?)\s*战绩$/, fn: (self, e, m) => self.handleStats(e, m[1].trim()) },
    // 排行榜：-排行 [段位|团队|推车|挑战|生化]，默认段位榜
    { reg: /^(?:排行榜|排行|榜单)(?:\s+(.*))?$/, fn: (self, e, m) => self.handleRanking(e, (m[1] || '').trim()) },
    // 单局详情：-对局 763696054851863695
    // 这里要接住「对局 + 任意数字」，否则会掉到 Wiki 条目查询（有个叫「对局状态效果」的页面）
    { reg: /^(?:对局详情|单局|对局)(?:\s*(\d+))?$/, fn: (self, e, m) => self.handleMatchDetail(e, m[1] || '') },
    // 战队：-战队 168874（按 ID 稳） / -战队 惊天大扫码
    { reg: /^(?:战队|战队查询|查战队)(?:\s+(.*))?$/, fn: (self, e, m) => self.handleClan(e, (m[1] || '').trim()) },
    // 封神榜：-封神榜（榜单） / -封神榜 2154836（查某人）
    { reg: /^(?:封神榜|封号榜|封禁榜)(?:\s+(.*))?$/, fn: (self, e, m) => self.handleBanned(e, (m[1] || '').trim()) },
    // 角色技能：支持角色别名，如 -心夏技能、-奶妈技能
    { reg: /^(.+?)技能$/, fn: (self, e, m) => self.handleRoleSkills(e, m[1]) },
    // 角色觉醒：支持角色别名，如 -心夏觉醒、-奶妈觉醒（捕获组 trim 兼容"心夏 觉醒"写法）
    { reg: /^(.+?)觉醒$/, fn: (self, e, m) => self.handleRoleAwakenings(e, m[1].trim()) },
    // 角色语音：-心夏语音 / -心夏语音 机动（支持别名，需放在皮肤规则之前）
    { reg: /^(.+?)语音\s*(.*)$/, fn: (self, e, m) => self.handleVoice(e, m[1].trim(), (m[2] || '').trim()) },
    // 皮肤：角色名 皮肤名（空格分隔）
    { reg: /^(.+?)\s+(.+)$/, fn: async (self, e, m) => {
      const role = m[1], skin = m[2]
      if (skin === '武器' || skin === '的武器') {
        return await self.handleLookup(e, `${role}武器`)
      }
      if (skin === '觉醒') {
        return await self.handleRoleAwakenings(e, role)
      }
      return await self.handleSkin(e, role, skin)
    }},
    // 单参数：尝试皮肤前缀匹配（无空格皮肤查询）
    { reg: /^(.+)$/, fn: async (self, e, m) => await self.trySkinDispatch(e, m[1]) },
  ]

  /** 尝试皮肤前缀匹配，失败则走条目查询 */
  async trySkinDispatch(e, query) {
    if (query) {
      const skinSuffixes = ['私服', '宿舍皮', '私皮', '皮肤']
      // 优先匹配固定皮肤后缀
      for (const suffix of skinSuffixes) {
        if (query.endsWith(suffix) && query.length > suffix.length) {
          const rolePart = query.slice(0, -suffix.length)
          const roleResolved = this.aliasMap.get(rolePart.toLowerCase())
          if (roleResolved) {
            return await this.handleSkin(e, rolePart, suffix)
          }
        }
      }
      // 再遍历别名表做前缀匹配（处理具体皮肤名，如"猎虎裁恶"、"机动天使"、"危险游戏"）
      // 按别名长度降序，优先匹配长别名（如"哈基米雪儿"优先于"哈基米"）
      const aliasKeys = [...this.aliasMap.keys()].sort((a, b) => b.length - a.length)
      for (const aliasKey of aliasKeys) {
        if (query.toLowerCase().startsWith(aliasKey)) {
          const rolePart = query.slice(0, aliasKey.length)
          const skinPart = query.slice(aliasKey.length)
          // 角色部分至少 1 个字符（单字符角色名如"明/信/令"也支持），
          // 皮肤部分至少 2 个字符，避免误匹配
          if (rolePart.length >= 1 && skinPart.length >= 2) {
            return await this.handleSkin(e, rolePart, skinPart)
          }
        }
      }
    }
    // 未命中皮肤查询，走条目查询
    return await this.handleLookup(e, query)
  }

  /** 分派查询 */
  async handleQuery(e, query) {
    if (!query) return await this.sendHelp(e)

    // 误触发防护：聊天里以 - 开头的长文本、多行内容、纯符号不当作查询处理
    // 静默忽略，不回复"未找到"，避免把别人的聊天内容复读进群里
    if (!isPlausibleQuery(query)) {
      logger.info(`[KlbqWiki] 忽略疑似误触发内容（${[...query].length} 字符）: ${query.slice(0, 40).replace(/\s+/g, ' ')}`)
      return false
    }

    try {
      for (const rule of this._dispatchRules) {
        const m = query.match(rule.reg)
        if (m) {
          return await rule.fn(this, e, m)
        }
      }
      // 兜底：条目查询
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
  async renderImage(title, kind, items, thumb, tip, tplFile = CARD_TEMPLATE, bounds = null) {
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
      // 角色卡模板用 DATA_JSON 传完整数据（含 bounds），武器卡用传统变量
      const DATA_JSON = JSON.stringify({
        title, kind, items, tip: tip || '',
        thumb: toFileUrl(thumb) || '',
        bounds: bounds || null,
      })
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile,
        saveId,
        imgType: 'jpeg',
        quality: 88,
        title,
        kind,
        items,
        DATA_JSON,
        // puppeteer 用 page.setContent 加载 HTML，本地路径必须转成 file:// URL
        // 否则 <img src="d:\..."> 在 about:blank 基础下无法解析
        thumb: toFileUrl(thumb) || '',
        tip: tip || '',
        bounds,
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
  async sendResult(e, title, pageUrl, fields, thumb = '', bounds = null) {
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
      const tplFile = isWeapon ? CARD_TEMPLATE : CARD_ROLE_TEMPLATE
      const img = await this.renderImage(title, kind, finalItems, thumb, tip, tplFile, bounds)
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
      // 静默判定：关闭 not_found_reply、或裸 - 前缀的纯英文聊天内容（如 -xxx）
      if (this._staySilentOnMiss(e, query)) {
        logger.info(`[KlbqWiki] 未找到条目，静默忽略: ${query}`)
        return false
      }
      return await this.sendTextCard(e, '未找到条目', `未找到"${query}"的卡拉彼丘 Wiki 条目。\n请检查名称是否正确，或使用 -帮助 查看支持的查询。`, '查询提示')
    }

    const title = page.title || this.aliasMap.get(query.toLowerCase()) || query
    const pageUrl = this.wiki.pageUrl(title)
    const html = await this.wiki.queryPageHtml(title)

    // 地图条目使用专属卡片展示，普通角色/武器继续走通用资料卡
    if (html) {
      const map = await this.wiki.mapInfo(title, html, cleanText(page.extract || ''))
      if (map) return await this.sendMapResult(e, map)
    }

    const fields = html ? this.wiki.extractInfo(html, title) : { 名称: title }

    if (!fields['简介']) {
      const extract = cleanText(page.extract || '')
      if (extract) {
        fields['简介'] = extract.slice(0, 220).replace(/\s+$/, '') + (extract.length > 220 ? '...' : '')
      }
    }

    const fallbackThumb = page.thumbnail?.source || ''
    const thumb = await this.wiki.enhanceThumb(title, html || '', fields, fallbackThumb)
    const bounds = thumb ? await this.wiki._imageBounds(thumb).catch(() => null) : null

    return await this.sendResult(e, title, pageUrl, fields, thumb, bounds)
  }

  /** 地图一览：按模式显示地图名称与图片块 */
  async handleMapList(e) {
    const groups = await this.wiki.mapModes().catch((err) => {
      logger.warn(`[KlbqWiki] 获取地图一览失败: ${err}`)
      return null
    })
    if (groups === null) {
      return await this.sendTextCard(e, '网络错误', '获取地图页面失败，可能是网络波动，请稍后重试。', '查询提示')
    }
    if (!groups.length) {
      return await this.sendTextCard(e, '暂无地图', 'Wiki 地图页面暂无可解析的模式和地图。', '地图一览')
    }

    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: MAP_LIST_TEMPLATE,
          saveId: 'maps_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          groups: groups.map((group) => ({
            ...group,
            maps: group.maps.map((map) => ({ ...map, image: toFileUrl(map.image) })),
          })),
          columns: 2,
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 地图一览渲染失败: ${err}`)
        if (!fallback) return await e.reply('地图一览渲染失败，请稍后重试。')
      }
    }

    const lines = ['地图一览：']
    for (const group of groups) {
      lines.push(`\n【${group.mode}】\n${group.maps.map((map) => map.name).join('、')}`)
    }
    return await e.reply(lines.join(''))
  }

  /** 地图详情卡片 */
  async sendMapResult(e, map) {
    const images = [...map.terrain, ...map.gallery]
    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: MAP_TEMPLATE,
          saveId: 'map_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: map.title,
          kind: `地图资料 · ${map.modes.length} 个支持模式`,
          description: map.description,
          modes: map.modes,
          platforms: map.platforms,
          terrain: map.terrain.map(toFileUrl),
          gallery: map.gallery.map(toFileUrl),
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 地图卡片渲染失败: ${err}`)
        if (!fallback) return await e.reply('地图卡片渲染失败，请稍后重试。')
      }
    }

    const lines = [`【${map.title}】`]
    if (map.description) lines.push(map.description)
    if (map.modes.length) lines.push(`支持模式：${map.modes.join('、')}`)
    if (map.platforms.length) lines.push(`上线平台：${map.platforms.join('、')}`)
    await e.reply(lines.join('\n'))
    for (const image of images.slice(0, 4)) await e.reply(segment.image(image))
    return true
  }

  // ── 战绩查询（数据源 dakanu.com）──────────────────────────────

  /**
   * 战绩查询入口
   *
   * 支持三种写法：
   *   -战绩 Maker寒冬            生涯卡
   *   -战绩 Maker寒冬 对局       最近对局
   *   -战绩 Maker寒冬 搭档       同队统计
   *   -战绩 Maker寒冬 对手       交手统计
   *   -Maker寒冬 战绩            同上（关键词在后）
   *
   * @param {string} arg 关键词之后的内容
   */
  async handleStats(e, arg) {
    if (this.config.stats_enabled === false) return false

    const raw = String(arg || '').trim()
    if (!raw) {
      return await this.sendTextCard(
        e,
        '战绩查询',
        [
          '用法：-战绩 <昵称或 UID> [对局|搭档|对手]',
          '',
          '例：',
          '-战绩 Maker寒冬          生涯卡',
          '-战绩 Maker寒冬 对局     最近对局',
          '-战绩 Maker寒冬 搭档     同队玩家胜率',
          '-战绩 Maker寒冬 对手     交手玩家胜率',
          '',
          '也可以把关键词放后面：-Maker寒冬 战绩',
          '数据源：dakanu.com（第三方站点，非官方数据）',
        ].join('\n'),
        '用法'
      )
    }

    // 从尾部识别视图关键词：剩下的整体当昵称（昵称允许含空格）
    let view = 'career'
    let query = raw
    let limit = 0
    const tail = raw.match(/^(.*?)\s+(生涯|资料|战绩|对局|比赛|搭档|队友|对手|敌人)\s*(\d{1,2})?$/)
    if (tail && tail[1].trim()) {
      query = tail[1].trim()
      view = STATS_VIEW_ALIAS[tail[2]] || 'career'
      limit = parseInt(tail[3], 10) || 0
    }

    if (!query) {
      return await this.sendTextCard(e, '战绩查询', '请提供玩家昵称或 UID，例如：-战绩 Maker寒冬', '用法')
    }

    try {
      const { player, candidates, confident } = await this.stats.resolvePlayer(query)

      // 昵称不精确命中且候选较多时，先让用户确认，避免查错人
      if (!confident && candidates.length > 1) {
        const list = candidates.slice(0, 6).map((item, index) => {
          const tags = []
          if (item.matchedBy === 'previous-nickname') tags.push('曾用名')
          if (item.level) tags.push(`Lv.${item.level}`)
          return `${index + 1}. ${item.nickname}${tags.length ? `（${tags.join('，')}）` : ''}  UID ${item.playerId}`
        })
        return await this.sendTextCard(
          e,
          `「${query}」匹配到 ${candidates.length} 个账号`,
          [
            '没有精确命中，请用完整昵称或 UID 重试：',
            '',
            ...list,
            candidates.length > 6 ? `… 还有 ${candidates.length - 6} 个` : '',
            '',
            `例：-战绩 ${candidates[0].playerId} ${view === 'career' ? '' : view}`.trim(),
          ].filter(Boolean).join('\n'),
          '需要确认'
        )
      }

      const profile = await this.stats.summoner(player.playerId)
      const meta = await this.stats.meta().catch(() => ({ modes: {}, roles: {}, seasons: [] }))

      let tpl = STATS_CAREER_TEMPLATE
      let card = null
      if (view === 'matches') {
        tpl = STATS_MATCHES_TEMPLATE
        card = buildMatchesCard(profile, {
          meta,
          limit: limit || parseInt(this.config.stats_match_limit, 10) || 10,
        })
      } else if (view === 'teammate' || view === 'rival') {
        tpl = STATS_RELATIONS_TEMPLATE
        card = buildRelationsCard(profile, view)
      } else {
        card = buildCareerCard(profile, meta)
      }

      const img = await this.renderStatsCard(tpl, card)
      if (img) {
        await e.reply(img)
        return true
      }
      // 文字回退
      await e.reply(this._statsText(card, view))
      return true
    } catch (err) {
      return await this._statsError(e, err, query)
    }
  }

  /**
   * 排行榜查询
   * @param {string} arg 榜单名（段位/团队/推车/挑战/生化）或类型编号，留空为段位榜
   */
  async handleRanking(e, arg) {
    if (this.config.stats_enabled === false) return false

    try {
      const types = await this.stats.rankTypes()
      if (!types.length) {
        return await this.sendTextCard(e, '排行榜', '站点暂时没有返回可用的榜单类型，请稍后再试。', '查询提示')
      }

      let type = types.find(item => item.code === 1) || types[0]
      const wanted = String(arg || '').trim()
      if (wanted) {
        const norm = s => String(s || '').replace(/[榜\s]/g, '')
        const target = norm(wanted)
        let hit = null

        // 1) 直接给类型编号
        if (/^\d+$/.test(target)) {
          hit = types.find(item => String(item.code) === target) || null
        }
        // 2) 口语关键词（推车 → 极限推进榜、生化 → 晶源感染榜）
        if (!hit && target) {
          for (const [code, words] of Object.entries(RANKING_KEYWORDS)) {
            if (!words.some(word => target.includes(word) || word.includes(target))) continue
            hit = types.find(item => String(item.code) === code) || null
            if (hit) break
          }
        }
        // 3) 榜单正式名
        if (!hit && target) {
          const byLabel = types.find(item => {
            const label = norm(item.label)
            return label.includes(target) || target.includes(label)
          })
          if (byLabel) hit = byLabel
        }

        if (!hit) {
          return await this.sendTextCard(
            e,
            '排行榜',
            [
              `未识别的榜单「${wanted}」。`,
              '',
              '可用榜单：',
              ...types.map(item => `· ${item.label}（${item.code}）`),
              '',
              '口语也认：推车 / 生化 / 团队 / 挑战 / 段位',
              '例：-排行 推车',
            ].join('\n'),
            '用法'
          )
        }
        type = hit
      }

      const size = Math.min(50, Math.max(1, parseInt(this.config.stats_ranking_size, 10) || 20))
      const data = await this.stats.rankings({ type: type.code, page: 1, pageSize: size })
      const meta = await this.stats.meta().catch(() => ({ modes: {}, roles: {}, seasons: [] }))
      const card = buildRankingCard(data, meta)

      const img = await this.renderStatsCard(STATS_RANKING_TEMPLATE, card)
      if (img) {
        await e.reply(img)
        return true
      }
      await e.reply(this._statsText(card, 'ranking'))
      return true
    } catch (err) {
      return await this._statsError(e, err, '排行榜')
    }
  }

  /**
   * 单局详情
   * @param {string} roomId 对局 ID
   */
  async handleMatchDetail(e, roomId) {
    if (this.config.stats_enabled === false) return false
    if (!roomId) {
      return await this.sendTextCard(
        e,
        '单局详情',
        [
          '用法：-对局 <对局 ID>',
          '',
          '对局 ID 从「最近对局」里取：',
          '-战绩 <昵称> 对局',
          '',
          '例：-对局 763696054851863695',
        ].join('\n'),
        '用法'
      )
    }
    try {
      const detail = await this.stats.matchDetail(roomId)
      const meta = await this.stats.meta().catch(() => ({ roles: {}, modes: {} }))
      const card = buildMatchCard(detail, meta)

      const img = await this.renderStatsCard(STATS_MATCH_TEMPLATE, card)
      if (img) {
        await e.reply(img)
        return true
      }
      await e.reply(this._statsText(card, 'match'))
      return true
    } catch (err) {
      if (err instanceof StatsError && err.code === 'not_found') {
        return await this.sendTextCard(
          e,
          '单局详情',
          [
            `没有查到对局「${roomId}」的记分板。`,
            '',
            '对局 ID 是 19 位数字，从最近对局里取：',
            '-战绩 <昵称> 对局',
          ].join('\n'),
          '查询提示'
        )
      }
      return await this._statsError(e, err, `对局 ${roomId}`)
    }
  }

  /**
   * 战队查询
   * @param {string} query 战队 ID 或名称
   */
  async handleClan(e, query) {
    if (this.config.stats_enabled === false) return false
    if (!query) {
      return await this.sendTextCard(
        e,
        '战队查询',
        ['用法：-战队 <战队 ID 或名称>', '', '例：', '-战队 168874', '-战队 惊天大扫码'].join('\n'),
        '用法'
      )
    }
    try {
      // 纯数字按 ID 查：站点的名称索引不完整，按名搜经常直接 422
      const options = /^\d+$/.test(query) ? { clanId: query } : { name: query }
      const clans = await this.stats.searchClans({ ...options, limit: 5 })
      const card = buildClanCard(clans)

      const img = await this.renderStatsCard(STATS_CLAN_TEMPLATE, card)
      if (img) {
        await e.reply(img)
        return true
      }
      await e.reply(this._statsText(card, 'clan'))
      return true
    } catch (err) {
      if (err instanceof StatsError && err.code === 'not_found' && /^\d+$/.test(query)) {
        // 按 ID 查不到时给一条可行的退路，而不是只说「没找到」
        return await this.sendTextCard(
          e,
          '战队查询',
          `没有找到 ID 为 ${query} 的战队。\n\n站点的战队名称索引不完整，用名称搜容易失败；ID 可从玩家生涯卡里的「战队」字段获取。`,
          '查询提示'
        )
      }
      return await this._statsError(e, err, query)
    }
  }

  /**
   * 封神榜
   * @param {string} query 玩家 UID 或昵称，留空则取榜单
   */
  async handleBanned(e, query) {
    if (this.config.stats_enabled === false) return false
    try {
      const limit = Math.min(50, Math.max(1, parseInt(this.config.stats_banned_limit, 10) || 15))
      const scanPages = Math.min(20, Math.max(1, parseInt(this.config.stats_banned_scan_pages, 10) || 6))
      const data = await this.stats.bannedPlayers({ query, limit, scanPages })
      const card = buildBannedCard(data, { query })
      if (!card.rows.length) {
        return await this.sendTextCard(e, card.title, card.emptyText, '查询提示')
      }

      const img = await this.renderStatsCard(STATS_BANNED_TEMPLATE, card)
      if (img) {
        await e.reply(img)
        return true
      }
      await e.reply(this._statsText(card, 'banned'))
      return true
    } catch (err) {
      return await this._statsError(e, err, query || '封神榜')
    }
  }

  /**
   * 渲染战绩卡片
   * @param {string} tplFile 模板路径
   * @param {Object} data 模板数据
   * @returns {Promise<Object|null>} segment 对象或 null
   */
  async renderStatsCard(tplFile, data) {
    if (!puppeteer) return null
    const { cardWidth, timeout } = renderSettings(this.config)
    const saveId = `stats_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    try {
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile,
        saveId,
        imgType: 'jpeg',
        quality: 88,
        ...data,
        card_width: cardWidth,
        pageGotoParams: {
          timeout: timeout * 1000,
          waitUntil: 'networkidle2',
        },
      })
    } catch (err) {
      logger.warn(`[KlbqWiki] 战绩卡片渲染失败: ${err}`)
      return null
    }
  }

  /**
   * 战绩数据的文字回退
   * @param {Object} card 卡片数据
   * @param {string} view career|matches|teammate|rival|ranking
   */
  _statsText(card, view = 'career') {
    const lines = [`【${card.title}】`]
    if (card.kind) lines.push(card.kind)
    if (card.metaLine) lines.push(card.metaLine)
    lines.push('')

    if (view === 'career') {
      if (card.belt?.length) {
        lines.push(card.belt.map(item => `${item.label} ${item.value}`).join(' ｜ '))
        lines.push('')
      }
      if (card.kv?.length) {
        for (let i = 0; i < card.kv.length; i += 2) {
          const pair = card.kv.slice(i, i + 2).map(item => `${item.label} ${item.value}`)
          lines.push(pair.join(' ｜ '))
        }
        lines.push('')
      }
      if (card.roles?.length) {
        lines.push('常用角色')
        card.roles.forEach((item, index) => {
          lines.push(`${index + 1}. ${item.name}  ${item.games} 场 胜率 ${item.winRate} K/D ${item.kd}`)
        })
        lines.push('')
      }
      if (card.modes?.length) {
        lines.push('模式统计')
        card.modes.forEach(item => {
          lines.push(`· ${item.label}  ${item.rounds} 场 胜率 ${item.winRate} K/D ${item.kd}`)
        })
      }
    } else if (view === 'matches') {
      if (card.rows?.length) {
        card.rows.forEach(item => {
          const badge = item.badge ? ` ${item.badge}` : ''
          lines.push(
            `${item.time} ${item.mode} ${item.role} ` +
            `${item.score} ${item.kda} ${item.result}${badge}` +
            (item.delta ? ` ${item.delta}` : '')
          )
        })
      } else {
        lines.push('没有查到对局记录。')
      }
    } else if (view === 'ranking') {
      if (card.rows?.length) {
        card.rows.forEach(item => {
          const tierPart = item.tier ? `${item.tier} ` : ''
          const gamesPart = item.gamesLabel ? `  ${item.gamesLabel}` : ''
          lines.push(`${item.position}. ${item.name}  ${tierPart}${item.score}${gamesPart}`)
        })
      } else {
        lines.push(card.emptyText || '这个榜单暂时没有数据')
      }
    } else if (view === 'match') {
      if (card.teams?.length) {
        for (const team of card.teams) {
          lines.push(`【${team.label}】${team.totalKillsText} 杀`)
          team.players.forEach(item => {
            const badge = item.badge ? ` ${item.badge}` : ''
            const mark = item.isTarget ? ' ←' : ''
            lines.push(`  ${item.name} ${item.role} ${item.kda} 伤害 ${item.damage}${badge}${mark}`)
          })
          lines.push('')
        }
      } else {
        lines.push(card.emptyText || '这一场没有可用的记分板数据')
      }
    } else if (view === 'clan') {
      if (card.rows?.length) {
        card.rows.forEach(item => {
          lines.push(`${item.name}（ID ${item.id}）Lv.${item.level} · ${item.members} 人`)
          if (item.intro) lines.push(`  ${item.intro}`)
        })
      } else {
        lines.push(card.emptyText || '没有找到战队')
      }
    } else if (view === 'banned') {
      if (card.rows?.length) {
        card.rows.forEach((item, index) => {
          const tierPart = item.tier ? ` ${item.tier}` : ''
          lines.push(
            `${index + 1}. ${item.name}（ID ${item.id}）${tierPart} Lv.${item.level}  ${item.date}`
          )
        })
      } else {
        lines.push(card.emptyText || '封神榜暂时没有数据')
      }
    } else {
      // 搭档 / 对手
      if (card.rows?.length) {
        card.rows.forEach((item, index) => {
          lines.push(
            `${index + 1}. ${item.name}  ${item.games} 场 ` +
            `${item.wins} 胜 ${item.losses} 负 胜率 ${item.winRate}`
          )
        })
      } else {
        lines.push(card.emptyText || '暂无记录')
      }
    }

    if (card.tip) {
      lines.push('')
      lines.push(card.tip)
    }
    return lines.join('\n')
  }

  /**
   * 战绩查询的错误提示
   * @param {Error} err
   * @param {string} query 用户查询词，用于文案
   */
  async _statsError(e, err, query = '') {
    let message
    if (err instanceof StatsError) {
      switch (err.code) {
        case 'not_found':
          message = [
            `没有找到「${query}」对应的玩家。`,
            '',
            '请检查昵称是否完整（区分大小写与符号），或改用 UID 查询：',
            `-战绩 <UID>`,
          ].join('\n')
          break
        case 'session':
          message = '站点没有这个玩家的可用查询会话（国际服暂不支持，仅国服可查）。'
          break
        case 'rate_limited':
          message = '站点限流了，请稍等一会儿再查。'
          break
        case 'timeout':
          message = '查询超时了。站点上游响应较慢，稍后重试通常就好了。'
          break
        case 'network':
          message = '连不上战绩站点，请检查网络或稍后重试。'
          break
        default:
          message = `战绩站点返回了错误：${err.message}`
          break
      }
      logger.warn(`[KlbqWiki] 战绩查询失败(${err.code}): ${err.message}`)
    } else {
      message = `战绩查询失败：${err?.message || err}`
      logger.error(`[KlbqWiki] 战绩查询异常: ${err}`)
    }
    return await this.sendTextCard(e, '战绩查询', message, '查询提示')
  }

  /** 角色技能查询 */
  async handleRoleSkills(e, roleQuery) {
    const role = this.aliasMap.get(roleQuery.toLowerCase()) || roleQuery
    let page = await this.wiki.queryPage(role)
    if (!page) {
      const found = await this.wiki.searchTitle(role)
      page = found ? await this.wiki.queryPage(found) : null
    }
    if (!page) return await this.sendTextCard(e, '未找到角色', `未找到角色"${roleQuery}"。`, '查询提示')

    const title = page.title || role
    const html = await this.wiki.queryPageHtml(title)
    if (!html) return await this.sendTextCard(e, '网络错误', `获取"${title}"角色页面失败，请稍后重试。`, '查询提示')
    const skills = await this.wiki.roleSkills(title, html)
    if (!skills.length) return await this.sendTextCard(e, '暂无技能', `"${title}"页面没有可解析的角色技能。`, '查询提示')

    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: SKILLS_TEMPLATE,
          saveId: 'skills_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: `${title}技能`,
          kind: `共 ${skills.length} 个角色技能`,
          skills: skills.map((item) => ({ ...item, icon: toFileUrl(item.icon) })),
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 技能卡片渲染失败: ${err}`)
        if (!fallback) return await e.reply('技能卡片渲染失败，请稍后重试。')
      }
    }

    const lines = [`【${title}技能】`]
    for (const skill of skills) lines.push(`\n[${skill.type}] ${skill.name}\n${skill.description}`)
    return await e.reply(lines.join('\n'))
  }

  /** 角色觉醒查询 */
  async handleRoleAwakenings(e, roleQuery) {
    const role = this.aliasMap.get(roleQuery.toLowerCase()) || roleQuery
    let page = await this.wiki.queryPage(role)
    if (!page) {
      const found = await this.wiki.searchTitle(role)
      page = found ? await this.wiki.queryPage(found) : null
    }
    if (!page) return await this.sendTextCard(e, '未找到角色', `未找到角色"${roleQuery}"。`, '查询提示')

    const title = page.title || role
    const html = await this.wiki.queryPageHtml(title)
    if (!html) return await this.sendTextCard(e, '网络错误', `获取"${title}"角色页面失败，请稍后重试。`, '查询提示')
    const groups = await this.wiki.roleAwakenings(title, html)
    if (!groups.length) return await this.sendTextCard(e, '暂无觉醒', `"${title}"页面没有可解析的觉醒效果。`, '查询提示')

    const total = groups.reduce((n, g) => n + g.awakenings.length, 0)
    const kind = groups.length > 1
      ? `按模式分组 · 共 ${total} 条觉醒效果`
      : `共 ${total} 条觉醒效果`

    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: AWAKEN_TEMPLATE,
          saveId: 'awaken_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: `${title}觉醒`,
          kind,
          groups,
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 觉醒卡片渲染失败: ${err}`)
        if (!fallback) return await e.reply('觉醒卡片渲染失败，请稍后重试。')
      }
    }

    const lines = [`【${title}觉醒】`]
    for (const group of groups) {
      if (group.mode) lines.push(`\n◆ ${group.mode}`)
      for (const a of group.awakenings) {
        const cost = a.costs.length ? `（消耗 ${a.costs.map((c) => `${c.name}${c.value}`).join(' ')}）` : ''
        lines.push(`\n觉醒${a.index} ${a.name}${cost}\n${a.description}`)
      }
    }
    return await e.reply(lines.join('\n'))
  }

  /** 生日查询 */
  async handleBirthday(e) {
    const rows = await this.wiki.birthdays()
    if (!rows.length) {
      return await this.sendTextCard(e, '暂无数据', 'Wiki 暂无可解析的角色生日数据，请稍后重试。', '查询提示')
    }

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
            // puppeteer 用 page.setContent 加载，本地路径需转 file:// URL
            art: toFileUrl(artUrl),
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
    if (!lines.length) {
      return await this.sendTextCard(e, '暂无数据', '"喵言喵语"页面没有可解析内容，请稍后重试。', '查询提示')
    }
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

  /** 日历查询：倒计时事件 + 角色生日 */
  async handleCalendar(e) {
    // 并行获取倒计时事件和生日数据
    const [events, birthdayRows] = await Promise.all([
      this.wiki.calendarEvents().catch((err) => {
        logger.warn(`[KlbqWiki] 获取倒计时事件失败: ${err}`)
        return []
      }),
      this.wiki.birthdays().catch((err) => {
        logger.warn(`[KlbqWiki] 获取生日数据失败: ${err}`)
        return []
      }),
    ])

    if (!events.length && !birthdayRows.length) {
      await e.reply('暂无日历数据，请稍后重试。')
      return true
    }

    // 处理倒计时事件：分类标签、紧急程度
    const typeLabels = { 赛季: '赛季', 活动: '活动', 奖池: '奖池' }
    const eventsView = events.map((ev) => {
      const typeLabel = typeLabels[ev.type] || ev.type
      const typeClass = ev.type === '赛季' ? 'season' : ev.type === '活动' ? 'activity' : ev.type === '奖池' ? 'pool' : 'other'
      // 紧急：3 天内结束
      const urgent = !ev.ended && !ev.notStarted && ev.daysRemaining <= 3
      return { ...ev, typeLabel, typeClass, urgent }
    })

    // 处理生日数据：只显示当月过生日的角色，按日期升序
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const currentMonth = now.getMonth() + 1
    const birthdayList = birthdayRows
      .filter((row) => row.month === currentMonth)
      .map((row) => {
        let target = new Date(today.getFullYear(), row.month - 1, row.day)
        // 当月已过完生日的，依然显示但标记为已过
        const days = Math.floor((target - today) / 86400000)
        return { name: row.name, month: row.month, day: row.day, days }
      })
      .sort((a, b) => a.day - b.day)

    const when = (days) => {
      if (days === 0) return '今天'
      if (days === 1) return '明天'
      if (days < 0) return `已过 ${Math.abs(days)} 天`
      return `${days} 天后`
    }
    const dateStr = (m, d) => `${m}月${d}日`
    const birthdaysView = birthdayList.map((b) => ({
      name: b.name,
      date: dateStr(b.month, b.day),
      countdown: when(b.days),
      isToday: b.days === 0,
      isPast: b.days < 0,
    }))

    const birthdaySectionTitle = birthdaysView.length
      ? `${currentMonth}月角色生日（共 ${birthdaysView.length} 位）`
      : `${currentMonth}月无角色生日`

    const nowStr = (() => {
      const pad = (n) => String(n).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    })()

    // 图片渲染
    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: CALENDAR_TEMPLATE,
          saveId: 'calendar_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: '卡拉彼丘日历',
          kind: `共 ${eventsView.length} 个倒计时 · ${birthdaysView.length} 个本月生日（${currentMonth}月）`,
          updated: nowStr,
          events: eventsView,
          birthdays: birthdaysView,
          birthdaySectionTitle,
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
        logger.warn(`[KlbqWiki] 日历卡片渲染失败: ${err}`)
        if (!fallback) {
          await e.reply('日历卡片渲染失败，请稍后重试。')
          return true
        }
      }
    }

    // 文字回退
    const lines = [`更新时间：${nowStr}`]
    if (eventsView.length) {
      lines.push('', '【倒计时】')
      for (const ev of eventsView) {
        lines.push(`[${ev.typeLabel}] ${ev.title}`)
        lines.push(`  ${ev.status}（止 ${ev.end}）`)
      }
    }
    if (birthdaysView.length) {
      lines.push('', `【${currentMonth}月生日】`)
      for (const b of birthdaysView) {
        lines.push(`${b.date}　${b.name}（${b.countdown}）`)
      }
    } else {
      lines.push('', `【${currentMonth}月生日】本月无角色生日`)
    }
    return await this.sendTextCard(e, '卡拉彼丘日历', lines.join('\n'), '日历查询')
  }

  /** 活动查询：以图片卡片显示当前正在进行的活动 */
  async handleActivities(e) {
    const events = await this.wiki.calendarEvents().catch((err) => {
      logger.warn(`[KlbqWiki] 获取活动数据失败: ${err}`)
      return []
    })

    if (!events.length) {
      await e.reply('暂无活动数据，请稍后重试。')
      return true
    }

    // 只显示正在进行中（未结束、已开始）的活动
    const ongoing = events.filter((ev) => !ev.ended && !ev.notStarted)
    if (!ongoing.length) {
      await e.reply('当前没有正在进行的活动。')
      return true
    }

    const typeLabels = { 赛季: '赛季', 活动: '活动', 奖池: '奖池' }
    // 活动数大于 4 时每行两个（紧凑布局），否则每行一个
    const useGrid = ongoing.length > 4
    const activitiesView = ongoing.map((ev) => {
      const typeLabel = typeLabels[ev.type] || ev.type
      const typeClass = ev.type === '赛季' ? 'season' : ev.type === '活动' ? 'activity' : ev.type === '奖池' ? 'pool' : 'other'
      const urgent = ev.daysRemaining <= 3
      return {
        ...ev,
        typeLabel,
        typeClass,
        urgent,
        compact: useGrid,
        single: !useGrid,
      }
    })
    const gridColumns = useGrid ? '1fr 1fr' : '1fr'

    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

    // 图片渲染
    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: ACTIVITIES_TEMPLATE,
          saveId: 'activities_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: '当前活动',
          kind: `共 ${activitiesView.length} 个活动正在进行中`,
          updated: nowStr,
          activities: activitiesView,
          grid_columns: gridColumns,
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
        logger.warn(`[KlbqWiki] 活动卡片渲染失败: ${err}`)
        if (!fallback) {
          await e.reply('活动卡片渲染失败，请稍后重试。')
          return true
        }
      }
    }

    // 文字回退
    const lines = [`更新时间：${nowStr}`, '', `共 ${activitiesView.length} 个活动正在进行中：`, '']
    for (const ev of activitiesView) {
      lines.push(`[${ev.typeLabel}] ${ev.title}`)
      lines.push(`  ${ev.status}（止 ${ev.end}）`)
    }
    return await this.sendTextCard(e, '当前活动', lines.join('\n'), '活动查询')
  }

  /** 兑换码查询：合并转发发送，每个兑换码单独一条消息便于复制 */
  async handleRedeemCodes(e) {
    const codes = await this.wiki.redeemCodes().catch((err) => {
      logger.warn(`[KlbqWiki] 获取兑换码失败: ${err}`)
      return null
    })
    if (codes === null) {
      return await this.sendTextCard(e, '网络错误', '获取兑换码页面失败，可能是网络波动，请稍后重试。', '查询提示')
    }
    if (!codes.length) {
      return await this.sendTextCard(e, '暂无兑换码', 'Wiki 暂无未失效的兑换码。', '兑换码')
    }

    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

    const nickname = '卡拉彼丘 Wiki'
    const forwardMsg = [
      {
        user_id: e.user_id || 10000,
        nickname,
        message: [
          `卡拉彼丘兑换码 · 共 ${codes.length} 个\n更新时间：${nowStr}\n每个兑换码单独一条消息，长按即可复制。\n标注"未知"的兑换码可能随时失效，请尽快使用。`,
        ],
      },
    ]
    for (const item of codes) {
      // 兑换码单独一条，复制时不会带上奖励说明
      forwardMsg.push({ user_id: e.user_id || 10000, nickname, message: [item.code] })
      forwardMsg.push({
        user_id: e.user_id || 10000,
        nickname,
        message: [`奖励：${item.reward}\n有效期：${item.expires}${item.section ? `（${item.section}）` : ''}`],
      })
    }

    try {
      const msg = await this._makeForwardMsg(e, forwardMsg)
      await e.reply(msg)
      return true
    } catch (err) {
      logger.warn(`[KlbqWiki] 兑换码合并转发失败，改为文字发送: ${err}`)
    }

    const lines = [`更新时间：${nowStr}`, '']
    for (const item of codes) {
      lines.push(`${item.code}`)
      lines.push(`奖励：${item.reward}`)
      lines.push(`有效期：${item.expires}${item.section ? `（${item.section}）` : ''}`, '')
    }
    lines.push('提示：标注“未知”的兑换码可能随时失效，请尽快使用。')
    return await this.sendTextCard(e, '卡拉彼丘兑换码', lines.join('\n').trim(), '兑换码')
  }

  /**
   * 判断"未找到条目"时是否保持静默
   * - not_found_reply 关闭：全部静默
   * - 显式前缀（#klbq / #卡丘 / #卡拉彼丘 / /klbq）：用户意图明确，正常回复提示
   * - 裸 - 前缀且不含中日韩文字：多为聊天内容（如 -xxx、-abc），静默忽略
   * @param {Object} e 消息事件
   * @param {string} query 查询内容
   * @returns {boolean} true 表示静默，不回复
   */
  _staySilentOnMiss(e, query) {
    if (this.config.not_found_reply === false) return true
    const msg = e?.msg || ''
    if (/^(?:\/|#)(?:klbq|卡拉彼丘|卡丘)/i.test(msg)) return false
    return !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(query)
  }

  /**
   * 角色语音查询
   * 用法：
   *   -心夏语音        按分类合并转发语音列表（多语言分开、中文优先，每条带序号）
   *   -心夏语音 机动   按关键词筛选，单张列表图片，不分类
   *   -1 / -2 ...      点选序号收听语音（有时效，仅查询者本人，每个用户相互独立）
   */
  async handleVoice(e, roleQuery, keyword) {
    const role = this.aliasMap.get(roleQuery.toLowerCase()) || roleQuery
    let page = await this.wiki.queryPage(role)
    if (!page) {
      const found = await this.wiki.searchTitle(role)
      page = found ? await this.wiki.queryPage(found) : null
    }
    if (!page) return await this.sendTextCard(e, '未找到角色', `未找到角色"${roleQuery}"。`, '查询提示')
    const title = page.title || role

    const groups = await this.wiki.roleVoices(title, this._voiceCacheTtlDays()).catch((err) => {
      logger.warn(`[KlbqWiki] 获取语音列表失败: ${err}`)
      return undefined
    })
    if (groups === undefined) {
      return await this.sendTextCard(e, '网络错误', '获取语音列表失败，可能是网络波动，请稍后重试。', '查询提示')
    }
    if (!groups || !groups.length) {
      return await this.sendTextCard(e, '暂无语音', `"${title}"没有可解析的语音台词页面。`, '查询提示')
    }

    const prefix = extractPrefix(e.msg)
    const LANG_NAMES = { CN: '中文', JP: '日文', EN: '英文' }
    const ttlMin = Math.round(this._voiceTtlMs() / 60000)

    // 拍平并全局编号：语言（中文优先）→ 分类 → 页面原顺序
    // 合并消息中先出中文版全部分类卡片，再依次出日文、英文卡片
    let id = 0
    const all = []
    const byLangCat = []
    for (const lang of ['CN', 'JP', 'EN']) {
      for (const g of groups) {
        const voices = g.voices.filter((v) => v.lang === lang)
        if (!voices.length) continue
        const items = voices.map((v) => {
          id++
          const item = { ...v, id, category: g.category, langName: LANG_NAMES[lang] || lang }
          all.push(item)
          return item
        })
        byLangCat.push({ lang, langName: LANG_NAMES[lang] || lang, category: g.category, voices: items })
      }
    }
    const langCounts = ['CN', 'JP', 'EN']
      .map((lang) => ({ lang, n: all.filter((v) => v.lang === lang).length }))
      .filter((x) => x.n > 0)

    // 关键词模式：不分类，重新按 1..N 编号，单张列表图
    const kw = (keyword || '').trim()
    if (kw) {
      const lower = kw.toLowerCase()
      const matches = all.filter(
        (v) => v.text.toLowerCase().includes(lower) || v.scene.toLowerCase().includes(lower),
      )
      if (!matches.length) {
        return await this.sendTextCard(e, '未找到语音', `"${title}"没有包含"${kw}"的语音。`, '语音查询')
      }
      const rows = matches.map((v, i) => ({ ...v, id: i + 1 }))
      this._setVoiceSession(e, { role: title, voices: matches })

      const img = await this._renderVoiceCard({
        title: `${title}语音`,
        kind: `关键词"${kw}" · 匹配 ${matches.length} 条 / 共 ${all.length} 条`,
        sections: [{ name: '', langCls: '', rows }],
        tip: `发送 ${prefix}1 ~ ${prefix}${rows.length} 收听对应语音（${ttlMin} 分钟内有效，仅你本人可用）`,
      })
      if (img) {
        await e.reply(img)
        return true
      }
      if (this.config.render_image && puppeteer && !renderSettings(this.config).fallback) {
        return await e.reply('语音列表渲染失败，请稍后重试。')
      }
      const lines = [`【${title}语音】关键词"${kw}" · 匹配 ${matches.length} 条`]
      for (const v of rows) lines.push(`${v.id}. [${v.langName}][${v.scene}] ${v.text}`)
      lines.push('', `发送 ${prefix}1 ~ ${prefix}${rows.length} 收听对应语音（${ttlMin} 分钟内有效，仅你本人可用）`)
      return await e.reply(lines.join('\n'))
    }

    // 完整列表：先中文版全部分类卡片，再依次日文、英文，合并转发为一条消息
    this._setVoiceSession(e, { role: title, voices: all })
    const total = all.length
    const nickname = '卡拉彼丘 Wiki'
    const tipText = `发送 ${prefix}1 ~ ${prefix}${total} 收听对应语音（${ttlMin} 分钟内有效，仅你本人可用）`
    const langSummary = langCounts.map((x) => `${LANG_NAMES[x.lang]} ${x.n} 条`).join(' / ')
    const forwardMsg = [
      {
        user_id: e.user_id || 10000,
        nickname,
        message: [
          `【${title}语音】共 ${total} 条（${langSummary}）\n${tipText}\n关键词筛选：${prefix}${title}语音 关键词`,
        ],
      },
    ]

    // 渲染各"语言×分类"卡片（并行渲染提速；任一失败则整体回退文字，保证序号一致）
    // voice_list_image 关闭时直接走纯文字合并转发（秒发）
    const useImage = this.config.voice_list_image !== false && !!this.config.render_image && !!puppeteer
    if (useImage) {
      const cards = byLangCat.map((g, gi) => ({
        title: `${title}语音 · ${g.langName} · ${g.category}`,
        kind: `第 ${g.voices[0].id}-${g.voices[g.voices.length - 1].id} 条 / 共 ${total} 条`,
        // 卡片标题已含语言，行内不再重复显示语言标签（langName 仅关键词卡需要）
        sections: [{ name: '', langCls: g.lang.toLowerCase(), rows: g.voices.map((v) => ({ id: v.id, scene: v.scene, text: v.text, lang: v.lang })) }],
        tip: gi === 0 ? tipText : '',
      }))
      // 并行渲染（TRSS puppeteer 每次截图独立 newPage，支持并发）
      const images = await this._renderVoiceCardsParallel(cards)
      if (images.every(Boolean)) {
        for (const img of images) {
          forwardMsg.push({ user_id: e.user_id || 10000, nickname, message: [img] })
        }
        try {
          const msg = await this._makeForwardMsg(e, forwardMsg)
          await e.reply(msg)
          return true
        } catch (err) {
          logger.warn(`[KlbqWiki] 语音列表合并转发失败，改为逐条发送: ${err}`)
          for (const node of forwardMsg) await e.reply(node.message[0])
          return true
        }
      }
    }

    // 文字回退：合并转发纯文字（保留相同序号与排序）
    for (const g of byLangCat) {
      const lines = [`【${title}语音 · ${g.langName} · ${g.category}】`]
      for (const v of g.voices) lines.push(`${v.id}. [${v.scene}] ${v.text}`)
      forwardMsg.push({ user_id: e.user_id || 10000, nickname, message: [lines.join('\n')] })
    }
    try {
      const msg = await this._makeForwardMsg(e, forwardMsg)
      await e.reply(msg)
    } catch (err) {
      logger.warn(`[KlbqWiki] 语音文字合并转发失败，改为逐条发送: ${err}`)
      for (const node of forwardMsg) await e.reply(node.message[0])
    }
    return true
  }

  /**
   * 语音点选：-1 -2 ...
   * 仅查询者本人在会话有效期内可用；无会话或已超时时静默忽略
   * 每个用户的会话相互独立（按 user_id 区分）
   */
  async onVoicePick(e) {
    const m = (e.msg || '').trim().match(/^-(\d{1,4})$/)
    if (!m) return false
    let session = this._voiceSessions.get(e.user_id)
    if (!session) {
      // 内存未命中：尝试从磁盘恢复（插件热重载/重启后内存会话丢失的场景）
      this._loadVoiceSessions()
      session = this._voiceSessions.get(e.user_id)
    }
    if (!session) return false
    if (Date.now() > session.expiresAt) {
      this._voiceSessions.delete(e.user_id)
      // 有会话但已超时：提示用户重新查询（无会话的情况仍保持静默，避免聊天噪音）
      const ttlMin = Math.round(this._voiceTtlMs() / 60000)
      await e.reply(`语音点选已超时（有效期 ${ttlMin} 分钟，点选会自动续期）。\n请重新发送 -${session.role}语音 查询后再点选。`)
      return true
    }
    const id = parseInt(m[1], 10)
    if (id < 1 || id > session.voices.length) {
      await e.reply(`语音序号 ${id} 超出范围（1-${session.voices.length}）。`)
      return true
    }
    // 点选刷新时效
    session.expiresAt = Date.now() + this._voiceTtlMs()
    const voice = session.voices[id - 1]
    try {
      await this._sendVoice(e, voice)
      logger.info(`[KlbqWiki] 语音点选: user=${e.user_id} #${id} [${voice.lang}][${voice.scene}]`)
    } catch (err) {
      logger.warn(`[KlbqWiki] 语音发送失败: ${err}`)
      await e.reply(`语音发送失败：[${voice.langName}][${voice.scene}] ${voice.text}`)
    }
    return true
  }

  /**
   * 发送语音：音频不做本地持久缓存
   * 优先让适配器直接拉取远程 URL；不支持时临时下载到系统临时目录，发送后立即删除
   */
  async _sendVoice(e, voice) {
    // voice_send_local 开启时跳过远程直发，先下载到系统临时目录再发送
    // （用于适配器不支持/静默拉取远程语音失败的场景）
    if (!this.config.voice_send_local) {
      try {
        await e.reply(segment.record(voice.file))
        return
      } catch (err) {
        logger.warn(`[KlbqWiki] 语音远程发送失败，改为临时下载发送: ${err}`)
      }
    }
    const tmp = await this._downloadVoiceTmp(voice.file)
    try {
      await e.reply(segment.record(tmp))
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }

  /** 临时下载语音文件到系统临时目录（用完即删） */
  async _downloadVoiceTmp(url) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`语音下载失败 HTTP ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (!buf.length) throw new Error('语音下载内容为空')
    const tmp = path.join(os.tmpdir(), `klbq-voice-${Date.now()}-${Math.floor(Math.random() * 10000)}.mp3`)
    fs.writeFileSync(tmp, buf)
    return tmp
  }

  /** 写入语音点选会话（同一用户的新查询覆盖旧会话） */
  _setVoiceSession(e, payload) {
    // 会话积压兜底清理
    if (this._voiceSessions.size > 500) {
      const now = Date.now()
      for (const [key, value] of this._voiceSessions) {
        if (now > value.expiresAt) this._voiceSessions.delete(key)
      }
    }
    this._voiceSessions.set(e.user_id, {
      ...payload,
      expiresAt: Date.now() + this._voiceTtlMs(),
    })
    this._saveVoiceSessions()
  }

  /** 语音会话持久化到磁盘（插件热重载/重启后可恢复） */
  _saveVoiceSessions() {
    try {
      const dir = path.dirname(VOICE_SESSION_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const obj = {}
      for (const [key, value] of this._voiceSessions) obj[key] = value
      fs.writeFileSync(VOICE_SESSION_FILE, JSON.stringify(obj), 'utf8')
    } catch (err) {
      logger.warn(`[KlbqWiki] 语音会话保存失败: ${err}`)
    }
  }

  /** 从磁盘恢复未过期的语音会话 */
  _loadVoiceSessions() {
    try {
      if (!fs.existsSync(VOICE_SESSION_FILE)) return
      const obj = JSON.parse(fs.readFileSync(VOICE_SESSION_FILE, 'utf8'))
      const now = Date.now()
      for (const [key, value] of Object.entries(obj || {})) {
        if (value && Array.isArray(value.voices) && value.expiresAt > now) {
          this._voiceSessions.set(Number(key) || key, value)
        }
      }
    } catch (err) {
      logger.warn(`[KlbqWiki] 语音会话恢复失败: ${err}`)
    }
  }

  /** 语音点选会话有效期（毫秒） */
  _voiceTtlMs() {
    const sec = Math.max(30, Math.min(1800, parseInt(this.config.voice_session_ttl) || 300))
    return sec * 1000
  }

  /** 语音文本本地缓存有效期（天） */
  _voiceCacheTtlDays() {
    const v = parseInt(this.config.voice_cache_ttl)
    return Number.isFinite(v) ? Math.max(0, Math.min(365, v)) : 7
  }

  /** 渲染语音列表卡片，返回 segment 或 null */
  /** 语音卡片 JPEG 质量（越小体积越小、上传越快；文本列表 70 已清晰） */
  _voiceCardQuality() {
    const q = parseInt(this.config.voice_card_quality)
    return Number.isFinite(q) ? Math.max(40, Math.min(95, q)) : 70
  }

  async _renderVoiceCard(data) {
    if (!this.config.render_image || !puppeteer) return null
    const { cardWidth, timeout } = renderSettings(this.config)
    try {
      return await puppeteer.screenshot('klbq-wiki', {
        tplFile: VOICE_TEMPLATE,
        saveId: 'voice_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        imgType: 'jpeg',
        quality: this._voiceCardQuality(),
        card_width: cardWidth,
        ...data,
        // 语音卡无外部资源（纯 HTML/CSS），用 load 而非 networkidle2，单卡渲染更快
        pageGotoParams: { timeout: timeout * 1000, waitUntil: 'load' },
      })
    } catch (err) {
      logger.warn(`[KlbqWiki] 语音卡片渲染失败: ${err}`)
      return null
    }
  }

  /** 并行渲染多张语音卡片（限制并发数，避免瞬间开太多 chromium 页面） */
  async _renderVoiceCardsParallel(cards, concurrency = 4) {
    const results = new Array(cards.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, cards.length) }, async () => {
      while (cursor < cards.length) {
        const idx = cursor++
        results[idx] = await this._renderVoiceCard(cards[idx])
      }
    })
    await Promise.all(workers)
    return results
  }

  /**
   * 公告查询
   * 用法：
   *   -公告        列出近期公告（带序号，序号 1 为最新）
   *   -公告10      查看序号 10 的公告详情
   * 支持 -公告 10 空格写法与 #klbq 公告 等前缀写法
   */
  async handleAnnouncements(e, numArg) {
    const list = await this.wiki.announcements().catch((err) => {
      logger.warn(`[KlbqWiki] 获取公告列表失败: ${err}`)
      return null
    })
    if (list === null) {
      return await this.sendTextCard(e, '网络错误', '获取公告列表失败，可能是网络波动，请稍后重试。', '查询提示')
    }
    if (!list.length) {
      return await this.sendTextCard(e, '暂无公告', 'Wiki 暂无可解析的公告数据，请稍后重试。', '查询提示')
    }

    const prefix = extractPrefix(e.msg)

    // 带序号：查看单条公告详情
    if (numArg) {
      const index = parseInt(numArg, 10)
      if (!(index >= 1) || index > list.length) {
        return await this.sendTextCard(
          e,
          '序号超出范围',
          `公告序号需要在 1-${list.length} 之间，当前输入 ${index}。\n使用 ${prefix}公告 查看公告列表。`,
          '查询提示',
        )
      }
      const item = list[index - 1]
      const detail = await this.wiki.announcementDetail(item.title).catch((err) => {
        logger.warn(`[KlbqWiki] 获取公告详情失败: ${err}`)
        return null
      })
      if (!detail || !detail.blocks.length) {
        return await this.sendTextCard(e, '暂无内容', `未获取到"${item.title}"的正文内容，请稍后重试。`, '公告详情')
      }
      return await this.sendAnnouncementDetail(e, prefix, index, list.length, item, detail)
    }

    // 不带序号：列出近期公告
    const count = Math.max(5, Math.min(50, parseInt(this.config.announcement_count) || 15))
    const rows = list.slice(0, count).map((item, i) => ({
      index: i + 1,
      title: item.title,
      date: item.date,
    }))
    const kind = `近期公告 · 共 ${list.length} 条 · 序号 1 为最新`
    const tip = `查看单条详情：${prefix}公告10（序号范围 1-${list.length}）`

    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: ANNOUNCEMENT_TEMPLATE,
          saveId: 'announce_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: '公告资讯',
          kind,
          isList: true,
          rows,
          detail: {},
          blocks: [],
          truncated: false,
          limit: 0,
          sourceUrl: '',
          tip,
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 公告列表渲染失败: ${err}`)
        if (!fallback) return await e.reply('公告列表渲染失败，请稍后重试。')
      }
    }

    const lines = ['卡拉彼丘 Wiki：公告资讯', kind, '']
    for (const row of rows) {
      lines.push(`${row.index}. ${row.title}${row.date ? `（${row.date}）` : ''}`)
    }
    lines.push('', tip)
    return await e.reply(lines.join('\n'))
  }

  /** 发送公告详情卡片，正文过长时截断并提示查看 Wiki */
  async sendAnnouncementDetail(e, prefix, index, total, item, detail) {
    const MAX_CHARS = 1500
    const blocks = []
    let used = 0
    let truncated = false
    for (const block of detail.blocks) {
      if (used >= MAX_CHARS) {
        truncated = true
        break
      }
      const remain = MAX_CHARS - used
      if (block.text.length > remain) {
        blocks.push({ type: block.type, text: block.text.slice(0, remain) + '…' })
        used = MAX_CHARS
        truncated = true
        break
      }
      blocks.push(block)
      used += block.text.length
    }

    const sourceUrl = this.wiki.pageUrl(item.title)
    const kind = `公告详情 · 序号 ${index} / 共 ${total} 条`
    const tip = `查看其他公告：${prefix}公告<n>（序号范围 1-${total}）`

    if (this.config.render_image && puppeteer) {
      const { cardWidth, timeout, fallback } = renderSettings(this.config)
      try {
        const img = await puppeteer.screenshot('klbq-wiki', {
          tplFile: ANNOUNCEMENT_TEMPLATE,
          saveId: 'announce_detail_' + Date.now(),
          imgType: 'jpeg',
          quality: 88,
          title: item.title,
          kind,
          isList: false,
          rows: [],
          detail,
          blocks,
          truncated,
          limit: MAX_CHARS,
          sourceUrl,
          tip,
          card_width: cardWidth,
          pageGotoParams: { timeout: timeout * 1000, waitUntil: 'networkidle2' },
        })
        if (img) {
          await e.reply(img)
          // 正文被截断时，按配置补发原文链接方便查看全文
          if (truncated && this.config.send_detail_link) await e.reply(sourceUrl)
          return true
        }
      } catch (err) {
        logger.warn(`[KlbqWiki] 公告详情渲染失败: ${err}`)
        if (!fallback) return await e.reply('公告详情渲染失败，请稍后重试。')
      }
    }

    const lines = [`卡拉彼丘 Wiki：${item.title}`, kind, '']
    if (detail.tag) lines.push(`类型：${detail.tag}`)
    if (detail.published) lines.push(`发布时间：${detail.published}`)
    lines.push('')
    for (const block of blocks) {
      if (block.type === 'heading') lines.push(`【${block.text}】`)
      else if (block.type === 'item') lines.push(`· ${block.text}`)
      else lines.push(block.text)
    }
    if (truncated) lines.push('', `（内容较长，仅展示前 ${MAX_CHARS} 字，完整内容：${sourceUrl}）`)
    lines.push('', tip)
    return await e.reply(lines.join('\n'))
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
    if (!html) {
      return await this.sendTextCard(e, '网络错误', `获取"${roleName}"角色页面失败，可能是网络波动，请稍后重试。`, '查询提示')
    }

    const skins = this.wiki.parseSkins(html)
    if (!skins.length) {
      return await this.sendTextCard(e, '无皮肤数据', `"${roleName}"页面没有可解析的皮肤资料。`, '查询提示')
    }

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
      this._reloadStatsClient()
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
        announcement_count: [5, 50],
        voice_session_ttl: [30, 1800],
        voice_cache_ttl: [0, 365],
        voice_card_quality: [40, 95],
        grid_columns: [1, 4],
        card_width: [420, 1200],
        image_timeout: [1, 60],
        image_cache_ttl: [0, 365],
        restart_delay: [1, 30],
        stats_timeout: [5, 60],
        stats_cache_ttl: [0, 86400],
        stats_match_limit: [1, 20],
        stats_ranking_size: [1, 50],
        stats_concurrency: [1, 5],
        stats_banned_limit: [1, 50],
        stats_banned_scan_pages: [1, 20],
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
      // stats_* 这类配置改了要重建客户端，否则还是旧实例在用
      this._reloadStatsClient()
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

    // 强制更新不走 merge：直接 fetch 后硬重置到远端 main
    // 本地改动/本地提交/分支分叉等任何脏状态都能自愈
    // -c core.fileMode=false：忽略文件权限位变化
    // （部分同步工具会把文件改成 755，导致 git 误判本地修改、更新被卡住）
    const cmd = force
      ? 'git -c core.fileMode=false fetch origin && git -c core.fileMode=false reset --hard origin/main && git -c core.fileMode=false clean -fd'
      : 'git -c core.fileMode=false pull --ff-only'

    await e.reply(force ? '开始强制更新 klbq-wiki...' : '开始更新 klbq-wiki...')
    logger.info(`[KlbqWiki] 执行更新: ${cmd}`)

    try {
      const { execSync } = await import('node:child_process')
      const gitOpts = { cwd: pluginDir, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }
      // 记录更新前提交，用于强制更新的结果判断与变更摘要
      let beforeSha = ''
      try {
        beforeSha = execSync('git rev-parse HEAD', { ...gitOpts, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {}
      const output = execSync(cmd, gitOpts)
      const text = (output || '').trim()
      logger.info(`[KlbqWiki] 更新输出: ${text}`)

      // 判断是否有新提交：普通更新看 git 输出，强制更新比较前后提交
      let isUpToDate = /Already up to date|已经是最新|up-to-date/i.test(text)
      let afterSha = beforeSha
      try {
        afterSha = execSync('git rev-parse HEAD', { ...gitOpts, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {}
      if (force && beforeSha) isUpToDate = beforeSha === afterSha
      if (isUpToDate) {
        await e.reply('klbq-wiki 已是最新版本，无需更新。')
      } else {
        // 读取最新版本号
        let version = '未知'
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
          version = pkg.version || '未知'
        } catch {}

        // 解析 git 输出，生成友好摘要
        // 强制更新的输出是 reset 结果而非 pull 日志，改用 diff --stat 生成摘要
        let summaryText = text
        if (force && beforeSha && afterSha && beforeSha !== afterSha) {
          try {
            summaryText = execSync(`git diff --stat ${beforeSha} ${afterSha}`, { ...gitOpts, timeout: 10000 })
          } catch {}
        }
        const summary = parseGitPullOutput(summaryText)
        if (force && summary && beforeSha && afterSha) {
          summary.fromHash = beforeSha.slice(0, 7)
          summary.toHash = afterSha.slice(0, 7)
        }
        const lines = ['✅ klbq-wiki 更新成功！', `📦 当前版本：v${version}`]

        if (summary) {
          if (summary.fromHash && summary.toHash) {
            lines.push(`🔄 提交：${summary.fromHash} → ${summary.toHash}`)
          }
          if (summary.filesChanged > 0) {
            const stats = [`📄 变更文件：${summary.filesChanged} 个`]
            if (summary.insertions > 0 || summary.deletions > 0) {
              stats.push(`（+${summary.insertions} / -${summary.deletions}）`)
            }
            lines.push(stats.join(' '))
          }
          if (summary.files.length > 0) {
            lines.push('📝 变更文件列表：')
            for (const f of summary.files) {
              lines.push(`  · ${f}`)
            }
            if (summary.filesChanged > summary.files.length) {
              lines.push(`  · ... 等共 ${summary.filesChanged} 个文件`)
            }
          }
        } else {
          // 解析失败时回退原始输出（截断前 10 行）
          lines.push('更新日志：')
          lines.push(...text.split('\n').slice(0, 10))
        }

        // 合并重启提示到同一条消息，避免多条打扰
        if (this.config.auto_restart) {
          const delay = Math.max(1, Math.min(30, parseInt(this.config.restart_delay) || 3))
          lines.push('')
          lines.push(`🔄 ${delay} 秒后自动重启 Yunzai 以使更新生效...`)
        } else {
          lines.push('')
          lines.push('⚠️ 请手动重启 Yunzai 以使更新生效。')
        }

        await e.reply(lines.join('\n'))

        // 自动重启
        if (this.config.auto_restart) {
          await this.restartBot(e)
        }
      }
      return true
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message
      logger.error(`[KlbqWiki] 更新失败: ${stderr}`)

      // 常见错误诊断
      let hint = ''
      if (/local changes|would be overwritten|Your local changes|本地修改|本地更改|本地改动|被合并操作覆盖|被检出操作覆盖/i.test(stderr)) {
        hint = '\n本地有改动冲突，可使用 -卡拉彼丘强制更新 丢弃本地改动后重试。'
      } else if (/diverged|different histories|no common ancestor|分支已分歧|没有共同祖先/i.test(stderr)) {
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
   * 注意：重启提示已在 handleUpdate 中发送，此处不再重复回复，只执行重启逻辑
   * @param e 消息事件
   */
  async restartBot(e) {
    const delay = Math.max(1, Math.min(30, parseInt(this.config.restart_delay) || 3))

    // 延时等待消息发送完成（重启提示已在 handleUpdate 中发送）
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
