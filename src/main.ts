import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import rawLines from './data/lines.json'
import { dayType, shapeDistances, vehiclesAt } from './simulate.ts'
import './style.css'
import type { Line } from './types.ts'

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

function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

const allLines = (rawLines as unknown as Line[]).map((line, i) => ({
  line,
  cumulative: shapeDistances(line),
  color: colorFor(line.id),
  index: i,
}))

const enabled = new Set(allLines.map((row) => row.line.id))

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="bar">
    <div>
      <strong>nsbus</strong>
      <span class="muted">JGSP Novi Sad · gradski</span>
    </div>
    <div id="status" class="muted"></div>
    <span class="muted warn">simulated from timetable, not GPS</span>
  </header>
  <div class="filters">
    <button type="button" id="toggle-all">all</button>
    ${allLines
      .map(
        ({ line, color }) =>
          `<label style="--c:${color}"><input type="checkbox" data-line="${line.id}" checked> ${line.id}</label>`,
      )
      .join('')}
  </div>
  <div id="map"></div>
`

const map = L.map('map')

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap · JGSP Novi Sad',
}).addTo(map)

const bounds = L.latLngBounds([])
const routes = new Map<string, L.Polyline>()

for (const { line, color } of allLines) {
  const route = L.polyline(line.shape, {
    color,
    weight: 4,
    opacity: 0.55,
  }).addTo(map)
  routes.set(line.id, route)
  bounds.extend(route.getBounds())
}

map.fitBounds(bounds.pad(0.06))

const icons = new Map(
  allLines.map(({ line, color }) => [
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

function visibleRows() {
  return allLines.filter((row) => enabled.has(row.line.id))
}

function tick() {
  const now = new Date()
  const seen = new Set<string>()
  let count = 0

  for (const { line, cumulative } of visibleRows()) {
    for (const v of vehiclesAt(line, cumulative, now)) {
      seen.add(v.id)
      count++
      const popup = `<strong>${v.lineId}</strong> ${line.route}
        <br>left ${v.departedAt} · ${v.lastStop} → ${v.nextStop}
        <br><small>${Math.round(v.progress * 100)}% of the route</small>`
      const marker = markers.get(v.id)
      if (marker) {
        marker.setLatLng([v.lat, v.lon])
        marker.setPopupContent(popup)
      } else {
        markers.set(
          v.id,
          L.marker([v.lat, v.lon], { icon: icons.get(v.lineId) })
            .bindPopup(popup)
            .addTo(map),
        )
      }
    }
  }

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      marker.remove()
      markers.delete(id)
    }
  }

  statusEl.textContent = `${dayType(now)} · ${count} bus(es) · ${visibleRows().length}/${allLines.length} lines · ${now.toLocaleTimeString('sr-RS')}`
}

function syncRoutes() {
  for (const { line } of allLines) {
    const route = routes.get(line.id)
    if (!route) continue
    if (enabled.has(line.id)) route.addTo(map)
    else route.remove()
  }
  tick()
}

document.querySelectorAll<HTMLInputElement>('input[data-line]').forEach((input) => {
  input.addEventListener('change', () => {
    const id = input.dataset.line!
    if (input.checked) enabled.add(id)
    else enabled.delete(id)
    syncRoutes()
  })
})

document.querySelector('#toggle-all')!.addEventListener('click', () => {
  const allOn = enabled.size === allLines.length
  enabled.clear()
  document.querySelectorAll<HTMLInputElement>('input[data-line]').forEach((input) => {
    input.checked = !allOn
    if (!allOn) enabled.add(input.dataset.line!)
  })
  syncRoutes()
})

tick()
setInterval(tick, 1000)
