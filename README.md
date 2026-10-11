# STAC Viewer

A static, serverless viewer for Canadian LiDAR and imagery: **LiDAR point clouds** (NRCan
CanElevation, COPC), **LiDAR-derived rasters** (HRDEM 1 m DTM, DSM and canopy height), **Sentinel-2** composites and
indices, and **LiDAR × imagery fusion** for land cover, searched and drawn entirely in
the browser. It is hosted on GitHub Pages; every byte of data comes straight from public object
storage.

**Live:** https://fraxinusenviro.github.io/stac-viewer/

| Tab | Source | How |
|---|---|---|
| Point clouds | NRCan CanElevation COPC tiles on S3 | A static GeoParquet tile index (`public/data/`) searched with [hyparquet](https://github.com/hyparam/hyparquet) by HTTP range reads. Only the row groups whose bbox statistics meet the view are read. |
| Rasters | NRCan datacube STAC (`hrdem-lidar`, `hrdem-mosaic-1m/2m`) | Seven products per source: **DTM** (bare earth) or **DSM** (surface incl. trees and buildings), each as hillshade, elevation or shaded elevation, and the **canopy height model** (DSM − DTM), added as separate layers. The colour ramp is stretched to the view (2nd–98th percentile). COGs in EPSG:3979, range-read with geotiff.js and warped into map tiles in the browser. Projects are filtered by their **true** coverage (`extent` asset), not their STAC envelope. |
| Imagery | Element 84 Earth Search, `sentinel-2-c1-l2a` | True colour (TCI), natural colour, false colour IR, agriculture, SWIR and geology composites; NDVI, EVI, SAVI, GNDVI, NDRE, NDMI, NDWI, MNDWI, NBR and NDBI; SCL classes; any single band; custom RGB. Per-channel histogram with 2–98 % / Min/Max, curve (linear, square root, log), gamma and nodata, as in the reference explorer. Values are **reflectance**, from each asset's STAC `raster:bands` scale and offset (the baseline ≥ 04.00 BOA offset included). |
| Fusion | Both of the above, per pixel | **Rule-based classes** from a rule set you edit (below), the **structure · greenness · water** composite (CHM · NDVI · NDWI as RGB), and a **custom fusion RGB** of any variable. An optional **leaf-off scene** adds leaf-off indices and bands and the seasonal change (Δ NDVI, Δ EVI, Δ NIR…). "Find inputs for this view" picks the newest LiDAR project with a DSM, the clearest leaf-on scene (June–September) and the clearest leaf-off one (late April–mid May, or November) of the last three years. |

The approach follows [taylor-geospatial/s2-stac-geoparquet](https://github.com/taylor-geospatial/s2-stac-geoparquet):
a static index on object storage, a pure-JS parquet reader instead of DuckDB-WASM, `cache: "no-store"`
range reads, and client-side COG warping through a proj4 control grid.

## Rule-based classes

A rule set is an ordered list of rules. Each rule has a class name, a colour and conditions on any variable (canopy
height, DTM, DSM, any index or band of either scene, any seasonal change), and **all** of a rule's conditions must hold.
A pixel takes the first rule it satisfies, and a pixel that satisfies none is left unclassified. Rules that share a name and a
colour are one class, which is how you write an OR. A condition on a variable with no value at the pixel is false, so no
rule can claim ground it cannot see. Cloud, shadow and snow can be masked with each scene's SCL. Rule sets are saved
in the browser and can be exported or imported as JSON.

Presets: **Land cover** (water, trees, shrub, low vegetation, structure, bare), **Forest type — one leaf-on scene**
(leaf-on NIR: broadleaf canopy reflects far more NIR than conifer) and **Forest type — leaf-on and leaf-off scenes**
(Δ NDVI: broadleaf loses its greenness and conifer keeps it). Their thresholds are starting points.

**Compare samples** calibrates them. Tap crowns of two kinds (say broadleaf and conifer) and every variable is ranked by
the balanced accuracy of its best single cut, with each label's mean ± sd and Cohen's d. **Use** turns a cut into a
pair of rules, restricted to the canopy height the samples were taken in. These are training figures on your samples.
They describe those samples, not the map.

## How it draws

One engine (`src/engine.ts`) draws every product. A product (`src/products.ts`) names its inputs and computes each
output channel per pixel from them. For each map tile, every input is sampled onto the tile's pixel grid from its own
COG, in its own CRS, at its own best overview. That is how a 10 m UTM Sentinel-2 band and a 1 m Lambert LiDAR DSM meet in
one pixel. The sampled planes are cached per tile, so stretch and threshold changes repaint without re-downloading.

The fusion classes are a **screening** product. The LiDAR and the imagery are rarely the same year, and the resolutions
differ (1 m against 10–20 m). Both dates are shown beside the product.

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
