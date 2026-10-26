/** A diagnostic uses exactly one account and the registered provider adapter. No fallback. */
export async function probeAccount({ pool, adapters, accountId, modelId, signal, timeoutMs = 90000 }) {
  const started = Date.now()
  const entry = pool.findAccount(accountId)
  if (!entry) throw Object.assign(new Error('账号不存在'), { statusCode: 404 })
  const original = adapters.get(entry.provider)
  if (!original) throw new Error('渠道未启用')
  const credential = await pool.resolveCredentialForAccount(accountId)
  if (!credential) throw new Error('账号凭据缺失，请重新授权')
  const model = modelId?.startsWith(`${entry.provider}/`) ? modelId.slice(entry.provider.length + 1) : modelId
  if (!model || model.includes('/../')) throw new Error('缺少测试模型')
  const localSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  const pinned = new original.constructor({
    ...original.options,
    accountPool: undefined,
    nextAccount: async () => undefined,
    currentAccountId: () => accountId,
    persistProject: undefined,
    resolveCredential: async () => credential,
    refresh: async () => credential,
    // A diagnostic never solves a challenge or starts a captcha browser.
    mintCaptcha: async () => { throw new Error('此账号需要在官方应用中完成人工验证') },
    mintCaptchaParam: async () => { throw new Error('此账号需要在官方应用中完成人工验证') },
    mintCaptchaAfterRejection: async () => { throw new Error('此账号需要在官方应用中完成人工验证') },
  })
  if (original.remoteModels) pinned.remoteModels = original.remoteModels
  if (original.remoteMeta) pinned.remoteMeta = original.remoteMeta
  let text = '', usage, finish
  try {
    for await (const chunk of pinned.stream({
      provider: entry.provider, model, signal: localSignal,
      system: 'You are a helpful assistant.',
      messages: [{ id: 'baiuse-account-probe', role: 'user', content: [{ type: 'text', text: 'Reply with only BAIUSE_OK.' }], source: { kind: 'user' } }],
      maxTokens: 1024, // Diagnostic only; does not modify client or normal inference budgets.
    })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      if (chunk.type === 'error') throw new Error(chunk.error?.message ?? chunk.message ?? '上游返回错误')
      if (chunk.type === 'finish') { usage = chunk.usage; finish = chunk.reason?.kind }
    }
    if (!text.trim()) throw new Error(finish === 'max-tokens' ? '测试输出预算耗尽但没有正文，请换轻量模型再试' : '上游没有返回正文')
    return { ok: true, accountId, provider: entry.provider, modelId: `${entry.provider}/${model}`, text: text.trim().slice(0,160), elapsedMs: Date.now()-started, ...(usage ? {usage} : {}) }
  } catch (error) {
    let message = String(error.message ?? error)
    for (const [key,value] of Object.entries(credential)) {
      if (/token|secret|password|cookie|key/i.test(key) && typeof value === 'string' && value.length > 8) message = message.replaceAll(value,'[已隐藏]')
    }
    return { ok: false, accountId, provider: entry.provider, modelId: `${entry.provider}/${model}`, message: message.slice(0,500), elapsedMs: Date.now()-started, code: localSignal.aborted ? 'TIMEOUT' : error.code, statusCode: error.status ?? error.statusCode ?? error.cause?.status }
  }
}
