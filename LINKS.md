# Useful links

Reference sites and data sources for this project.

## Maps & city context

- [NSMaps — Mapa Novi Sad](http://www.mapanovisad.rs/) — interactive city map

## JGSP Novi Sad (transit data)

Official JGSP site; used by `scripts/build_city.py` to build `src/data/lines.json`.

- [JGSP Novi Sad](http://www.gspns.rs/)
- [Gradski red vožnje](http://www.gspns.rs/red-voznje/gradski) — city timetable (save Network response as `src/data/red-voznje-resp.html`)
- [Mreža linija](http://www.gspns.rs/mreza) — line network / geometry catalog
- Route shape API: `http://www.gspns.rs/mreza-get-linija-tacke?linija={id}`
- Stops API: `http://www.gspns.rs/mreza-get-stajalista-tacke?linija={id}`

## Map tiles & libraries

- [OpenStreetMap tiles](https://www.openstreetmap.org/) — basemap used in `src/main.ts` (`tile.openstreetmap.org`)
- [Leaflet](https://leafletjs.com/) — map UI library
