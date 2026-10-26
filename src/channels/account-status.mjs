/** 与账号池目录门控保持一致：条目存在不等于凭据已保存。绝不向 UI 返回凭据。 */
export async function accountCredentialStatus(credentials, entry) {
  try {
    const resolved = await credentials.resolve(entry.credentialRef)
    if (!resolved) return { authenticated: false, credentialState: 'missing' }
    const parsed = JSON.parse(resolved.value)
    if (parsed === null || typeof parsed !== 'object') {
      return { authenticated: false, credentialState: 'invalid' }
    }
    return { authenticated: true, credentialState: 'saved' }
  } catch {
    return { authenticated: false, credentialState: 'invalid' }
  }
}
