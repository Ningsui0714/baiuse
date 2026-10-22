/**
 * 工具名与模型 id 的基础工具函数。
 *
 * ## 为什么单独一个文件
 *
 * 上游（dsh-our-free-model）的 `src/messages.js` 需要这三个函数，但它 import 自
 * `src/upstream.js` —— 而 `upstream.js` 整个是**免费聚合线**的实现：它伪装
 * 官方 opencode 客户端的 UA 与工具定义（`FINGERPRINT_TOOL_DEFINITIONS` 里逐字抄了
 * 官方 CLI 的 read/shell 描述），并按模型 id 分派到 `/inference/v1/*`。
 *
 * 那条车道已下线（冒充官方客户端不成立），所以我们**不 vendor 整个 upstream.js**，
 * 只把这三个与车道无关的纯函数挑出来放在这里。
 *
 * 与上游的差异：
 *  - 少了 `MAX_TOOL_NAME_LEN` 之外的一切指纹相关常量
 *  - `restoreToolName` 的映射语义不变（还原被改写的工具名）
 */

/** 上游允许的工具名长度上限。 */
export const MAX_TOOL_NAME_LEN = 128

/**
 * 取模型 id 的「基名」—— 去掉尾部括号里的标签。
 *
 * 例：`mimo-v2.6-flash-free (region)` → `mimo-v2.6-flash-free`
 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/**
 * 还原被改写的工具名。
 *
 * 上游的免费线有「工具指纹闸门」：上游要求 read/shell 两个工具的定义与官方
 * 客户端逐字一致，于是本地把调用方的工具名换成占位名再发出去，响应侧再换回来。
 * 渠道包线没有这道闸门（各家客户端的真实工具名直接透传）。
 *
 * 本函数仍然保留，是因为它同时服务于**渠道侧**的一个场景：
 * 有些渠道对工具名有长度/字符集限制，需要临时缩短再还原。
 * `map` 为空时是恒等函数 —— 这是最常见的情况。
 */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}
