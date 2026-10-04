# nsbus2

Simulated Novi Sad city bus map (Leaflet + Vite).

## Run

Needs Node.js.

```bash
npm install
npm run dev
```

## Rebuild city data

Needs Python 3 (stdlib only) and network access to [gspns.rs](http://www.gspns.rs/).

```bash
npm run data
```

This downloads the city timetable for workday, Saturday, and Sunday, then regenerates `src/data/lines.json` and `src/data/stop-orders.json`. Geometry responses are cached under `scratch/` (gitignored).

See [LINKS.md](LINKS.md) for data sources.
