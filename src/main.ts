import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import rawLines from './data/lines.json'
import {
  arrivalsAtStop,
  dayType,
  itinerary,
  itineraryFromAlong,
  nearestAlong,
  servesStop,
  shapeDistances,
  vehiclesAt,
  type Call,
} from './simulate.ts'
import './style.css'
import type { DayType, Line, Vehicle } from './types.ts'

const PALETTE = [
  '#c45c26',
  '#2d6a8e',
  '#3d7a4a',
  '#8b3a62',
  '#6b5ea8',
  '#b45309',
  '#0f766e',
  '#b91c1c',
  '#1d4ed8',
  '#4d7c0f',
]

/** Drop the trailing direction letter so 1A/1B, 6AA/6AB, and 10ALA/10ALB share a color. */
function lineFamily(id: string): string {
  return /[AB]$/.test(id) ? id.slice(0, -1) : id
}

function colorFor(id: string): string {
  const key = lineFamily(id)
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

const lines = (rawLines as unknown as Line[]).map((line) => ({
  line,
  cumulative: shapeDistances(line),
  color: colorFor(line.id),
}))

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="bar">
    <div>
      <strong>nsbus</strong>
      <span class="muted">JGSP Novi Sad · gradski</span>
    </div>
    <div id="status" class="muted"></div>
    <span id="source-note" class="muted warn">simulated from timetable, not GPS</span>
    <span id="admin-slot"></span>
  </header>
  <div class="content">
    <div id="map"></div>
    <aside id="panel" class="panel"></aside>
  </div>
`

/** Starting view. Shift [lat, lon] to move the center; raise zoom to move closer. */
const INITIAL_VIEW = { center: [45.25, 19.83] as [number, number], zoom: 14 }

const map = L.map('map', INITIAL_VIEW)

// Below the overlay pane, so stop circles stay above the route no matter which is added last.
const routePane = map.createPane('routes')
routePane.style.zIndex = '350'

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap · JGSP Novi Sad',
}).addTo(map)

// Every stop of every line, drawn once even when several lines share it.
const stopLayer = L.layerGroup().addTo(map)

function stopKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`
}

type Pole = { lat: number; lon: number; marker: L.CircleMarker }
const poles = new Map<string, Pole>()

/** circleMarker radius is in pixels, so grow it as the user zooms in. */
function stopRadius(zoom: number): number {
  return Math.min(9, Math.max(3, Math.round(zoom) - 9))
}

const stopStyle = {
  color: '#41505f',
  weight: 2,
  fillColor: '#fff',
  fillOpacity: 1,
}

const selectedStopStyle = {
  color: '#c45c26',
  weight: 3,
  fillColor: '#f4c28a',
  fillOpacity: 1,
}

for (const { line } of lines) {
  for (const stop of line.stops) {
    const key = stopKey(stop.lat, stop.lon)
    if (poles.has(key)) continue
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: stopRadius(map.getZoom()),
      ...stopStyle,
    })
      .bindTooltip(stop.name)
      .addTo(stopLayer)
    marker.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      toggleStop(stop.name, stop.lat, stop.lon, marker)
    })
    poles.set(key, { lat: stop.lat, lon: stop.lon, marker })
  }
}

map.on('zoomend', () => {
  paintPoles()
})

const routes = new Map<string, L.Polyline>()
const shown = new Set<string>()

function hideRoutes() {
  for (const id of shown) routes.get(id)?.remove()
  shown.clear()
}

function routeFor(id: string): L.Polyline {
  const existing = routes.get(id)
  if (existing) return existing
  const row = lines.find((r) => r.line.id === id)!
  const route = L.polyline(row.line.shape, {
    color: row.color,
    weight: 5,
    opacity: 0.85,
    pane: 'routes',
  })
  routes.set(id, route)
  return route
}

/** Draw exactly these lines, the same polylines a selected bus would show. */
function showRoutes(ids: Iterable<string>) {
  const keep = new Set(ids)
  for (const id of [...shown]) {
    if (keep.has(id)) continue
    routes.get(id)?.remove()
    shown.delete(id)
  }
  for (const id of keep) {
    if (shown.has(id)) continue
    routeFor(id).addTo(map)
    shown.add(id)
  }
}

function showOnlyRoute(id: string) {
  showRoutes([id])
}

