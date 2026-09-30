import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import rawLines from './data/lines.json'
import { arrivalsAtStop, dayType, itinerary, shapeDistances, vehiclesAt } from './simulate.ts'
import './style.css'
import type { Line, Vehicle } from './types.ts'

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
    <span class="muted warn">simulated from timetable, not GPS</span>
  </header>
  <div class="content">
    <div id="map"></div>
    <aside id="panel" class="panel"></aside>
  </div>
`

const map = L.map('map')

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap · JGSP Novi Sad',
}).addTo(map)

const bounds = L.latLngBounds([])
for (const { line } of lines) {
  for (const point of line.shape) bounds.extend(point)
}
// Retract toward the same center so the dense core fills the map and outer tails sit off-screen.
map.fitBounds(bounds.pad(-0.32))

// Every stop of every line, drawn once even when several lines share it.
const stopLayer = L.layerGroup().addTo(map)
const stopMarkers: L.CircleMarker[] = []
const drawnStops = new Set<string>()

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
    const key = `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`
    if (drawnStops.has(key)) continue
    drawnStops.add(key)
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
    stopMarkers.push(marker)
  }
}

map.on('zoomend', () => {
  const radius = stopRadius(map.getZoom())
  for (const marker of stopMarkers) marker.setRadius(radius)
})

const routes = new Map<string, L.Polyline>()
const shown = new Set<string>()

function hideRoutes() {
  for (const id of shown) routes.get(id)?.remove()
  shown.clear()
}

/** One line at a time: drop whatever was drawn, then show this one. */
function showOnlyRoute(id: string) {
  for (const shownId of shown) {
    if (shownId === id) continue
    routes.get(shownId)?.remove()
    shown.delete(shownId)
  }
  if (shown.has(id)) return
  let route = routes.get(id)
  if (!route) {
    const row = lines.find((r) => r.line.id === id)!
    route = L.polyline(row.line.shape, {
      color: row.color,
      weight: 5,
      opacity: 0.85,
    })
    routes.set(id, route)
  }
  route.addTo(map)
  shown.add(id)
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
const statusEl = document.querySelector('#status')!

type SelectedStop = {
  name: string
  lat: number
  lon: number
  marker: L.CircleMarker
}

let selected: SelectedStop | null = null
let selectedBusId: string | null = null
let dueIds = new Set<string>()

function clock(date: Date): string {
  return date.toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' })
}

const panelEl = document.querySelector<HTMLElement>('#panel')!
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
  const row =
    panelEl.querySelector<HTMLElement>('.next') ??
    panelEl.querySelector<HTMLElement>('li:last-child')
  if (!row) return
  const delta = row.getBoundingClientRect().top - panelEl.getBoundingClientRect().top
  panelEl.scrollTop = Math.max(0, delta - 72)
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

function renderPanel(now: Date) {
  if (selectedBusId) {
    const found = vehicleById(selectedBusId, now)
    if (!found) {
      clearBus()
    } else {
      dueIds = new Set()
      const { vehicle, line, color } = found
      const calls = itinerary(line, vehicle.departedAt, vehicle.along, now)
      const nextAt = calls.findIndex((call) => call.next)
      const key = `${selectedBusId}:${nextAt}`
      const scroll = key === followKey ? 'keep' : 'next'
      followKey = key
      const rows = calls
        .map((call) => {
          const cls = call.passed ? ' class="passed"' : call.next ? ' class="next"' : ''
          return `<li${cls}><span class="stop">${esc(call.name)}</span><span class="when">${clock(call.at)}</span></li>`
        })
        .join('')
      paintPanel(
        `<div class="arrivals">
        <div class="sheet-head">
          <h3><i class="chip" style="background:${color}"></i>${esc(vehicle.lineId)}</h3>
          <p class="route">${esc(line.route)}</p>
        </div>
        <ul>${rows}</ul>
        <p class="empty">simulated from timetable · gray stops are already passed</p>
        <button type="button" id="clear-panel">clear</button>
      </div>`,
        scroll,
      )
      return
    }
  }

  followKey = ''

  if (!selected) {
    dueIds = new Set()
    paintPanel(
      `<div class="arrivals">
      <h3>Arrivals</h3>
      <p class="empty">Click a stop to see which buses are coming, or a bus to follow it.</p>
    </div>`,
      'top',
    )
    return
  }

  const rows = arrivalsAtStop(
    lines.map((row) => row.line),
    selected.name,
    selected.lat,
    selected.lon,
    now,
  )
  dueIds = new Set(rows.flatMap((row) => (row.vehicleId ? [row.vehicleId] : [])))

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
          const dot = row.onMap ? '<i class="live"></i>' : ''
          return `<li><span class="line">${dot}${row.lineId}</span>
            <span class="when">${label} · ${clock(row.arrivesAt)}</span></li>`
        })
        .join('')}</ul>`
    : `<p class="empty">No more buses to this stop today.</p>`

  paintPanel(
    `<div class="arrivals">
    <h3>${esc(selected.name)}</h3>
    ${body}
    <p class="empty">simulated from timetable · ● already rolling</p>
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
}

function clearBus() {
  selectedBusId = null
  followKey = ''
  hideRoutes()
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
  selectedBusId = vehicleId
  showOnlyRoute(lineId)
  tick()
}

map.on('click', () => {
  if (!selectedBusId) return
  clearBus()
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

  for (const { line, cumulative } of lines) {
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

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      marker.remove()
      markers.delete(id)
    }
  }

  statusEl.textContent = `${dayType(now)} · ${count} bus(es) · ${shown.size} line(s) shown · ${now.toLocaleTimeString('sr-RS')}`
}

tick()
setInterval(tick, 1000)
