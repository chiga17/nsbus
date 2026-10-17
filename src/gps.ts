import { enableLive, type LiveBus } from './main.ts'

type Snapshot = {
  ready?: boolean
  updatedAt?: string | null
  buses?: {
    garageNo?: string
    line?: string
    lat?: number
    lng?: number
    secondsLeft?: number | null
    stopName?: string
  }[]
}

const url = import.meta.env.VITE_BUSES_URL
const token = import.meta.env.VITE_BUSES_TOKEN

enableLive(
  async () => {
    if (!url || !token) throw new Error('backend is not configured')
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(String(response.status))
    const body = (await response.json()) as Snapshot
    const buses: LiveBus[] = []
    for (const bus of body.buses ?? []) {
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number' || !bus.garageNo) continue
      buses.push({
        id: `gps-${bus.garageNo}`,
        line: bus.line || '?',
        lat: bus.lat,
        lng: bus.lng,
        secondsLeft: typeof bus.secondsLeft === 'number' ? bus.secondsLeft : null,
        stopName: bus.stopName ?? '',
      })
    }
    return { ready: Boolean(body.ready), updatedAt: body.updatedAt ?? null, buses }
  },
  { startOn: true, exitTo: '/' },
)

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    if (ch === '>') return '&gt;'
    if (ch === '"') return '&quot;'
    return '&#39;'
  })
}

/** Cloudflare Access fills this in only after Google sign-in on the guarded page. */
async function showAccount() {
  const slot = document.querySelector('#account-slot')
  if (!slot) return
  let email = ''
  try {
    const response = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' })
    if (!response.ok) return
    const body = (await response.json()) as { email?: unknown }
    if (typeof body.email === 'string') email = body.email.trim()
  } catch {
    return
  }
  if (!email) return
  const safe = esc(email)
  slot.innerHTML = `<span class="account" title="${safe}" aria-label="Signed in as ${safe}">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="10.2" fill="#e7f2e4" stroke="#3d7a4a" stroke-width="1.4"></circle>
      <circle cx="12" cy="9.2" r="2.7" fill="#3d7a4a"></circle>
      <path d="M7 17.4c1-2 2.7-3 5-3s4 1 5 3" fill="none" stroke="#3d7a4a" stroke-width="1.6" stroke-linecap="round"></path>
    </svg>
    <span class="account-email">${safe}</span>
  </span>`
}

void showAccount()
