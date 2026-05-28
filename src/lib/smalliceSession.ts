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

export function getSmalliceMainSiteUrl(): string {
  const configuredUrl = import.meta.env.VITE_SMALLICE_MAIN_SITE_URL?.trim()
  if (configuredUrl) return configuredUrl

  return window.location.origin
}

export async function bootstrapSmalliceSession(): Promise<void> {
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')?.trim()
  if (!token) return

  const response = await fetch('/tools/draw-api/session/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })

  if (!response.ok) return

  url.searchParams.delete('token')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
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
