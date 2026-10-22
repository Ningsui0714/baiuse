/**
 * 外科式 TOML 编辑 —— 只动自己要动的行，其余字节保持不变。
 *
 * ## 为什么不用 TOML 解析器重写整份文件
 *
 * `~/.codex/config.toml` 是**用户的文件**，里面可能有：
 * 注释、别的 provider、MCP 配置、`[features]` 开关、自定义 `sqlite_home`……
 * 用解析器读进来再序列化写回去，等于把用户的排版、注释、键顺序全部重排一遍。
 * 一次「接管/恢复」就把人家配置洗了，这是不可接受的。
 *
 * 所以这里只做两件事：
 *  1. 找到 `[model_providers.<id>]` 这一段，只改这一段
 *  2. 改顶层 `model_provider` 这一行
 *
 * 其余内容**原样保留**，连行尾符（CRLF/LF）都不变。
 *
 * ## 难点：怎么知道某一行是表头
 *
 * `[fake]` 出现在三种地方都不是表头：注释里、普通字符串里、`"""` 多行字符串里。
 * 所以先扫一遍算出「哪些行处在多行字符串内部」，判表头时跳过它们
 *（这是 cc-switch 的做法，实测踩得最狠的就是多行字符串）。
 *
 * @module src/codex/toml
 */

/** 文件用的是 CRLF 还是 LF。 */
export function detectEol(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 拆行。
 *
 * 统一用 `\n` 切，行尾的 `\r` 留在行内 —— 这样 join('\n') 之后
 * 原文件的行尾符不会被悄悄改掉。
 */
export function splitLines(text) {
  return String(text ?? '').split('\n')
}

/** 把行数组拼回文本（行内已保留 `\r`）。 */
export function joinLines(lines) {
  return lines.join('\n')
}

/**
 * 标出「处在多行字符串内部」的行。
 *
 * 支持 `"""` 与 `'''` 两种；`"""` 里反斜杠转义会被跳过。
 * 单行字符串也处理，避免 `key = "..."` 里的引号被误判成开启多行。
 *
 * @param {string[]} lines
 * @returns {boolean[]} true 表示这一行**是**多行字符串的内容行
 */
export function maskMultilineStringLines(lines) {
  let delimiter
  return lines.map(line => {
    const insideAtStart = delimiter !== undefined
    let index = 0

    while (index < line.length) {
      if (delimiter !== undefined) {
        if (delimiter === '"""' && line[index] === '\\') {
          index += 2
          continue
        }
        if (line.startsWith(delimiter, index)) {
          // 结束符前后最多还能贴两个同种引号，它们属于内容
          const quote = delimiter[0]
          let end = index + 3
          while (end < index + 5 && line[end] === quote) end += 1
          delimiter = undefined
          index = end
          continue
        }
        index += 1
        continue
      }

      const ch = line[index]
      if (ch === '#') break
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        delimiter = line.startsWith('"""', index) ? '"""' : "'''"
        index += 3
        continue
      }
      if (ch === '"') {
        index += 1
        while (index < line.length && line[index] !== '"') {
          index += line[index] === '\\' ? 2 : 1
        }
        index += 1
        continue
      }
      if (ch === "'") {
        const end = line.indexOf("'", index + 1)
        index = end === -1 ? line.length : end + 1
        continue
      }
      index += 1
    }

    // 这一行「开始时」在字符串内，就算内容行
    //（这一行把字符串关掉也一样：它不是表头）
    return insideAtStart
  })
}

