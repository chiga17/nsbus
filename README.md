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

1. Open [Gradski red vožnje](http://www.gspns.rs/red-voznje/gradski), select all lines, click PRIKAŽI.
2. Save the `ispis-polazaka` Network response as `src/data/red-voznje-resp.html`.
3. Run:

```bash
npm run data
```

This regenerates `src/data/lines.json` and `src/data/stop-orders.json`. Geometry responses are cached under `scratch/` (gitignored).

See [LINKS.md](LINKS.md) for data sources.
