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

/** How far a GPS fix can sit from a route and still belong to it. */
const SNAP_METRES = 80
/** Another pass of a loop is further along the shape than this. */
const VISIT_GAP = 200
/** Inside this, two directions are one corridor until the announced ETA separates them. */
const TIE_METRES = 25
const TIE_SECONDS = 120

export type GpsFix = {
  id: string
  line: string
  lat: number
  lng: number
  secondsLeft: number | null
  stopName: string
}

/** A bus already on a direction, whether the timetable or a GPS fix put it there. */
export type RoadBus = {
  id: string
  lineId: string
  along: number
  lat: number
  lon: number
  speed: number
  departedAt: string | null
}

/** Leading route number, so 7A, 7B and a raw "7" from NSmart share a family. */
export function lineNumber(id: string): string {
  return /^(\d+)/.exec(id.trim())?.[1] ?? ''
}

export function speedOf(line: Line): number {
  const first = line.stops[0]?.along ?? 0
  const last = line.stops.at(-1)?.along ?? first
  const span = last - first
  return span > 0 && line.tripSeconds > 0 ? span / line.tripSeconds : 0
}

type RouteHit = { along: number; distance: number }

/** Each distinct pass of the shape that comes within SNAP_METRES of the fix. */
function routeHits(
  line: Line,
  cumulative: number[],
  lat: number,
  lon: number,
): RouteHit[] {
  const raw: RouteHit[] = []
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
    if (distance > SNAP_METRES) continue
    raw.push({
      along: cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * u,
      distance,
    })
  }
  raw.sort((p, q) => p.along - q.along)
  const clusters: (RouteHit & { end: number })[] = []
  for (const hit of raw) {
    const last = clusters.at(-1)
    if (last && hit.along - last.end < VISIT_GAP) {
      last.end = hit.along
      if (hit.distance < last.distance) {
        last.along = hit.along
        last.distance = hit.distance
      }
      continue
    }
    clusters.push({ ...hit, end: hit.along })
  }
  clusters.sort((p, q) => p.distance - q.distance)
  return clusters
}

/**
 * How far the announced ETA is from this pass. Null when the polled stop is not
 * still ahead, so a loop can prefer the lap that still has that stop to come.
 */
function announcedError(line: Line, along: number, fix: GpsFix): number | null {
  if (!fix.stopName || fix.secondsLeft == null) return null
  const speed = speedOf(line)
  if (speed <= 0) return null
  const wanted = fix.stopName.trim().toLowerCase()
  const ahead = line.stops
    .filter((stop) => stop.name.trim().toLowerCase() === wanted && stop.along >= along - 40)
    .sort((a, b) => a.along - b.along)[0]
  if (!ahead) return null
  return Math.abs((ahead.along - along) / speed - fix.secondsLeft)
}

type Placed = { line: Line; hit: RouteHit; error: number | null }

function chooseDirection(ranked: Placed[], reported: string): Placed | null {
  if (!ranked.length) return null
  if (ranked.length === 1) return ranked[0]

  // The polled stop is still ahead on one direction, and the ETA matches.
  const timed = ranked.filter((item) => item.error != null).sort((a, b) => a.error! - b.error!)
  if (timed.length && timed[0].error! <= TIE_SECONDS) {
    const second = timed[1]
    if (!second || second.error! - timed[0].error! >= TIE_SECONDS) return timed[0]
  }

  ranked.sort((a, b) => a.hit.distance - b.hit.distance)
  const [best, second] = ranked
  if (second.hit.distance - best.hit.distance >= TIE_METRES) return best
  // Same corridor. Trust a direction the feed already resolved, otherwise wait.
  return ranked.find((item) => item.line.id === reported) ?? null
}

/**
 * Snap each GPS fix onto one direction. Fixes that sit between two directions,
 * or on none, come back unresolved and are drawn but not used for predictions.
 */