const icons = new Map(
  lines.map(({ line, color }) => [
    line.id,
    L.divIcon({
      className: 'bus-marker',
      html: `<span style="background:${color}">${line.id}</span>`,
      iconSize: [40, 28],
      iconAnchor: [20, 14],
    }),
  ]),
)

const markers = new Map<string, L.Marker>()
const liveIcons = new Map<string, L.DivIcon>()
const statusEl = document.querySelector('#status')!
const sourceNote = document.querySelector<HTMLElement>('#source-note')!

export type LiveBus = {
  id: string
  line: string
  lat: number
  lng: number
  secondsLeft: number | null
  stopName: string
}

let usingLive = false
let liveBuses: LiveBus[] = []
let liveStatus = 'live'

function liveIcon(line: string): L.DivIcon {
  const cached = liveIcons.get(line)
  if (cached) return cached
  const width = Math.max(40, line.length * 12)
  const icon = L.divIcon({
    className: 'bus-marker',
    html: `<span style="background:${colorFor(line)};width:${width}px">${esc(line)}</span>`,
    iconSize: [width, 28],
    iconAnchor: [width / 2, 14],
  })
  liveIcons.set(line, icon)
  return icon
}

/** Admin page only. The public bundle never receives the backend address or token. */
export function enableLive(
  poll: () => Promise<{ ready: boolean; updatedAt: string | null; buses: LiveBus[] }>,
): void {
  const slot = document.querySelector('#admin-slot')
  if (!slot) return
  slot.innerHTML = `<button type="button" id="live-switch" class="live-switch">Live GPS</button>`
  const button = document.querySelector<HTMLButtonElement>('#live-switch')!
  let timer = 0

  async function refresh() {
    try {
      const snap = await poll()
      liveBuses = snap.buses
      const when = snap.updatedAt ? new Date(snap.updatedAt) : null
      const clock =
        when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString('sr-RS') : ''
      liveStatus = clock ? `live ${clock}` : 'live'
      if (!snap.ready) liveStatus += ' · stale'
    } catch {
      liveStatus = 'live · update failed'
    }
    tick()
  }

  button.addEventListener('click', () => {
    usingLive = !usingLive
    button.classList.toggle('on', usingLive)
    button.textContent = usingLive ? 'Live GPS on' : 'Live GPS'
    clearBus()
    if (usingLive) {
      void refresh()
      timer = window.setInterval(() => void refresh(), 15_000)
    } else {
      window.clearInterval(timer)
      liveBuses = []
      tick()
    }
  })
}

type SelectedStop = {
  name: string
  lat: number
  lon: number
  marker: L.CircleMarker
}

let selected: SelectedStop | null = null
let selectedBusId: string | null = null
/** Line of the selected bus, so its stops can be marked without hiding the rest. */
let selectedBusLineId: string | null = null
let selectedLineId: string | null = null
/** Line whose panel was last painted, so a newly chosen line starts scrolled to the top. */
let linePanelKey = ''
/** Live buses and stops, or the full day's departures. Kept when flipping direction. */
let lineSheet: 'live' | 'timetable' = 'live'
/** Timetable day. Null follows the clock, and a picked day stays when flipping direction. */
let timetableDay: DayType | null = null
let dueIds = new Set<string>()
/** Poles on lines through the selected stop, ringed in that line's color. */
let stopRingColors = new Map<string, string>()

function clock(date: Date): string {
  return date.toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' })
}

/** Pin this pole in Google Maps. Coordinates, so the name cannot match a different place. */
function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
}

const panelEl = document.querySelector<HTMLElement>('#panel')!
panelEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const bus = target.closest<HTMLButtonElement>('button[data-bus]')
  if (bus?.dataset.bus && bus.dataset.line) {
    selectBus(bus.dataset.bus, bus.dataset.line)
    return
  }
  const sheetBtn = target.closest<HTMLButtonElement>('button[data-sheet]')
  const sheet = sheetBtn?.dataset.sheet
  if (sheet === 'live' || sheet === 'timetable') {
    if (lineSheet !== sheet) {
      lineSheet = sheet
      tick()
    }
    return
  }
  const dayBtn = target.closest<HTMLButtonElement>('button[data-day]')
  const day = dayBtn?.dataset.day
  if (day === 'workday' || day === 'saturday' || day === 'sunday') {
    if (timetableDay !== day) {
      timetableDay = day
      tick()
    }
    return
  }
  const lineBtn = target.closest<HTMLButtonElement>('button[data-line]')
  if (lineBtn?.dataset.line) {
    toggleLine(lineBtn.dataset.line)
    return
  }
  const button = target.closest<HTMLButtonElement>('button[data-stop]')
  if (!button) return
  const pole = poles.get(button.dataset.stop ?? '')
  const name = button.querySelector('.stop')?.textContent
  if (!pole || !name) return
  toggleStop(name, pole.lat, pole.lon, pole.marker)
})
let panelHtml = ''
/** Which bus and upcoming stop the list is scrolled to. */
let followKey = ''

