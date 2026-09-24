import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import line4A from './data/4A.json'
import line4B from './data/4B.json'
import { dayType, shapeDistances, vehiclesAt } from './simulate.ts'
import './style.css'
import type { Line } from './types.ts'

const COLORS: Record<string, string> = { '4A': '#c45c26', '4B': '#2d6a8e' }

const lines = [line4A as Line, line4B as Line].map((line) => ({
  line,
  cumulative: shapeDistances(line),
  color: COLORS[line.id],
}))

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="bar">
    <div>
      <strong>nsbus</strong>
      <span class="muted">JGSP Novi Sad · line 4</span>
    </div>
    <div id="status" class="muted"></div>
    <span class="muted warn">simulated from timetable, not GPS</span>
  </header>
  <div id="map"></div>
`

const map = L.map('map')

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap · route &amp; schedule: JGSP Novi Sad',
}).addTo(map)

const bounds = L.latLngBounds([])

for (const { line, color } of lines) {
  const route = L.polyline(line.shape, {
    color,
    weight: 5,
    opacity: 0.75,
  }).addTo(map)
  bounds.extend(route.getBounds())

  for (const stop of line.stops) {
    L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      color,
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(`${line.id} · ${stop.name}`)
      .addTo(map)
  }
}

map.fitBounds(bounds.pad(0.08))

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

      const popup = `<strong>${v.lineId}</strong> departed ${v.departedAt}
        <br>${v.lastStop} → ${v.nextStop}
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

  statusEl.textContent = `${dayType(now)} · ${count} bus(es) en route · ${now.toLocaleTimeString('sr-RS')}`
}

tick()
setInterval(tick, 1000)
