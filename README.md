# nsbus2

Novi Sad city bus map (Leaflet + Vite). Positions come from one of two modes. The map shows one selection at a time: a bus, a bus stop, or a bus line.

## Modes

Where the buses on the map come from. The header says which one is on.

- **Simulated** is the public map. Buses are placed from the city timetable (`timetableBuses` in `src/simulate.ts`). The note reads "simulated from timetable, not GPS".
- **GPS** is the admin page only (`admin.html`, behind `ADMIN_PATH`). A Live GPS switch polls the backend and snaps each fix onto a route (`placeLive`). The note reads "live GPS". The public bundle never receives the backend address or token.

## Selections

One of these is open at a time. Choosing another clears the previous one. Clicking the map clears all of them. Clicking the same bus, stop, or line again clears it.

- **Bus** follows one vehicle: its route, and the stops still ahead with times. Stops already passed are gray. Every stop stays on the map; stops on this line are ringed in the line color.
- **Bus stop** lists the lines that serve that pole and the buses coming there, and draws the roads those buses still cover. Every stop stays on the map; stops on the serving lines are ringed.
- **Bus line** draws that direction's route and fits it in view. Stops on the line are drawn larger in the line color; the rest are hidden. The panel switches between live buses on the road and the day's timetable.

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
