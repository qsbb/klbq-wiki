/**
 * 查询内容识别
 *
 * 插件使用 `-` 作为命令前缀，而 `-` 在聊天里非常常见
 * （列表符号、颜文字、复制粘贴的公告正文等），
 * 因此这里判断一段文本是否像"查询指令"，用于过滤误触发。
 */

/** 单行查询的最大长度（字符数，按码点计） */
const MAX_QUERY_LENGTH = 60

/**
 * 判断文本是否像一条正常的查询指令
 *
 * 判定为不像（返回 false）的情况：
 * - 为空
 * - 含换行（粘贴的多行公告、聊天记录）
 * - 超长（单行粘贴的长文本）
 * - 不含任何文字/数字（纯符号，如 "- -"、"-_-#"、"---"）
 *
 * @param {string} query 去掉前缀后的查询内容
 * @param {number} [maxLength] 长度上限
 * @returns {boolean}
 */
export function isPlausibleQuery(query, maxLength = MAX_QUERY_LENGTH) {
  if (typeof query !== 'string') return false
  const text = query.trim()
  if (!text) return false
  if (/[\r\n\u2028\u2029]/.test(text)) return false
  if ([...text].length > maxLength) return false
  if (!/[\p{L}\p{N}]/u.test(text)) return false
  return true
}

export { MAX_QUERY_LENGTH }