function esc(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'))
}

/**
 * Replace the panel only when its text changes.
 * `scroll` is `next` to bring the upcoming stop into view, `keep` to leave the
 * user where they scrolled, or `top` when the panel is a different kind of view.
 */
function paintPanel(html: string, scroll: 'keep' | 'next' | 'top' = 'keep') {
  if (html === panelHtml) return
  const keep = panelEl.scrollTop
  panelHtml = html
  panelEl.innerHTML = html
  panelEl.querySelector('#clear-panel')?.addEventListener('click', () => {
    clearStop()
    clearBus()
    clearLine()
    tick()
  })
  if (scroll === 'top') {
    panelEl.scrollTop = 0
    return
  }
  if (scroll === 'keep') {
    panelEl.scrollTop = keep
    return
  }
  const mark = panelEl.querySelector<HTMLElement>('.next')
  const row = mark?.closest('li') ?? panelEl.querySelector<HTMLElement>('li:last-child')
  if (!row) return
  const cover = panelEl.querySelector('.sheet-head')?.getBoundingClientRect().height ?? 72
  const delta = row.getBoundingClientRect().top - panelEl.getBoundingClientRect().top
  panelEl.scrollTop = Math.max(0, delta - cover - 8)
}

function vehicleById(
  id: string,
  now: Date,
): { vehicle: Vehicle; line: Line; color: string } | null {
  for (const row of lines) {
    if (!id.startsWith(`${row.line.id}-`)) continue
    const vehicle = vehiclesAt(row.line, row.cumulative, now).find((v) => v.id === id)
    if (vehicle) return { vehicle, line: row.line, color: row.color }
  }
  return null
}

function lineChip(id: string, color: string): string {
  return `<button type="button" class="badge" data-line="${esc(id)}" style="background:${color}">${esc(id)}</button>`
}

function otherWayHtml(id: string): string {
  const family = lineFamily(id)
  const siblings = lines.filter(
    (row) => row.line.id !== id && lineFamily(row.line.id) === family,
  )
  if (!siblings.length) return ''
  return `<p class="other-way">Other way ${siblings
    .map((row) => lineChip(row.line.id, row.color))
    .join('')}</p>`
}

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * One published day, in listed order. A time after midnight (00:00 at the end of
 * the list) stays after the evening departures, so it is not treated as already gone.
 */
function scheduleMarks(
  times: string[],
  now: Date,
): { hhmm: string; passed: boolean; next: boolean }[] {
  let prev = -1
  let offset = 0
  const points = times.map((hhmm) => {
    const clock = minutesOf(hhmm)
    if (prev >= 0 && clock < prev) offset = 24 * 60
    prev = clock
    return { hhmm, at: clock + offset }
  })
  const nowAt = now.getHours() * 60 + now.getMinutes()
  let marked = false
  return points.map((point) => {
    const passed = point.at <= nowAt
    const next = !passed && !marked
    if (next) marked = true
    return { hhmm: point.hhmm, passed, next }
  })
}

/** Departures that have not left the first stop yet. */
function upcomingDepartures(line: Line, now: Date, limit = 8): string[] {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const times = line.departures[dayType(now)] ?? line.departures.workday
  const out: string[] = []
  for (const hhmm of times) {
    const [hours, minutes] = hhmm.split(':').map(Number)
    if (hours * 60 + minutes <= nowMin) continue
    out.push(hhmm)
    if (out.length >= limit) break
  }
  return out
}

const DAY_LABELS: [DayType, string][] = [
  ['workday', 'Workday'],
  ['saturday', 'Saturday'],
  ['sunday', 'Sunday'],
]

