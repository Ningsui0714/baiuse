/** Client-facing Messages / Chat Completions / Gemini adapters.
 * The lane and failover engine remain the single inference path.
 */
import crypto from 'node:crypto'
import { createFailoverComplete } from '../failover.js'
import { DESKTOP_MODEL } from './config.mjs'
import { normalizeUsage } from '../lanes/sse.js'

const invalid = message => Object.assign(new Error(message), { status: 400 })
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const json = value => JSON.stringify(value)
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n')

function geminiSchema(value) {
  if (Array.isArray(value)) return value.map(geminiSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'propertyOrdering').map(([key, item]) => [key, key === 'type' && typeof item === 'string' ? item.toLowerCase() : geminiSchema(item)]))
}

function anthropicPart(part) {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image' && part.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } }
  if (part.type === 'image' && part.source?.type === 'url') return { type: 'image_url', image_url: { url: part.source.url } }
  throw invalid(`暂未支持的 Messages 内容类型：${part.type}`)
}
export function messagesToChat(body) {
  if (!Array.isArray(body.messages)) throw invalid('messages 应为数组')
  const messages = []
  if (body.system) messages.push({ role: 'system', content: textOf(body.system) })
  for (const message of body.messages) {
    if (!['user', 'assistant'].includes(message.role)) throw invalid('Messages role 应为 user 或 assistant')
    if (typeof message.content === 'string') { messages.push({ ...message }); continue }
    if (!Array.isArray(message.content)) throw invalid('Messages content 应为字符串或数组')
    const content = [], calls = [], results = []
    for (const part of message.content) {
      if (part.type === 'tool_use') calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: json(part.input ?? {}) } })
      else if (part.type === 'tool_result') results.push({ role: 'tool', tool_call_id: part.tool_use_id, content: textOf(part.content) })
      else if (part.type === 'thinking' || part.type === 'redacted_thinking') continue
      else content.push(anthropicPart(part))
    }
    // Tool outputs precede any new user text, as expected by Chat tool history.
    messages.push(...results)
    if (content.length || calls.length) messages.push({ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) })
  }
  const choice = body.tool_choice
  return {
    model: body.model, messages, stream: body.stream === true,
    max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stop: body.stop_sequences,
    ...(body.tools?.length ? { tools: body.tools.map(tool => {
      if (!tool.name || tool.type?.startsWith('web_') || tool.type?.startsWith('computer_')) throw invalid('仅支持客户端执行的自定义工具；服务端工具尚未接入')
      return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema ?? {} } }
    }) } : {}),
    ...(choice ? { tool_choice: choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type === 'none' ? 'none' : 'auto' } : {}),
  }
}

export function geminiToChat(body, model) {
  if (!Array.isArray(body.contents)) throw invalid('contents 应为数组')
  const messages = [], callIds = new Map()
  if (body.systemInstruction) messages.push({ role: 'system', content: textOf(body.systemInstruction.parts) })
  for (const message of body.contents) {
    const content = [], calls = [], results = []
    for (const part of message.parts ?? []) {
      if (part.functionCall) {
        const call = part.functionCall
        const callId = call.id || id('call')
        const queue = callIds.get(call.name) ?? []
        queue.push(callId); callIds.set(call.name, queue)
        calls.push({ id: callId, type: 'function', function: { name: call.name, arguments: json(call.args ?? {}) } })
      } else if (part.functionResponse) {
        const result = part.functionResponse
        results.push({ role: 'tool', tool_call_id: result.id || callIds.get(result.name)?.shift() || result.name, content: json(result.response ?? {}) })
      } else if (part.text !== undefined) {
        if (!part.thought) content.push({ type: 'text', text: part.text })
      } else if (part.inlineData?.mimeType?.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } })
      else throw invalid('暂未支持的 Gemini 内容类型（支持文本、图片与函数调用）')
    }
    messages.push(...results)
    if (content.length || calls.length) messages.push({ role: message.role === 'model' ? 'assistant' : 'user', content, ...(calls.length ? { tool_calls: calls } : {}) })
  }
  const declarations = (body.tools ?? []).flatMap(tool => {
    if (!tool.functionDeclarations) throw invalid('暂未支持 Gemini 服务端工具')
    return tool.functionDeclarations
  })
  const config = body.generationConfig ?? {}
  const mode = body.toolConfig?.functionCallingConfig
  return { model, messages, max_tokens: config.maxOutputTokens, temperature: config.temperature, top_p: config.topP, stop: config.stopSequences,
    ...(declarations.length ? { tools: declarations.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: geminiSchema(tool.parametersJsonSchema ?? tool.parameters ?? {}) } })) } : {}),
    ...(mode?.mode === 'NONE' ? { tool_choice: 'none' } : mode?.mode === 'ANY' ? { tool_choice: mode.allowedFunctionNames?.length === 1 ? { type: 'function', function: { name: mode.allowedFunctionNames[0] } } : 'required' } : {}),
  }
}

