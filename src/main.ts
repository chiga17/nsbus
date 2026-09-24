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
  <div id="map"></div>
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
map.fitBounds(bounds.pad(0.06))

// Every stop of every line, drawn once even when several lines share it.
const stopLayer = L.layerGroup().addTo(map)
const stopMarkers: L.CircleMarker[] = []
const drawnStops = new Set<string>()

/** circleMarker radius is in pixels, so grow it as the user zooms in. */
function stopRadius(zoom: number): number {
  return Math.min(9, Math.max(3, Math.round(zoom) - 9))
}

for (const { line } of lines) {
  for (const stop of line.stops) {
    const key = `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`
    if (drawnStops.has(key)) continue
    drawnStops.add(key)
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: stopRadius(map.getZoom()),
      color: '#41505f',
      weight: 2,
      fillColor: '#fff',
      fillOpacity: 1,
    })
      .bindTooltip(stop.name)
      .addTo(stopLayer)
    stopMarkers.push(marker)
  }
}

map.on('zoomend', () => {
  const radius = stopRadius(map.getZoom())
  for (const marker of stopMarkers) marker.setRadius(radius)
})

const routes = new Map<string, L.Polyline>()
const shown = new Set<string>()

function toggleRoute(id: string) {
  if (shown.has(id)) {
    routes.get(id)?.remove()
    shown.delete(id)
    return
  }
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

function tick() {
  const now = new Date()
  const seen = new Set<string>()
  let count = 0

  for (const { line, cumulative } of lines) {
    for (const v of vehiclesAt(line, cumulative, now)) {
      seen.add(v.id)
      count++
      const popup = `<strong>${v.lineId}</strong> ${line.route}
        <br>left ${v.departedAt} · ${v.lastStop} → ${v.nextStop}
        <br><small>${Math.round(v.progress * 100)}% of the route · click the bus to toggle its line</small>`

      const marker = markers.get(v.id)
      if (marker) {
        marker.setLatLng([v.lat, v.lon])
        marker.setPopupContent(popup)
      } else {
        const created = L.marker([v.lat, v.lon], { icon: icons.get(v.lineId) })
          .bindPopup(popup)
          .addTo(map)
        created.on('click', () => toggleRoute(v.lineId))
        markers.set(v.id, created)
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