/** 表头行：`[name]` 或 `[[name]]`，允许行尾注释。 */
const SECTION_HEADER = /^\s*\[\[?([^\[\]\r\n]+)\]\]?\s*(?:#.*)?$/

/** 把表名归一化：去掉两端空白与每段两侧的引号。 */
export function normalizeTableName(name) {
  return String(name ?? '')
    .split('.')
    .map(segment => segment.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.')
}

/**
 * 找某个表头的位置与范围。
 *
 * @param {string[]} lines
 * @param {string} name 归一化后的表名，如 `model_providers.ofm`
 * @returns {{headerIndex:number, bodyStart:number, bodyEnd:number}|null}
 */
export function findSection(lines, name) {
  const mask = maskMultilineStringLines(lines)
  const target = normalizeTableName(name)
  let headerIndex = -1

  for (let index = 0; index < lines.length; index += 1) {
    if (mask[index] === true) continue
    const match = SECTION_HEADER.exec(lines[index])
    if (match === null) continue

    if (headerIndex === -1) {
      if (normalizeTableName(match[1]) === target) headerIndex = index
      continue
    }

    // 下一个表头就是本段的结束
    return { headerIndex, bodyStart: headerIndex + 1, bodyEnd: index }
  }

  if (headerIndex === -1) return null
  return { headerIndex, bodyStart: headerIndex + 1, bodyEnd: lines.length }
}

/** 顶层区域的结束位置（第一个表头之前）。 */
export function findTopLevelEnd(lines) {
  const mask = maskMultilineStringLines(lines)
  for (let index = 0; index < lines.length; index += 1) {
    if (mask[index] === true) continue
    if (SECTION_HEADER.test(lines[index])) return index
  }
  return lines.length
}

/** 在指定区间里找某个键的行号。 */
function findKeyLine(lines, key, start, end) {
  const mask = maskMultilineStringLines(lines)
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let index = start; index < end; index += 1) {
    if (mask[index] === true) continue
    if (pattern.test(lines[index])) return index
  }
  return -1
}

/** 区间内最后一个非空行之后的位置（用于插新键）。 */
function insertIndexFor(lines, start, end) {
  let index = end
  while (index > start && lines[index - 1].trim() === '') index -= 1
  return index
}

/**
 * 在区间内设置一个键：有就替换，没有就插入。
 *
 * @returns {string[]} 新的行数组（不修改入参）
 */
export function setKey(lines, key, valueLiteral, start, end) {
  const next = [...lines]
  const index = findKeyLine(next, key, start, end)
  const line = `${key} = ${valueLiteral}`

  if (index !== -1) {
    next[index] = line
    return next
  }

  const at = insertIndexFor(next, start, end)
  next.splice(at, 0, line)
  return next
}

/** 在区间内删除一个键（不存在则原样返回）。 */
export function removeKey(lines, key, start, end) {
  const next = [...lines]
  const index = findKeyLine(next, key, start, end)
  if (index !== -1) next.splice(index, 1)
  return next
}

/** 读取区间内某个键的原始值文本（未去引号）。 */
export function readKeyValue(lines, key, start, end) {
  const index = findKeyLine(lines, key, start, end)
  if (index === -1) return undefined
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`).exec(lines[index])
  return match === null ? undefined : match[1].trim()
}

/** 读取区间内某个字符串键的值（去掉引号）。 */
export function readStringValue(lines, key, start, end) {
  const raw = readKeyValue(lines, key, start, end)
  if (raw === undefined) return undefined
  const match = /^"(?:[^"\\]|\\.)*"/.exec(raw)
  if (match !== null) return JSON.parse(match[0])
  const single = /^'([^']*)'/.exec(raw)
  if (single !== null) return single[1]
  return raw.replace(/\s+#.*$/, '').trim()
}

/**
 * 确保某个表存在，返回它的范围。
 *
 * 不存在就追加到文件末尾（前面留一个空行）。
 */
export function ensureSection(lines, name) {
  const existing = findSection(lines, name)
  if (existing !== null) return { lines, section: existing }

  const next = [...lines]
  // 去掉末尾多余空行，再补一个空行分隔
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
  if (next.length > 0) next.push('')
  const headerIndex = next.length
  next.push(`[${name}]`)
  next.push('')

  return { lines: next, section: { headerIndex, bodyStart: headerIndex + 1, bodyEnd: next.length } }
}

/**
 * 删除整个表（含表头）。表不存在时原样返回。
 *
 * ⚠️ 只删到「下一个表头」为止，所以后面的表不会被误删。
 */
export function removeSection(lines, name) {
  const section = findSection(lines, name)
  if (section === null) return lines

  const next = [...lines]
  let end = section.bodyEnd
  // 连带吃掉本段末尾的一个空行，避免留下连续空行
  if (end < next.length && next[end].trim() === '') end += 1
  next.splice(section.headerIndex, end - section.headerIndex)
  return next
}

/** TOML 基本字符串转义。 */
export function tomlString(value) {
  return JSON.stringify(String(value ?? ''))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