export function placeLive(
  rows: { line: Line; cumulative: number[] }[],
  fixes: GpsFix[],
): { buses: RoadBus[]; unresolved: GpsFix[] } {
  const buses: RoadBus[] = []
  const unresolved: GpsFix[] = []
  for (const fix of fixes) {
    const number = lineNumber(fix.line)
    const pool = number
      ? rows.filter((row) => lineNumber(row.line.id) === number)
      : rows.filter((row) => row.line.id === fix.line)
    const ranked: Placed[] = []
    for (const row of pool) {
      const hits = routeHits(row.line, row.cumulative, fix.lat, fix.lng)
      if (!hits.length) continue
      let hit = hits[0]
      let error = announcedError(row.line, hit.along, fix)
      for (const other of hits.slice(1)) {
        const next = announcedError(row.line, other.along, fix)
        if (next == null) continue
        if (error == null || next < error) {
          hit = other
          error = next
        }
      }
      ranked.push({ line: row.line, hit, error })
    }
    const chosen = chooseDirection(ranked, fix.line)
    if (!chosen) {
      unresolved.push(fix)
      continue
    }
    buses.push({
      id: fix.id,
      lineId: chosen.line.id,
      along: chosen.hit.along,
      lat: fix.lat,
      lon: fix.lng,
      speed: speedOf(chosen.line),
      departedAt: null,
    })
  }
  return { buses, unresolved }
}

/** Timetable departures that should still be on the road right now. */
export function timetableBuses(
  rows: { line: Line; cumulative: number[] }[],
  now: Date,
): RoadBus[] {
  const out: RoadBus[] = []
  for (const { line, cumulative } of rows) {
    const speed = speedOf(line)
    for (const vehicle of vehiclesAt(line, cumulative, now)) {
      out.push({
        id: vehicle.id,
        lineId: vehicle.lineId,
        along: vehicle.along,
        lat: vehicle.lat,
        lon: vehicle.lon,
        speed,
        departedAt: vehicle.departedAt,
      })
    }
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

/**
 * Same list as arrivalsAtStop, but the buses already on the road come from
 * `buses` (timetable or GPS). Departures that have not left yet still come
 * from the timetable, in both modes.
 */
export function arrivalsFor(
  lines: Line[],
  buses: RoadBus[],
  name: string,
  lat: number,
  lon: number,
  now: Date,
  limit = 12,
  bearing: number | null = null,
): Arrival[] {
  const out: Arrival[] = []

  for (const line of lines) {
    const served = line.stops.filter((stop) => samePole(stop, line, name, lat, lon, bearing))
    if (!served.length) continue
    const speed = speedOf(line)
    if (speed <= 0) continue
    const first = line.stops[0].along

    for (const bus of buses) {
      if (bus.lineId !== line.id) continue
      const target = served
        .filter((stop) => stop.along > bus.along + 15)
        .sort((a, b) => a.along - b.along)[0]
      if (!target) continue
      const etaSec = (target.along - bus.along) / (bus.speed || speed)
      const arrivesAt = new Date(now.getTime() + etaSec * 1000)
      if (arrivesAt.getTime() <= now.getTime()) continue
      out.push({
        vehicleId: bus.id,
        lineId: line.id,
        lineName: line.route,
        departedAt: bus.departedAt ?? '',
        arrivesAt,
        minutes: Math.max(0, Math.round((arrivesAt.getTime() - now.getTime()) / 60000)),
        onMap: true,
        kind: target.along - first < 40 ? 'departs' : 'arrives',
      })
    }

    for (const hhmm of timesFor(line, now)) {
      const t0 = parseToday(hhmm, now)
      const elapsedSec = (now.getTime() - t0.getTime()) / 1000
      if (elapsedSec >= 0) continue
      const target = served
        .filter((stop) => stop.along > first + 14)
        .sort((a, b) => a.along - b.along)[0]
      if (!target) continue
      const arrivesAt = new Date(t0.getTime() + ((target.along - first) / speed) * 1000)
      if (arrivesAt.getTime() <= now.getTime()) continue
      out.push({
        vehicleId: null,
        lineId: line.id,
        lineName: line.route,
        departedAt: hhmm,
        arrivesAt,
        minutes: Math.max(0, Math.round((arrivesAt.getTime() - now.getTime()) / 60000)),
        onMap: false,
        kind: target.along - first < 40 ? 'departs' : 'arrives',
      })
    }
  }

  out.sort((a, b) => a.arrivesAt.getTime() - b.arrivesAt.getTime())
  return out.slice(0, limit)
}