function daySwitch(now: Date): string {
  if (lineSheet !== 'timetable') return ''
  const today = dayType(now)
  const shown = timetableDay ?? today
  const buttons = DAY_LABELS.map(([day, label]) => {
    const on = shown === day ? ' on' : ''
    const mark = today === day ? ' today' : ''
    return `<button type="button" class="sheet${on}${mark}" data-day="${day}">${label}</button>`
  }).join('')
  return `<div class="sheet-switch days">${buttons}</div>`
}

function lineHead(line: Line, color: string, now: Date): string {
  const minutes = Math.max(1, Math.round(line.tripSeconds / 60))
  return `<div class="sheet-head">
        <h3><button type="button" class="line-id" data-line="${esc(line.id)}"><i class="chip" style="background:${color}"></i>${esc(line.id)}</button></h3>
        <p class="route">${esc(line.route)}</p>
        <p class="meta">${minutes} min · ${esc(dayType(now))}</p>
        <div class="sheet-switch">
          <button type="button" class="sheet${lineSheet === 'live' ? ' on' : ''}" data-sheet="live">Live</button>
          <button type="button" class="sheet${lineSheet === 'timetable' ? ' on' : ''}" data-sheet="timetable">Timetable</button>
        </div>
        ${daySwitch(now)}
        ${otherWayHtml(line.id)}
      </div>`
}

/** One day's departures, one row per hour. Today grays past minutes and marks the next one. */
function timetableHtml(line: Line, now: Date): string {
  const shown = timetableDay ?? dayType(now)
  const times = line.departures[shown] ?? []
  const marks =
    shown === dayType(now)
      ? scheduleMarks(times, now)
      : times.map((hhmm) => ({ hhmm, passed: false, next: false }))
  if (!marks.length) return `<p class="empty">No departures this day.</p>`
  const hours: { hour: string; mins: { mm: string; cls: string }[] }[] = []
  for (const mark of marks) {
    const [hour, mm] = mark.hhmm.split(':')
    const cls = mark.passed ? 'passed' : mark.next ? 'next' : ''
    const last = hours.at(-1)
    if (!last || last.hour !== hour) hours.push({ hour, mins: [{ mm, cls }] })
    else last.mins.push({ mm, cls })
  }
  const rows = hours
    .map((row) => {
      const chips = row.mins
        .map((min) => `<span class="min${min.cls ? ` ${min.cls}` : ''}">${esc(min.mm)}</span>`)
        .join('')
      return `<li><span class="hour">${esc(row.hour)}</span><span class="mins">${chips}</span></li>`
    })
    .join('')
  return `<ul class="timetable">${rows}</ul>`
}

function renderLine(now: Date): boolean {
  const row = lines.find((r) => r.line.id === selectedLineId)
  if (!row) {
    selectedLineId = null
    return false
  }
  const { line, cumulative, color } = row
  const running = vehiclesAt(line, cumulative, now)
    .map((vehicle) => ({
      vehicle,
      next: itinerary(line, vehicle.departedAt, vehicle.along, now).find((call) => call.next),
    }))
    .sort((a, b) => (a.next?.at.getTime() ?? 0) - (b.next?.at.getTime() ?? 0))

  const road = running.length
    ? `<ul>${running
        .map(({ vehicle, next }) => {
          const name = next?.name ?? line.stops.at(-1)?.name ?? ''
          const mins = next
            ? Math.max(0, Math.round((next.at.getTime() - now.getTime()) / 60000))
            : 0
          const eta = !next ? 'at last stop' : mins === 0 ? 'now' : `in ${mins} min`
          return `<li><button type="button" class="road" data-bus="${esc(vehicle.id)}" data-line="${esc(line.id)}"><span class="stop">${esc(name)}</span><span class="when">left ${esc(vehicle.departedAt)} · ${eta}</span></button></li>`
        })
        .join('')}</ul>`
    : `<p class="empty">None on the road right now.</p>`

  const upcoming = upcomingDepartures(line, now)
  const departures = upcoming.length
    ? `<ul>${upcoming
        .map((hhmm) => `<li><span class="line">departs ${esc(hhmm)}</span></li>`)
        .join('')}</ul>`
    : `<p class="empty">No more departures today.</p>`

  const stops = `<ul>${line.stops
    .map(
      (stop) =>
        `<li><button type="button" data-stop="${stopKey(stop.lat, stop.lon)}"><span class="stop">${esc(stop.name)}</span></button></li>`,
    )
    .join('')}</ul>`

  const shownDay = timetableDay ?? dayType(now)
  const viewKey =
    lineSheet === 'timetable' ? `${line.id}:timetable:${shownDay}` : `${line.id}:live`
  const scroll =
    viewKey === linePanelKey ? 'keep' : lineSheet === 'timetable' && shownDay === dayType(now) ? 'next' : 'top'
  linePanelKey = viewKey
  const body =
    lineSheet === 'timetable'
      ? timetableHtml(line, now)
      : `<h4>On the road</h4>
      ${road}
      <h4>Next departures</h4>
      ${departures}
      <h4>Stops</h4>
      ${stops}`
  paintPanel(
    `<div class="arrivals">
      ${lineHead(line, color, now)}
      ${body}
      <p class="empty">simulated from timetable</p>
      <button type="button" id="clear-panel">clear</button>
    </div>`,
    scroll,
  )
  return true
}

