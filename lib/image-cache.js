/**
 * 图片本地缓存
 *
 * 图片 URL 经 MD5 哈希后作为本地文件名，存到插件 data/images/ 目录。
 * 下次查询同一图片时直接读取本地文件，避免重复网络下载。
 *
 * 适用于：
 * - puppeteer 渲染卡片时的 <img src="...">（puppeteer 支持本地文件路径）
 * - segment.image(url) 发送图片（Yunzai 支持本地文件路径）
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'klbq-wiki'
// 使用绝对路径：puppeteer 渲染时需要 file:// URL，segment.image 需要绝对路径
// 相对路径在 puppeteer 的 page.setContent 中无法正确解析（base 是 about:blank）
const CACHE_DIR = path.resolve(process.cwd(), 'plugins', PLUGIN_NAME, 'data', 'images')

// 兼容 Yunzai 全局 logger（测试环境可能不存在）
const safeLogger = typeof logger !== 'undefined' ? logger : null
const log = (msg) => safeLogger?.warn?.(msg)

// 文件扩展名映射（从 URL 或 Content-Type 推断）
const EXT_MAP = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
}

/**
 * 将本地路径转换为 file:// URL，供 puppeteer 的 <img src> 使用
 * - 本地绝对路径 → file:// URL
 * - 远程 URL（http/https）→ 原样返回
 * - file:// URL → 原样返回
 * - 空值 → 原样返回
 */
export function toFileUrl(p) {
  if (!p) return p
  if (/^https?:\/\//i.test(p)) return p
  if (/^file:\/\//i.test(p)) return p
  try {
    return pathToFileURL(path.resolve(p)).href
  } catch (_) {
    return p
  }
}

export class ImageCache {
  /**
   * @param {Object} options
   * @param {boolean} options.enabled 是否启用缓存（默认 true）
   * @param {number} options.ttl 缓存有效期（秒，默认 30 天）
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.ttl = Math.max(0, Number(options.ttl) || 30 * 86400)
    this._dir = CACHE_DIR
    this._ensureDir()
  }

  /** 确保缓存目录存在 */
  _ensureDir() {
    try {
      if (!fs.existsSync(this._dir)) {
        fs.mkdirSync(this._dir, { recursive: true })
      }
    } catch (err) {
      // 目录创建失败不影响主流程，后续 get 会返回原始 URL
      log(`[KlbqWiki] 缓存目录创建失败: ${err}`)
      this.enabled = false
    }
  }

  /** 从 URL 推断文件扩展名 */
  _extFromUrl(url) {
    try {
      const u = new URL(url)
      const pathname = u.pathname.toLowerCase()
      const m = pathname.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/)
      if (m) return EXT_MAP[m[1]] || 'jpg'
    } catch (_) {
      // ignore
    }
    return 'jpg'
  }

  /** 计算 URL 的本地缓存路径 */
  _pathFor(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex')
    const ext = this._extFromUrl(url)
    return path.join(this._dir, `${hash}.${ext}`)
  }

  /** 检查本地缓存是否有效（存在且未过期） */
  _isValid(localPath) {
    try {
      const stat = fs.statSync(localPath)
      if (!stat.isFile() || stat.size === 0) return false
      if (this.ttl === 0) return true // 永不过期
      const ageSec = (Date.now() - stat.mtimeMs) / 1000
      return ageSec < this.ttl
    } catch (_) {
      return false
    }
  }

  /**
   * 获取图片，优先从本地缓存读取，否则下载到本地
   * @param {string} url 远程图片 URL
   * @returns {Promise<string>} 本地文件路径（缓存启用且成功时）或原始 URL（缓存禁用或下载失败时）
   */
  async get(url) {
    if (!url) return url
    if (!this.enabled) return url

    const localPath = this._pathFor(url)

    // 1. 本地有效缓存，直接返回
    if (this._isValid(localPath)) {
      return localPath
    }

    // 2. 下载到本地
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) {
        log(`[KlbqWiki] 缓存图片下载失败 HTTP ${resp.status}: ${url.slice(0, 100)}`)
        return url
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length === 0) return url
      fs.writeFileSync(localPath, buf)
      return localPath
    } catch (err) {
      log(`[KlbqWiki] 缓存图片下载异常: ${err}`)
      return url
    }
  }

  /**
   * 批量获取图片（并发控制）
   * @param {string[]} urls
   * @returns {Promise<string[]>} 与 urls 顺序对应的结果数组
   */
  async getMany(urls, concurrency = 4) {
    if (!this.enabled) return [...urls]
    const results = new Array(urls.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (cursor < urls.length) {
        const idx = cursor++
        results[idx] = await this.get(urls[idx])
      }
    })
    await Promise.all(workers)
    return results
  }

  /** 清理过期缓存文件 */
  cleanup() {
    if (!this.enabled || this.ttl === 0) return 0
    let cleaned = 0
    try {
      const files = fs.readdirSync(this._dir)
      const now = Date.now()
      for (const file of files) {
        const full = path.join(this._dir, file)
        try {
          const stat = fs.statSync(full)
          if (stat.isFile() && (now - stat.mtimeMs) / 1000 > this.ttl) {
            fs.unlinkSync(full)
            cleaned++
          }
        } catch (_) {
          // 单文件清理失败跳过
        }
      }
    } catch (_) {
      // ignore
    }
    return cleaned
  }

  /**
   * 统计缓存情况
   * @returns {{ count: number, sizeBytes: number, dir: string }}
   */
  stats() {
    let count = 0
    let sizeBytes = 0
    try {
      const files = fs.readdirSync(this._dir)
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(this._dir, file))
          if (stat.isFile()) {
            count++
            sizeBytes += stat.size
          }
        } catch (_) {
          // ignore
        }
      }
    } catch (_) {
      // ignore
    }
    return { count, sizeBytes, dir: this._dir }
  }
}
