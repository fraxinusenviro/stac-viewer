# STAC Viewer

A static, serverless viewer for Canadian LiDAR and imagery: **LiDAR point clouds** (NRCan
CanElevation, COPC), **LiDAR-derived rasters** (HRDEM 1 m DTM and DSM) and **Sentinel-2** true colour, searched and drawn entirely in
the browser. It is hosted on GitHub Pages; every byte of data comes straight from public object
storage.

**Live:** https://fraxinusenviro.github.io/stac-viewer/

| Tab | Source | How |
|---|---|---|
| Point clouds | NRCan CanElevation COPC tiles on S3 | A static GeoParquet tile index (`public/data/`) searched with [hyparquet](https://github.com/hyparam/hyparquet) by HTTP range reads. Only the row groups whose bbox statistics meet the view are read. |
| Rasters | NRCan datacube STAC (`hrdem-lidar`, `hrdem-mosaic-1m/2m`) | Six products per source: **DTM** (bare earth) or **DSM** (surface incl. trees and buildings), each as hillshade, elevation or shaded elevation, added as separate layers. The colour ramp is stretched to the view (2nd–98th percentile). COGs in EPSG:3979, range-read with geotiff.js and warped into map tiles in the browser. Projects are filtered by their **true** coverage (`extent` asset), not their STAC envelope. |
| Imagery | Element 84 Earth Search, `sentinel-2-c1-l2a` | The scene's `visual` (TCI) COG, drawn the same way. |

The approach follows [taylor-geospatial/s2-stac-geoparquet](https://github.com/taylor-geospatial/s2-stac-geoparquet):
a static index on object storage, a pure-JS parquet reader instead of DuckDB-WASM, `cache: "no-store"`
range reads, and client-side COG warping through a proj4 control grid.

## Develop

```bash
npm install
npm run dev        # Vite dev server
npm test           # node --test (Node ≥ 22.18)
npm run build      # tsc && vite build → dist/
npm run index      # rebuild public/data/ from data-src/*.json
```

## The LiDAR index

`scripts/build-lidar-index.mjs` turns tile catalogues (`data-src/*.json`) into:

- `lidar-tiles.parquet`: one row per COPC tile. GeoParquet 1.1 (WKB polygon plus a bbox covering), sorted on a
  Hilbert key of the tile centre, in 512-row groups. It opens in DuckDB, QGIS and GDAL as well.
- `lidar-projects.json`: per-project URL template, CRS, vertical datum and totals.
- `lidar-coverage.geojson`: coverage on a 0.05° grid, drawn at low zoom.

It currently covers **Halifax County 2018 (Inland and Coastal)**, about 8,800 tiles. The next step is NRCan's national
tile index.

## Limits

- NAD83(CSRS) is placed with a null datum shift, as NRCan's own services display it (~1.4 m from ITRF in Nova Scotia).
- A COG in a CRS that `src/crs.ts` does not define is refused, not guessed.
- "Open in 3D" hands the COPC URL to the external viewer at viewer.copc.io.

Data: Natural Resources Canada (Open Government Licence – Canada); Copernicus Sentinel-2 via Element 84 Earth Search.