function paintBusFollow(line: Line, color: string, calls: Call[], note: string) {
  const nextAt = calls.findIndex((call) => call.next)
  const key = `${selectedBusId}:${nextAt}`
  const scroll = key === followKey ? 'keep' : 'next'
  followKey = key
  const rows = calls
    .map((call, i) => {
      const stop = line.stops[i]
      const cls = call.passed ? ' class="passed"' : call.next ? ' class="next"' : ''
      return `<li${cls}><button type="button" data-stop="${stopKey(stop.lat, stop.lon)}"><span class="stop">${esc(call.name)}</span><span class="when">${clock(call.at)}</span></button></li>`
    })
    .join('')
  paintPanel(
    `<div class="arrivals">
        <div class="sheet-head">
          <h3><i class="chip" style="background:${color}"></i>${esc(line.id)}</h3>
          <p class="route">${esc(line.route)}</p>
        </div>
        <ul>${rows}</ul>
        <p class="empty">${esc(note)}</p>
        <button type="button" id="clear-panel">clear</button>
      </div>`,
    scroll,
  )
}

function renderPanel(now: Date) {
  stopRingColors = new Map()
  if (usingLive && selectedBusId) {
    const live = liveBuses.find((bus) => bus.id === selectedBusId)
    const row = live ? lines.find((item) => item.line.id === live.line) : undefined
    if (!live || !row) {
      clearBus()
    } else {
      if (selectedBusLineId !== row.line.id) {
        selectedBusLineId = row.line.id
        showOnlyRoute(row.line.id)
      }
      dueIds = new Set()
      const along = nearestAlong(row.line, row.cumulative, live.lat, live.lng)
      paintBusFollow(
        row.line,
        row.color,
        itineraryFromAlong(row.line, along, now),
        'live GPS · gray stops are already passed',
      )
      return
    }
  }

  if (selectedBusId) {
    const found = vehicleById(selectedBusId, now)
    if (!found) {
      clearBus()
    } else {
      dueIds = new Set()
      const { vehicle, line, color } = found
      paintBusFollow(
        line,
        color,
        itinerary(line, vehicle.departedAt, vehicle.along, now),
        'simulated from timetable · gray stops are already passed',
      )
      return
    }
  }

  if (selectedLineId && renderLine(now)) return

  followKey = ''
  linePanelKey = ''

  if (!selected) {
    dueIds = new Set()
    const chips = lines
      .map(({ line, color }) => `<li>${lineChip(line.id, color)}</li>`)
      .join('')
    paintPanel(
      `<div class="arrivals">
      <h3>Lines</h3>
      <p class="empty">Click a line to see its route, a stop for the buses coming there and the routes they will take, or a bus to follow it.</p>
      <ul class="serving">${chips}</ul>
    </div>`,
      'top',
    )
    return
  }

  const stop = selected
  const rows = arrivalsAtStop(
    lines.map((row) => row.line),
    stop.name,
    stop.lat,
    stop.lon,
    now,
  )
  dueIds = new Set(rows.flatMap((row) => (row.vehicleId ? [row.vehicleId] : [])))
  // Same polylines as selecting each of these buses, so the roads they still cover stay visible.
  showRoutes(rows.map((row) => row.lineId))

  const serving = lines.filter(({ line }) =>
    servesStop(line, stop.name, stop.lat, stop.lon),
  )
  const rings = new Map<string, string>()
  for (const { line, color } of serving) {
    for (const call of line.stops) {
      const key = stopKey(call.lat, call.lon)
      if (!rings.has(key)) rings.set(key, color)
    }
  }
  stopRingColors = rings
  const lineList = serving.length
    ? `<ul class="serving">${serving
        .map(({ line, color }) => `<li>${lineChip(line.id, color)}</li>`)
        .join('')}</ul>`
    : `<p class="empty">No lines stop here.</p>`

  const body = rows.length
    ? `<ul>${rows
        .map((row) => {
          const label =
            row.kind === 'departs'
              ? row.minutes === 0
                ? 'departs now'
                : `departs in ${row.minutes} min`
              : row.minutes === 0
                ? 'now'
                : `in ${row.minutes} min`
          const when = `<span class="when">${label} · ${clock(row.arrivesAt)}</span>`
          if (row.onMap && row.vehicleId) {
            const color = colorFor(row.lineId)
            return `<li><button type="button" class="bus" data-bus="${esc(row.vehicleId)}" data-line="${esc(row.lineId)}"><span class="line"><i class="live"></i><span class="badge" style="background:${color}">${esc(row.lineId)}</span></span>${when}</button></li>`
          }
          return `<li><span class="line">${esc(row.lineId)}</span>${when}</li>`
        })
        .join('')}</ul>`
    : `<p class="empty">No more buses to this stop today.</p>`

  paintPanel(
    `<div class="arrivals">
    <h3>${esc(stop.name)}</h3>
    <p class="map-link"><a href="${googleMapsUrl(stop.lat, stop.lon)}" target="_blank" rel="noopener">Google Maps</a></p>
    <h4>Lines</h4>
    ${lineList}
    <h4>Next</h4>
    ${body}
    <p class="empty">simulated from timetable</p>
    <p class="empty legend"><i class="live"></i> already on the map</p>
    <button type="button" id="clear-panel">clear</button>
  </div>`,
    'top',
  )
}

