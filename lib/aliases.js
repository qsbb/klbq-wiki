/**
 * 卡拉彼丘角色与武器别名表
 *
 * 数据来源：
 *   1. defSet/aliases.yaml     默认别名（随插件更新）
 *   2. config/aliases.yaml     用户自定义别名（覆盖默认）
 *
 * 修改任一文件后，插件会通过 chokidar 监听变更并自动重新加载，无需重启。
 * 英文别名在解析时不区分大小写。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const DEFAULT_FILE = path.join(PLUGIN_ROOT, 'defSet', 'aliases.yaml')
const USER_FILE = path.join(PLUGIN_ROOT, 'config', 'aliases.yaml')

// 缓存的别名 Map（小写别名 -> 角色名）
let _aliasMap = null
let _watcherInitialized = false

/**
 * 解析简单的 YAML（仅支持 "角色名:" + "  - 别名" 列表格式）
 * 不依赖 yaml 库，避免增加依赖
 * @param {string} text YAML 文本
 * @returns {Object} 角色名 -> 别名数组
 */
function parseAliasesYaml(text) {
  const result = {}
  if (!text) return result
  let currentKey = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    // 跳过注释和空行
    if (!line.trim() || line.trim().startsWith('#')) continue
    // 角色名行：`角色名:` 或 `角色名:`
    const keyMatch = line.match(/^([^:\s#][^:]*):\s*$/)
    if (keyMatch) {
      currentKey = keyMatch[1].trim()
      if (!result[currentKey]) result[currentKey] = []
      continue
    }
    // 别名行：`  - 别名`（前置空格缩进）
    const itemMatch = line.match(/^\s+-\s+(.+?)\s*$/)
    if (itemMatch && currentKey) {
      result[currentKey].push(itemMatch[1].trim())
      continue
    }
    // 行内格式：`角色名: [别名1, 别名2]` 或 `角色名: 别名`
    const inlineMatch = line.match(/^([^:\s#][^:]*):\s*(.+)$/)
    if (inlineMatch) {
      const key = inlineMatch[1].trim()
      const val = inlineMatch[2].trim()
      if (!result[key]) result[key] = []
      if (val.startsWith('[') && val.endsWith(']')) {
        // 数组格式
        const items = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        result[key].push(...items)
      } else if (val) {
        result[key].push(val)
      }
    }
  }
  return result
}

/**
 * 读取 YAML 文件（文件不存在返回空对象）
 */
function readYaml(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {}
    const text = fs.readFileSync(filePath, 'utf8')
    return parseAliasesYaml(text)
  } catch (err) {
    logger?.warn?.(`[KlbqWiki] 读取别名文件失败 ${filePath}: ${err}`)
    return {}
  }
}

/**
 * 从默认 + 用户配置构建别名 Map
 * 用户配置完全覆盖默认配置（同角色名时合并去重）
 * @returns {Map<string, string>} 小写别名 -> 角色名
 */
function buildMap() {
  const defaults = readYaml(DEFAULT_FILE)
  const userDefs = readYaml(USER_FILE)
  const map = new Map()

  // 合并：用户配置覆盖默认配置
  const merged = { ...defaults }
  for (const [role, aliases] of Object.entries(userDefs)) {
    if (merged[role]) {
      // 用户配置覆盖默认的同角色别名
      merged[role] = [...aliases]
    } else {
      merged[role] = [...aliases]
    }
  }

  // 角色名本身作为别名，然后加入所有别名
  for (const [role, aliases] of Object.entries(merged)) {
    map.set(role.toLowerCase(), role)
    for (const alias of aliases) {
      if (alias) map.set(alias.toLowerCase(), role)
    }
  }

  return map
}

/**
 * 初始化文件监听（chokidar 可用时）
 */
function initWatcher() {
  if (_watcherInitialized) return
  _watcherInitialized = true
  try {
    // 优先使用全局 chokidar（Yunzai 环境）
    let chokidar = null
    try {
      chokidar = require('chokidar')
    } catch {
      try {
        chokidar = global.chokidar
      } catch {}
    }
    if (!chokidar) return

    const watchFile = (filePath) => {
      if (!fs.existsSync(filePath)) return
      const watcher = chokidar.watch(filePath)
      watcher.on('change', () => {
        logger?.mark?.(`[KlbqWiki] 别名配置变更，重新加载: ${filePath}`)
        _aliasMap = buildMap()
      })
      watcher.on('unlink', () => {
        logger?.mark?.(`[KlbqWiki] 别名配置被删除: ${filePath}`)
        _aliasMap = buildMap()
      })
    }
    watchFile(DEFAULT_FILE)
    watchFile(USER_FILE)

    // 同时监听 config 目录，用户首次创建 config/aliases.yaml 时能感知
    const configDir = path.dirname(USER_FILE)
    if (fs.existsSync(configDir)) {
      const dirWatcher = chokidar.watch(configDir)
      dirWatcher.on('add', (filePath) => {
        if (filePath === USER_FILE) {
          logger?.mark?.(`[KlbqWiki] 检测到用户别名配置创建: ${filePath}`)
          _aliasMap = buildMap()
        }
      })
    }
  } catch (err) {
    logger?.warn?.(`[KlbqWiki] 初始化别名文件监听失败: ${err}`)
  }
}

/**
 * 获取别名 Map（懒加载 + 缓存）
 * @returns {Map<string, string>} 小写别名 -> 角色名
 */
export function getAliasMap() {
  if (_aliasMap === null) {
    _aliasMap = buildMap()
    initWatcher()
  }
  return _aliasMap
}

/**
 * 强制重新加载别名（供测试或手动刷新使用）
 */
export function reloadAliases() {
  _aliasMap = buildMap()
  return _aliasMap
}

/**
 * 兼容旧接口：构建别名 Map
 * @param {string} customAliasesText 旧版自定义别名文本（每行 "别名=角色名"），已废弃但仍兼容
 * @returns {Map<string, string>} 小写别名 -> 角色名
 */
export function buildAliasMap(customAliasesText = '') {
  const map = getAliasMap()
  // 兼容旧版 custom_aliases 配置项（文本格式 "别名=角色名"）
  const text = (customAliasesText || '').trim()
  if (text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('=')) continue
      const idx = line.indexOf('=')
      const alias = line.slice(0, idx).trim()
      const title = line.slice(idx + 1).trim()
      if (alias && title) {
        map.set(alias.toLowerCase(), title)
      }
    }
  }
  return map
}

// 保留导出（向后兼容）
export const BUILTIN_ALIASES = {}

export const ROLE_FIELDS = [
  '名称', '英文名', '日文名', '别名', '性别', '身份', '定位', '阵营',
  '声优', '生日', '星座', '年龄', '身高', '体重', '活动区域',
  '超弦体特性', '兴趣爱好', '饮食习惯', '个性语录', '简介', '观测语录',
  '武器', '武器类型',
]

export const WEAPON_FIELDS = [
  '名称', '使用者', '归属角色', '角色', '类型', '武器类型', '介绍',
  '开火模式', '辅助攻击', '放大倍率', '射速', '射速（移动端）',
  '瞄准速度', '瞄准速度（移动端）', '散射控制', '后坐力控制',
  '弹匣容量', '装填速度', '蓄力速度', '弦化伤害',
  '10米伤害', '20米伤害', '30米伤害', '40米伤害', '50米伤害',
  '基础伤害', '部位系数', '拉栓时间', '换弹动作时间', '后坐力恢复时间',
  '蓄力时间', '等待开镜时间', '初段蓄力时间', '完成蓄力时间',
  '移动速度', '持枪移速', '开镜移速', '跑步速度', '举枪速度',
  '精准度', '后坐力', '穿透', '原型', '简介',
]

export const FIELD_ALIASES = {
  '移动速度': ['移速', '持枪移速', '持枪移动速度', '移动速度', '超弦体移速'],
  '开镜移速': ['开镜移动速度', '开镜移速', 'ADS移速', '瞄准移动速度'],
  '弹匣容量': ['弹匣', '载弹量', '弹夹容量', '弹匣容量'],
  '装填速度': ['换弹', '换弹速度', '换弹时间', '装填时间', '装填速度'],
  '头部伤害': ['爆头伤害', '头部伤害', '头部'],
  '身体伤害': ['躯干伤害', '身体伤害', '上肢', '身体'],
  '腿部伤害': ['腿部伤害', '下肢', '腿部'],
  '使用者': ['使用者', '归属角色', '角色'],
}
