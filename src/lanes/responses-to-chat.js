/**
 * Responses → Chat Completions 的**请求方向**转换。
 *
 * ## 为什么需要
 *
 * Codex CLI 只说 Responses 协议（`input` / `instructions` / `max_output_tokens`）。
 * 但 Kilo 车道与多数聚合 provider 的 OpenAI 兼容端点只吃
 * Chat Completions（`messages` / `max_tokens`）。
 *
 * 这是一次**请求方向**的改写，不是响应方向的。
 * （响应方向由 `sse.js` 处理：各家的流事件 → 统一 chunk。）
 *
 * ## 字段对照
 *
 * | Responses | Chat Completions |
 * |---|---|
 * | `instructions` | `messages[0]` = `{role:'system'}` |
 * | `input`（字符串或数组） | `messages[]` |
 * | `input[].content[].type==='input_text'` | `content` 字符串 |
 * | `input[].content[].type==='output_text'` | 同上（历史轮次里的助手消息） |
 * | `input[].type==='function_call'` | `{role:'assistant', tool_calls:[…]}` |
 * | `input[].type==='function_call_output'` | `{role:'tool', tool_call_id, content}` |
 * | `max_output_tokens` | `max_tokens` |
 * | `reasoning.effort` | `reasoning_effort` |
 * | `tools[].type==='function'` | `tools[].function = {…}`（**去掉外层 type**） |
 * | `tools[].type==='namespace'` | 摊平成 `<ns>__<child>` 命名 |
 * | `tools[].type==='custom'` / `'tool_search'` | 丢弃（记日志，不报错） |
 *
 * ## 工具名的摊平
 *
 * Codex 0.142+ 用私有扩展声明工具：`{type:'namespace', name, tools:[…]}` 分组容器。
 * Chat Completions 没有这个概念，只能摊平成带前缀的名字。
 * 命名规则 `<namespace>__<tool>` —— 与上游 dsh `openai-gateway/responses.ts` 的
 * `flatNamespaceToolName` 一致，避免两边行为不一致。
 */

/** 把 namespace 工具摊平成 Chat 能表达的形状。 */
function flattenTools(tools, onDrop) {
  const list = []
  for (const tool of tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue

    if (tool.type === 'function') {
      // Responses 的形状：{type:'function', name, description, parameters}
      // Chat 要的是：{type:'function', function:{name, description, parameters}}
      const fn = tool.function ?? {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }
      list.push({ type: 'function', function: fn })
      continue
    }

    if (tool.type === 'namespace') {
      const ns = typeof tool.name === 'string' ? tool.name : ''
      for (const child of tool.tools ?? []) {
        if (child === null || typeof child !== 'object') continue
        if (child.type !== 'function') {
          onDrop?.(child)
          continue
        }
        const fn = child.function ?? {
          name: child.name,
          description: child.description,
          parameters: child.parameters,
        }
        list.push({
          type: 'function',
          function: { ...fn, name: `${ns}__${fn.name ?? ''}` },
        })
      }
      continue
    }

    // `custom` / `tool_search` / `web_search` 等 Chat 表达不了的类型：
    // **丢弃并记日志，而不是报错**。
    // 报错会让整轮对话不可用 —— 那是比少几个工具严重得多的问题。
    onDrop?.(tool)
  }
  return list
}

/** 把 Responses 的 `input` 摊平成 Chat 的 `messages`。 */
function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []

  const messages = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue

    if (item.type === 'message' || typeof item.role === 'string') {
      const content = contentToText(item.content)
      if (content === '') continue
      messages.push({ role: item.role ?? 'user', content })
      continue
    }

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id ?? item.id ?? 'call_0',
          type: 'function',
          function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
        }],
      })
      continue
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id ?? item.id ?? 'call_0',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      })
      continue
    }

    if (item.type === 'reasoning') {
      // 思考块在 Chat 协议里没有对应位置，跳过。
      continue
    }
  }
  return messages
}

/** 把 content（字符串或块数组）压成一段文本。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const part of content) {
    if (typeof part === 'string') { text += part; continue }
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      text += part.text ?? ''
      continue
    }
    if (part.type === 'refusal') {
      text += part.refusal ?? ''
    }
  }
  return text
}

/**
 * 把 Responses 请求体改写成 Chat Completions 请求体。
 *
 * @param {object} body Responses 形态的请求体
 * @param {(dropped: object) => void} [onDrop] 被丢弃的工具类型的回调
 * @returns {object} Chat 形态的请求体
 */
export function responsesToChat(body, onDrop) {
  const messages = []

  // `instructions` → system 消息
  if (typeof body.instructions === 'string' && body.instructions !== '') {
    messages.push({ role: 'system', content: body.instructions })
  }
  messages.push(...inputToMessages(body.input ?? body.messages))

  const result = { model: body.model, messages }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = flattenTools(body.tools, onDrop)
    if (tools.length > 0) result.tools = tools
  }

  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    // Chat 只认这三个值。Responses 的对象形态（如 `{type:'function',name}`）
    // 在 Chat 里对应 `{type:'function', function:{name}}`。
    if (typeof body.tool_choice === 'object' && body.tool_choice !== null) {
      const name = body.tool_choice.name
      if (typeof name === 'string' && name !== '') {
        result.tool_choice = { type: 'function', function: { name } }
      }
    }
    // 其它形态无法表达 → 不下发（Chat 的默认是 auto）
  }

  if (typeof body.max_output_tokens === 'number') result.max_tokens = body.max_output_tokens
  if (typeof body.temperature === 'number') result.temperature = body.temperature
  if (typeof body.reasoning?.effort === 'string' && body.reasoning.effort !== '') {
    result.reasoning_effort = body.reasoning.effort
  }
  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls
  if (body.stream === true) result.stream = true

  return result
}