function clearStop() {
  if (!selected) return
  selected.marker.setStyle(stopStyle)
  selected.marker.setRadius(stopRadius(map.getZoom()))
  selected = null
  dueIds = new Set()
  stopRingColors = new Map()
}

function clearBus() {
  selectedBusId = null
  selectedBusLineId = null
  followKey = ''
  hideRoutes()
}

function clearLine() {
  if (!selectedLineId) return
  selectedLineId = null
  linePanelKey = ''
  lineSheet = 'live'
  timetableDay = null
  hideRoutes()
}

function lineStopStyle(color: string) {
  return {
    color,
    weight: 3,
    fillColor: '#fff',
    fillOpacity: 1,
  }
}

/**
 * Line mode draws this direction's poles larger, in the line color, and hides the rest.
 * Bus mode and stop mode keep every pole, and ring the ones on the relevant lines.
 */
function paintPoles() {
  const row = selectedLineId
    ? lines.find((r) => r.line.id === selectedLineId)
    : undefined
  const busRow =
    !row && selectedBusLineId
      ? lines.find((r) => r.line.id === selectedBusLineId)
      : undefined
  const marked = row ?? busRow
  const onLine = new Set(
    marked ? marked.line.stops.map((stop) => stopKey(stop.lat, stop.lon)) : [],
  )
  const radius = stopRadius(map.getZoom())
  for (const [key, pole] of poles) {
    if (row && !onLine.has(key)) {
      if (map.hasLayer(pole.marker)) pole.marker.remove()
      continue
    }
    // remove() takes the marker off the map but leaves it in the group, so check the map.
    if (!map.hasLayer(pole.marker)) pole.marker.addTo(stopLayer)
    const ring = stopRingColors.get(key)
    if (selected?.marker === pole.marker) {
      pole.marker.setStyle(selectedStopStyle)
      pole.marker.setRadius(Math.max(radius, 8))
    } else if (ring) {
      pole.marker.setStyle(lineStopStyle(ring))
      pole.marker.setRadius(Math.max(radius, 6))
      pole.marker.bringToFront()
    } else if (marked && onLine.has(key)) {
      pole.marker.setStyle(lineStopStyle(marked.color))
      pole.marker.setRadius(Math.max(radius, 6))
      if (busRow) pole.marker.bringToFront()
    } else {
      pole.marker.setStyle(stopStyle)
      pole.marker.setRadius(radius)
    }
  }
  selected?.marker.bringToFront()
}

