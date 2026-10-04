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

enableLive(async () => {
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
})