export function clientRoute(pathname) {
  if (['/v1/messages/count_tokens', '/claude-desktop/v1/messages/count_tokens'].includes(pathname)) return { protocol: 'anthropic', desktop: pathname.startsWith('/claude-desktop/'), countTokens: true }
  if (['/v1/messages', '/messages', '/claude-desktop/v1/messages'].includes(pathname)) return { protocol: 'anthropic', desktop: pathname.startsWith('/claude-desktop/') }
  if (['/v1/chat/completions', '/chat/completions'].includes(pathname)) return { protocol: 'chat' }
  const match = /^\/(?:v1beta|v1)\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(pathname)
  if (match) return { protocol: 'gemini', model: decodeURIComponent(match[1]), streaming: match[2] === 'streamGenerateContent', countTokens: match[2] === 'countTokens' }
  return null
}

/** Stream native text immediately; assemble tool JSON before exposing complete calls.
 * This preserves valid arguments even when upstream splits a JSON token mid-byte.
 */
export async function serveClientInference({ req, res, route, body, lanes, cooldowns, affinity, maxAttempts, onAttempt, headers, desktopModel }) {
  const protocol = route.protocol
  const requestedModel = body.model || route.model
  if (route.desktop && !desktopModel) throw Object.assign(new Error('尚未准备桌面模型映射，请在控制台准备参数后，到 Claude Desktop 应用内配置 Gateway'), { status: 409 })
  const model = route.desktop ? desktopModel : requestedModel
  if (!model || typeof model !== 'string') throw invalid('缺少 model')
  const chat = protocol === 'anthropic' ? messagesToChat(body) : protocol === 'gemini' ? geminiToChat(body, model) : { ...body }
  if (!Array.isArray(chat.messages)) throw invalid('messages 应为数组')
  chat.model = model
  if (route.countTokens) {
    // Heterogeneous upstreams have no common tokenizer. Never present this as billing usage.
    const estimate = Math.ceil([...json({ messages: chat.messages, tools: chat.tools })].reduce((n, char) => n + (char.codePointAt(0) > 0x2e80 ? 1.5 : .25), 0))
    res.writeHead(200, { 'content-type': 'application/json', 'x-relay-token-count': 'estimated' })
    res.end(json(protocol === 'gemini' ? { totalTokens: estimate } : { input_tokens: estimate }))
    return
  }
  const streaming = protocol === 'gemini' ? route.streaming : body.stream === true
  const responseId = id(protocol === 'anthropic' ? 'msg' : 'chatcmpl')
  const replyModel = route.desktop ? DESKTOP_MODEL : requestedModel
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  res.once('close', () => controller.abort())
  let text = '', usage = {}, finish = 'stop', started = false, textStarted = false
  const tools = new Map()
  const sse = (event, value) => res.write(`${event ? `event: ${event}\n` : ''}data: ${json(value)}\n\n`)
  const chatFrame = (delta, finish_reason = null, tokenUsage) => ({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: replyModel, choices: [{ index: 0, delta, finish_reason }], ...(tokenUsage ? { usage: tokenUsage } : {}) })
  function begin() {
    if (started || !streaming) return
    started = true
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    if (protocol === 'anthropic') sse('message_start', { type: 'message_start', message: { id: responseId, type: 'message', role: 'assistant', model: replyModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    if (protocol === 'chat') sse(null, chatFrame({ role: 'assistant', content: '' }))
  }
  function addText(delta) {
    text += delta
    if (!streaming) return
    begin()
    if (protocol === 'anthropic') {
      if (!textStarted) { sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); textStarted = true }
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } })
    } else if (protocol === 'chat') sse(null, chatFrame({ content: delta }))
    else sse(null, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: delta }] } }], modelVersion: replyModel })
  }
  const complete = createFailoverComplete({
    baseComplete: (request, onChunk) => lanes.complete({ model: request.model, body: chat, responses: false }, onChunk, controller.signal),
    modelRows: async () => lanes.modelRows(), cooldowns, affinity, maxAttempts, onAttempt,
  })
  try {
    const result = await complete({ model, headers }, chunk => {
      if (chunk.type === 'text-delta') addText(chunk.text ?? '')
      if (chunk.type === 'tool-call-delta') {
        const key = chunk.index ?? chunk.id ?? 0
        const tool = tools.get(key) ?? { id: chunk.id || id('call'), name: '', arguments: '' }
        if (chunk.id) tool.id = chunk.id
        if (chunk.name) tool.name = chunk.name
        tool.arguments += chunk.argumentsDelta ?? ''
        tools.set(key, tool)
      }
      if (chunk.usage) usage = { ...usage, ...chunk.usage }
      if (chunk.type === 'finish' && chunk.reason?.kind === 'max-tokens') finish = 'length'
    })
    if (!text && result?.text) addText(result.text)
    if (!tools.size && result?.toolCalls?.length) {
      result.toolCalls.forEach((tool, i) => tools.set(i, { id: tool.id || id('call'), name: tool.name || tool.function?.name, arguments: typeof tool.arguments === 'string' ? tool.arguments : json(tool.arguments ?? {}) }))
    }
    usage = { ...(result?.usage ?? {}), ...usage }
    const calls = [...tools.values()].map(tool => {
      if (!tool.name) throw new Error('上游工具调用缺少 name')
      let input
      try { input = JSON.parse(tool.arguments || '{}') } catch { throw new Error('上游返回了不完整的工具调用参数') }
      return { ...tool, input }
    })
    const tokenUsage = normalizeUsage(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    const input = tokenUsage.prompt_tokens
    const output = tokenUsage.completion_tokens
    const stopReason = finish === 'length' ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn'
    const chatStop = finish === 'length' ? 'length' : calls.length ? 'tool_calls' : 'stop'
    const anthropicContent = [...(text ? [{ type: 'text', text }] : []), ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input }))]
    const geminiParts = [...(text ? [{ text }] : []), ...calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.input } }))]
    const geminiResult = parts => ({ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: finish === 'length' ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output }, modelVersion: replyModel })
    if (streaming) {
      begin()
      if (protocol === 'anthropic') {
        if (textStarted) sse('content_block_stop', { type: 'content_block_stop', index: 0 })
        calls.forEach((call, i) => {
          const index = i + (textStarted ? 1 : 0)
          sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
          sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' } })
          sse('content_block_stop', { type: 'content_block_stop', index })
        })
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: input, output_tokens: output } })
        sse('message_stop', { type: 'message_stop' })
      } else if (protocol === 'chat') {
        if (calls.length) sse(null, chatFrame({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) }))
        sse(null, chatFrame({}, chatStop))
        if (body.stream_options?.include_usage) sse(null, { ...chatFrame({}), choices: [], usage: tokenUsage })
        res.write('data: [DONE]\n\n')
      } else sse(null, geminiResult(geminiParts.filter(part => !('text' in part))))
      res.end()
    } else {
      const response = protocol === 'anthropic'
        ? { id: responseId, type: 'message', role: 'assistant', model: replyModel, content: anthropicContent, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: input, output_tokens: output } }
        : protocol === 'gemini' ? geminiResult(geminiParts)
          : { id: responseId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: replyModel, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}) }, finish_reason: chatStop }], usage: tokenUsage }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(json(response))
    }
    return true
  } catch (error) {
    if (!res.headersSent) throw error
    sse(protocol === 'anthropic' ? 'error' : null, { type: 'error', error: { type: 'api_error', message: error.message } }); res.end()
  }
}
