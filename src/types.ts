export type Stop = {
  name: string
  lat: number
  lon: number
  /** metres from the start of the shape */
  along: number
}

export type DayType = 'workday' | 'saturday' | 'sunday'

export type Line = {
  id: string
  name: string
  route: string
  source: string
  tripSeconds: number
  shape: [number, number][]
  stops: Stop[]
  departures: Record<DayType, string[]>
}

export type Vehicle = {
  id: string
  lineId: string
  lat: number
  lon: number
  lastStop: string
  nextStop: string
  departedAt: string
  progress: number
  along: number
}

export type Arrival = {
  vehicleId: string | null
  lineId: string
  lineName: string
  departedAt: string
  arrivesAt: Date
  minutes: number
  onMap: boolean
  kind: 'arrives' | 'departs'
}