function toggleStop(
  name: string,
  lat: number,
  lon: number,
  marker: L.CircleMarker,
) {
  const same = selected?.marker === marker
  clearStop()
  clearBus()
  clearLine()
  if (!same) {
    selected = { name, lat, lon, marker }
    marker.setStyle(selectedStopStyle)
    marker.setRadius(Math.max(stopRadius(map.getZoom()), 8))
  }
  tick()
}

function selectBus(vehicleId: string, lineId: string) {
  if (selectedBusId === vehicleId) {
    clearBus()
    tick()
    return
  }
  clearStop()
  // Keep the polyline when drilling into a bus that is already on this line.
  if (selectedLineId === lineId) {
    selectedLineId = null
    linePanelKey = ''
    lineSheet = 'live'
    timetableDay = null
  } else {
    clearLine()
  }
  selectedBusId = vehicleId
  selectedBusLineId = lineId
  showOnlyRoute(lineId)
  tick()
}

function toggleLine(id: string) {
  if (selectedLineId === id) {
    clearLine()
    tick()
    return
  }
  clearStop()
  clearBus()
  selectedLineId = id
  showOnlyRoute(id)
  const route = routes.get(id)
  if (route) map.fitBounds(route.getBounds(), { padding: [28, 28], maxZoom: 16 })
  tick()
}

map.on('click', () => {
  if (!selected && !selectedBusId && !selectedLineId) return
  clearStop()
  clearBus()
  clearLine()
  tick()
})

function markDue(id: string, marker: L.Marker) {
  const el = marker.getElement()
  if (!el) return
  const watching = selected !== null
  el.classList.toggle('is-due', watching && dueIds.has(id))
  el.classList.toggle('is-dim', watching && !dueIds.has(id))
  el.classList.toggle('is-selected', selectedBusId === id)
}

function tick() {
  const now = new Date()
  renderPanel(now)
  const seen = new Set<string>()
  let count = 0

  if (usingLive) {
    for (const v of liveBuses) {
      seen.add(v.id)
      count++
      const marker = markers.get(v.id)
      const minutes =
        v.secondsLeft == null ? '' : ` · ${Math.max(1, Math.round(v.secondsLeft / 60))} min`
      const tip = `${v.line}${minutes}${v.stopName ? ` · ${v.stopName}` : ''}`
      if (marker) {
        marker.setLatLng([v.lat, v.lng])
        const icon = liveIcon(v.line)
        if (marker.getIcon() !== icon) marker.setIcon(icon)
        marker.setTooltipContent(tip)
        markDue(v.id, marker)
      } else {
        const created = L.marker([v.lat, v.lng], { icon: liveIcon(v.line) }).addTo(map)
        created.bindTooltip(tip)
        created.on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          const current = liveBuses.find((bus) => bus.id === v.id)
          if (!current || !lines.some((row) => row.line.id === current.line)) return
          selectBus(current.id, current.line)
        })
        markers.set(v.id, created)
        markDue(v.id, created)
      }
    }
  } else {
    for (const { line, cumulative } of lines) {
      if (selectedLineId && line.id !== selectedLineId) continue
      for (const v of vehiclesAt(line, cumulative, now)) {
        seen.add(v.id)
        count++

        const marker = markers.get(v.id)
        if (marker) {
          marker.setLatLng([v.lat, v.lon])
          markDue(v.id, marker)
        } else {
          const created = L.marker([v.lat, v.lon], { icon: icons.get(v.lineId) }).addTo(map)
          created.on('click', (event) => {
            L.DomEvent.stopPropagation(event)
            selectBus(v.id, v.lineId)
          })
          markers.set(v.id, created)
          markDue(v.id, created)
        }
      }
    }
  }

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      marker.remove()
      markers.delete(id)
    }
  }

  paintPoles()

  if (usingLive) {
    sourceNote.textContent = 'live GPS'
    statusEl.textContent = `${liveStatus} · ${count} bus(es) · ${now.toLocaleTimeString('sr-RS')}`
  } else {
    sourceNote.textContent = 'simulated from timetable, not GPS'
    statusEl.textContent = `${dayType(now)} · ${count} bus(es) · ${shown.size} line(s) shown · ${now.toLocaleTimeString('sr-RS')}`
  }
}

tick()
setInterval(tick, 1000)
