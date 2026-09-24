import type { DayType, Line, Vehicle } from './types.ts'

export function dayType(now: Date): DayType {
  const day = now.getDay()
  if (day === 0) return 'sunday'
  if (day === 6) return 'saturday'
  return 'workday'
}

function metres(a: [number, number], b: [number, number]): number {
  const r = 6371000
  const p1 = (a[0] * Math.PI) / 180
  const p2 = (b[0] * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((b[1] - a[1]) * Math.PI) / 180
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}

/** Cumulative distance of every shape point, so we can place a bus by metres travelled. */
export function shapeDistances(line: Line): number[] {
  const out = [0]
  for (let i = 1; i < line.shape.length; i++) {
    out.push(out[i - 1] + metres(line.shape[i - 1], line.shape[i]))
  }
  return out
}

function pointAt(
  line: Line,
  cumulative: number[],
  distance: number,
): [number, number] {
  if (distance <= 0) return line.shape[0]
  const last = cumulative.length - 1
  if (distance >= cumulative[last]) return line.shape[last]

  let i = 1
  while (i < last && cumulative[i] < distance) i++

  const span = cumulative[i] - cumulative[i - 1]
  const u = span === 0 ? 0 : (distance - cumulative[i - 1]) / span
  const a = line.shape[i - 1]
  const b = line.shape[i]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
}

function parseToday(hhmm: string, now: Date): Date {
  const [hours, minutes] = hhmm.split(':').map(Number)
  const t = new Date(now)
  t.setHours(hours, minutes, 0, 0)
  return t
}

/**
 * Where every bus of this line would be right now if it left the first stop exactly
 * on its published time and kept a constant average speed along the route.
 */
export function vehiclesAt(
  line: Line,
  cumulative: number[],
  now: Date,
): Vehicle[] {
  const stops = line.stops
  const first = stops[0].along
  const last = stops[stops.length - 1].along
  const tripMs = line.tripSeconds * 1000
  const out: Vehicle[] = []

  for (const hhmm of line.departures[dayType(now)]) {
    const elapsed = now.getTime() - parseToday(hhmm, now).getTime()
    if (elapsed < 0 || elapsed >= tripMs) continue

    const progress = elapsed / tripMs
    const along = first + (last - first) * progress
    const [lat, lon] = pointAt(line, cumulative, along)

    let next = stops.findIndex((s) => s.along > along)
    if (next === -1) next = stops.length - 1

    out.push({
      id: `${line.id}-${hhmm}`,
      lineId: line.id,
      lat,
      lon,
      lastStop: stops[Math.max(0, next - 1)].name,
      nextStop: stops[next].name,
      departedAt: hhmm,
      progress,
    })
  }

  return out
}
