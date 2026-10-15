import type { Arrival, DayType, Line, Stop, Vehicle } from './types.ts'

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

/** Metres along the shape of the point on the route closest to this GPS fix. */
export function nearestAlong(
  line: Line,
  cumulative: number[],
  lat: number,
  lon: number,
): number {
  let bestAlong = 0
  let bestDist = Infinity
  for (let i = 1; i < line.shape.length; i++) {
    const a = line.shape[i - 1]
    const b = line.shape[i]
    const abLat = b[0] - a[0]
    const abLon = b[1] - a[1]
    const len2 = abLat * abLat + abLon * abLon
    let u = 0
    if (len2 > 0) {
      u = ((lat - a[0]) * abLat + (lon - a[1]) * abLon) / len2
      if (u < 0) u = 0
      else if (u > 1) u = 1
    }
    const distance = metres([lat, lon], [a[0] + abLat * u, a[1] + abLon * u])
    if (distance < bestDist) {
      bestDist = distance
      bestAlong = cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * u
    }
  }
  return bestAlong
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

  for (const hhmm of line.departures[dayType(now)] ?? line.departures.workday) {
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
      along,
    })
  }

  return out
}

export type Call = {
  name: string
  at: Date
  /** already reached — draw it quieter than the stops still ahead */
  passed: boolean
  /** the first stop the bus has not reached yet */
  next: boolean
}

/**
 * Every stop of this departure, in route order, with the time the bus is there
 * if it left on schedule and holds a steady speed.
 */
export function itinerary(line: Line, departedAt: string, along: number, now: Date): Call[] {
  const stops = line.stops
  const first = stops[0]?.along ?? 0
  const last = stops[stops.length - 1]?.along ?? first
  const span = last - first
  const mps = span > 0 && line.tripSeconds > 0 ? span / line.tripSeconds : 0
  const t0 = parseToday(departedAt, now).getTime()
  let markedNext = false

  return stops.map((stop) => {
    const passed = stop.along <= along
    const next = !passed && !markedNext
    if (next) markedNext = true
    const at = new Date(mps > 0 ? t0 + ((stop.along - first) / mps) * 1000 : t0)
    return { name: stop.name, at, passed, next }
  })
}

/**
 * Same stop list as a followed timetable bus, timed from where this bus is now
 * and the line's usual trip length.
 */
export function itineraryFromAlong(line: Line, along: number, now: Date): Call[] {
  const stops = line.stops
  const first = stops[0]?.along ?? 0
  const last = stops[stops.length - 1]?.along ?? first
  const span = last - first
  const mps = span > 0 && line.tripSeconds > 0 ? span / line.tripSeconds : 0
  let markedNext = false

  return stops.map((stop) => {
    const passed = stop.along <= along
    const next = !passed && !markedNext
    if (next) markedNext = true
    const seconds = mps > 0 ? (stop.along - along) / mps : 0
    return { name: stop.name, at: new Date(now.getTime() + seconds * 1000), passed, next }
  })
}

/** Same curb recorded twice can sit this far apart (Uspenska - Šafarikova is 47 m). */
const SAME_NAME_METRES = 80
/** A pole drawn from coordinates is only about a metre wide. */
const SAME_MARKER_METRES = 4
/**
 * Other side of the street. Same-name pairs that are really one stop differ by
 * under 100°; opposite curbs (Cara Dušana - Medicinska Škola, 73 m and 179°)
 * differ by at least ~140°.
 */
const OPPOSITE_TURN = 120

function stopName(name: string): string {
  return name.trim().toLowerCase()
}

