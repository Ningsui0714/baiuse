/** Logical model identity is independent of the account/provider used for a request. */
const knownFamily = /^(?:deepseek|glm[-_\s]?\d|kimi[-_\s]?|gpt[-_\s]?|claude[-_\s]?|gemini[-_\s]?|qwen[-_\s]?|mimo[-_\s]?|openpangu[-_\s]?|nemotron[-_\s]?)/i

export function modelIdentity(row) {
  const id = String(row?.id ?? '').trim()
  let name = id
  // Kilo IDs contain upstream namespaces (nvidia/..., openrouter/free), not our channel prefix.
  if (row?.lane !== 'kilo' && row?.owned_by !== 'kilo' && name.includes('/')) name = name.slice(name.indexOf('/') + 1)
  const leaf = name.split('/').at(-1).replace(/:free$/i, '')
  if (knownFamily.test(leaf)) name = leaf
  // Only the explicitly equivalent DeepSeek version + tier + dated revision is folded.
  // V4 vs V4.1, Flash vs Pro, R1, Chat and differently tuned models remain separate.
  const ds = /^deepseek[-_\s]*v?(\d+(?:\.\d+)*)[-_\s]*(flash|pro)(?:[-_\s]*(?:\d{8}|\d{4}))?$/i.exec(name)
  if (ds) return `deepseek-v${ds[1]}-${ds[2].toLowerCase()}`
  return name.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
}

export function requestedIdentity(model, rows) {
  const exact=rows.find(row=>row.id===model)
  if(exact)return modelIdentity(exact)
  // Unknown upstream namespaces can be part of a public logical ID; don't strip them
  // as if they were our account-channel prefix after case normalization.
  const logical=String(model??'').trim().toLowerCase().replace(/[\s_]+/g,'-').replace(/-+/g,'-')
  if(rows.some(row=>modelIdentity(row)===logical))return logical
  return modelIdentity({id:model})
}

export function modelDisplayName(id, fallback) {
  const ds = /^deepseek-v(\d+(?:\.\d+)*)-(flash|pro)$/.exec(id)
  if (ds) return `DeepSeek V${ds[1]} ${ds[2] === 'flash' ? 'Flash' : 'Pro'}`
  if (/^glm-/.test(id)) return id.replace(/^glm-/, 'GLM ').replace(/-/g, ' ')
  if (/^kimi-/.test(id)) return id.replace(/^kimi-/, 'Kimi ').replace(/\bk(\d)/g, 'K$1')
  return fallback || id
}

/** Public directory: one entry per logical model, retaining real routes as metadata. */
export function buildModelPools(rows = []) {
  const pools = new Map()
  for (const row of rows) {
    const id = modelIdentity(row)
    if (!id) continue
    let pool = pools.get(id)
    if (!pool) {
      pool = { id, object: 'model', created: 0, owned_by: 'relay', lane: 'pool', name: modelDisplayName(id, row.name), routes: [] }
      pools.set(id, pool)
    }
    if (pool.routes.some(route => route.id === row.id)) continue
    pool.routes.push({ id: row.id, provider: row.channel ?? row.owned_by ?? row.id.split('/')[0], lane: row.lane ?? 'channel', context_window: row.context_window, max_tokens: row.max_tokens })
  }
  return [...pools.values()].map(pool => {
    const contexts = pool.routes.map(route => route.context_window)
    return { ...pool, routeCount: pool.routes.length, providerCount: new Set(pool.routes.map(route=>`${route.lane}:${route.provider}`)).size,
      ...(contexts.every(value => typeof value === 'number' && value === contexts[0]) ? { context_window: contexts[0] } : {}),
    }
  })
}
