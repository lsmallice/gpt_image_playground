export interface SmalliceUser {
  id: string
  email: string
  name: string
  role: string
}

export interface SmalliceApiKey {
  id: string
  name: string
  groupName: string
  status: string
}

export interface SmalliceSession {
  authenticated: boolean
  user: SmalliceUser | null
  selectedKeyId: string | null
}

export type SmalliceBootstrapResult =
  | { status: 'no_token' }
  | { status: 'ok' }
  | { status: 'failed'; message: string }

const AUTH_QUERY_KEYS = ['token', 'auth_token', 'access_token']

export function getSmalliceMainSiteUrl(): string {
  const configuredUrl = import.meta.env.VITE_SMALLICE_MAIN_SITE_URL?.trim()
  if (configuredUrl) return configuredUrl

  return window.location.origin
}

export async function bootstrapSmalliceSession(): Promise<SmalliceBootstrapResult> {
  const url = new URL(window.location.href)
  const token = readAuthToken(url)
  if (!token) return { status: 'no_token' }

  const response = await fetch('/tools/draw-api/session/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string }; message?: string } | null
    return {
      status: 'failed',
      message: payload?.error?.message || payload?.message || `授权同步失败：HTTP ${response.status}`,
    }
  }

  stripAuthToken(url)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return { status: 'ok' }
}

function readAuthToken(url: URL): string {
  const queryToken = readTokenFromParams(url.searchParams)
  if (queryToken) return queryToken
  return readTokenFromHash(url.hash)
}

function readTokenFromParams(params: URLSearchParams): string {
  for (const key of AUTH_QUERY_KEYS) {
    const token = params.get(key)?.trim()
    if (token) return token
  }
  return ''
}

function readTokenFromHash(hash: string): string {
  const value = hash.replace(/^#/, '')
  if (!value) return ''

  const queryStart = value.indexOf('?')
  const paramsText = queryStart >= 0 ? value.slice(queryStart + 1) : value
  return readTokenFromParams(new URLSearchParams(paramsText))
}

function stripAuthToken(url: URL) {
  deleteAuthParams(url.searchParams)
  url.hash = stripAuthTokenFromHash(url.hash)
}

function stripAuthTokenFromHash(hash: string): string {
  const value = hash.replace(/^#/, '')
  if (!value) return hash

  const queryStart = value.indexOf('?')
  if (queryStart < 0) {
    const params = new URLSearchParams(value)
    return deleteAuthParams(params) ? params.toString() ? `#${params.toString()}` : '' : hash
  }

  const prefix = value.slice(0, queryStart)
  const params = new URLSearchParams(value.slice(queryStart + 1))
  if (!deleteAuthParams(params)) return hash
  const nextQuery = params.toString()
  return nextQuery ? `#${prefix}?${nextQuery}` : `#${prefix}`
}

function deleteAuthParams(params: URLSearchParams): boolean {
  let changed = false
  for (const key of AUTH_QUERY_KEYS) {
    if (params.has(key)) {
      params.delete(key)
      changed = true
    }
  }
  return changed
}

export async function fetchSmalliceSession(): Promise<SmalliceSession> {
  const response = await fetch('/tools/draw-api/session', {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    return { authenticated: false, user: null, selectedKeyId: null }
  }
  return response.json() as Promise<SmalliceSession>
}

export async function fetchSmalliceKeys(options: { refresh?: boolean } = {}): Promise<SmalliceApiKey[]> {
  const url = options.refresh ? `/tools/draw-api/keys?refresh=1&t=${Date.now()}` : '/tools/draw-api/keys'
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return []
  const payload = await response.json() as { items?: SmalliceApiKey[] }
  return Array.isArray(payload.items) ? payload.items : []
}

export async function selectSmalliceKey(keyId: string): Promise<void> {
  const response = await fetch('/tools/draw-api/keys/select', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ keyId }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || '无法选择 API Key')
  }
}