function bearingDegrees(a: [number, number], b: [number, number]): number {
  const p1 = (a[0] * Math.PI) / 180
  const p2 = (b[0] * Math.PI) / 180
  const dl = ((b[1] - a[1]) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function turnDegrees(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Direction the bus is traveling where this route passes closest to the point. */
function travelBearing(line: Line, lat: number, lon: number): number | null {
  let best = Infinity
  let bearing: number | null = null
  const shape = line.shape
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1]
    const b = shape[i]
    const abLat = b[0] - a[0]
    const abLon = b[1] - a[1]
    const len2 = abLat * abLat + abLon * abLon
    if (len2 === 0) continue
    let u = ((lat - a[0]) * abLat + (lon - a[1]) * abLon) / len2
    if (u < 0) u = 0
    else if (u > 1) u = 1
    const distance = metres([lat, lon], [a[0] + abLat * u, a[1] + abLon * u])
    if (distance >= best) continue
    best = distance
    bearing = bearingDegrees(a, b)
  }
  return best < 150 ? bearing : null
}

/**
 * Travel direction at the clicked pole. Averaged from the lines whose stop
 * actually sits on that marker, so a stop across the street does not cancel it.
 */
export function poleBearing(lines: Line[], name: string, lat: number, lon: number): number | null {
  const wanted = stopName(name)
  let x = 0
  let y = 0
  let n = 0
  for (const line of lines) {
    for (const stop of line.stops) {
      if (stopName(stop.name) !== wanted) continue
      if (metres([stop.lat, stop.lon], [lat, lon]) > SAME_MARKER_METRES) continue
      const bearing = travelBearing(line, stop.lat, stop.lon)
      if (bearing == null) continue
      const rad = (bearing * Math.PI) / 180
      x += Math.cos(rad)
      y += Math.sin(rad)
      n++
    }
  }
  if (n === 0 || Math.hypot(x, y) < n * 0.25) return null
  return (Math.atan2(y, x) * 180) / Math.PI
}

/**
 * Same name within 80 m, and not the opposite curb. Different names stay apart
 * even when the poles are close (Žarka Zrenjanina: "Opština" and "Izvršno Veće"
 * are 58 m). The same name on both sides of Cara Dušana is 73 m apart, so the
 * distance check alone lists buses that never call at the pole you clicked.
 */
function samePole(
  stop: Stop,
  line: Line,
  name: string,
  lat: number,
  lon: number,
  bearing: number | null,
): boolean {
  if (stopName(stop.name) !== stopName(name)) return false
  const distance = metres([stop.lat, stop.lon], [lat, lon])
  if (distance >= SAME_NAME_METRES) return false
  if (distance < SAME_MARKER_METRES || bearing == null) return true
  const heading = travelBearing(line, stop.lat, stop.lon)
  if (heading == null) return true
  return turnDegrees(heading, bearing) < OPPOSITE_TURN
}

function timesFor(line: Line, now: Date): string[] {
  return line.departures[dayType(now)] ?? line.departures.workday
}

/** True when this line's timetable includes the selected pole. */
export function servesStop(
  line: Line,
  name: string,
  lat: number,
  lon: number,
  bearing: number | null = null,
): boolean {
  return line.stops.some((stop) => samePole(stop, line, name, lat, lon, bearing))
}

/**
 * Buses (already rolling, or not yet left) that the timetable says will still
 * reach this stop. Closest times first; capped so the popup stays readable.
 */
export function arrivalsAtStop(
  lines: Line[],
  name: string,
  lat: number,
  lon: number,
  now: Date,
  limit = 12,
  bearing: number | null = null,
): Arrival[] {
  const out: Arrival[] = []

  for (const line of lines) {
    const served = line.stops.filter((s) => samePole(s, line, name, lat, lon, bearing))
    if (!served.length) continue

    const first = line.stops[0].along
    const last = line.stops[line.stops.length - 1].along
    const span = last - first
    if (span <= 0 || line.tripSeconds <= 0) continue
    const mps = span / line.tripSeconds

    for (const hhmm of timesFor(line, now)) {
      const t0 = parseToday(hhmm, now)
      const elapsedSec = (now.getTime() - t0.getTime()) / 1000
      const alongNow =
        elapsedSec < 0 ? first - 1 : first + span * (elapsedSec / line.tripSeconds)

      // On a loop the same pole can be both start and finish — pick the one still ahead.
      const target = served
        .filter((s) => s.along > alongNow + 15)
        .sort((a, b) => a.along - b.along)[0]
      if (!target) continue

      const etaSec = (target.along - Math.max(alongNow, first)) / mps
      const arrivesAt = new Date(
        (elapsedSec < 0 ? t0.getTime() : now.getTime()) +
          (elapsedSec < 0 ? ((target.along - first) / mps) * 1000 : etaSec * 1000),
      )
      if (arrivesAt.getTime() <= now.getTime()) continue

      const fromOrigin = target.along - first < 40
      out.push({
        vehicleId: elapsedSec >= 0 && elapsedSec < line.tripSeconds ? `${line.id}-${hhmm}` : null,
        lineId: line.id,
        lineName: line.route,
        departedAt: hhmm,
        arrivesAt,
        minutes: Math.max(0, Math.round((arrivesAt.getTime() - now.getTime()) / 60000)),
        onMap: elapsedSec >= 0 && elapsedSec < line.tripSeconds,
        kind: fromOrigin ? 'departs' : 'arrives',
      })
    }
  }

  out.sort((a, b) => a.arrivesAt.getTime() - b.arrivesAt.getTime())
  return out.slice(0, limit)
}
