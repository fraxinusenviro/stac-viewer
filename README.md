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

## Strata × cover classes

The default Fusion product classifies every pixel on **two axes**, as vegetation is described in the field:

- **Height stratum** from the canopy height model, with editable bands. Defaults: groundcover < 0.1 m ·
  herbaceous/forb 0.1–0.5 · low shrub 0.5–2 · high shrub 2–8 · forest > 8 m.
- **Cover type** from spectral rules (any variable, AND-ed). Each cover type lists the **strata it may occur in**:
  coniferous in low shrub, high shrub and forest; broadleaf in all five; water and bare only low.

A pixel takes the first cover type whose conditions hold **and** that allows its stratum, so a conifer-like spectrum at
0.3 m falls through to the next cover type that fits. The class is the pair ("Coniferous · high shrub"), drawn in the cover's
colour shaded by stratum. The legend is a matrix (cover × stratum) showing each cell's share of the view. Unclaimed pixels
can be shown by stratum in grey. Schemes are saved in the browser and import/export as JSON.

Limits: the CHM is the **top surface**, so a pixel is classed by its tallest layer, and shrubs under a forest canopy are not seen
(that needs the point cloud's vertical profile). DSM − DTM carries ~0.1–0.2 m of noise, and low herbs are often classified
as ground by the provider, so boundaries below ~0.5 m lean on the cover rules.

## Hillshade basemap

The basemap can be a hillshade of the NRCan HRDEM **national mosaic**: DTM (bare earth) or DSM (surface), with an
adjustable **Z-factor** (×1–×20) and sun azimuth. The mosaic is ~56 regional COGs, so the tiles meeting the view are looked
up and drawn as you pan (1 m where it exists, 2 m elsewhere, from zoom 8). The light basemap stays underneath, outside
coverage. The same Z-factor and azimuth controls appear on every hillshade layer in the Rasters tab.

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

## LiDAR sharpening (spectral unmixing by height class)

A 10 m Sentinel-2 pixel is a mixture, and the 1 m canopy height model gives its proportions: so much ground (< 1 m),
so much shrub (1–5 m), so much canopy (≥ 5 m). Over a small neighbourhood of Sentinel pixels (5 × 5 by default), each
pixel's reflectance is modelled as the share-weighted sum of one spectrum per height class. Those spectra are solved by
ridge-regularised least squares, and each 1 m pixel then takes the spectrum of its own height class. Finally each Sentinel
pixel's residual is added back, so the sharpened image averages to exactly what Sentinel-2 measured (`src/unmix.ts`, tested on
synthetic mixtures). Every imagery variable has a **· sharpened** twin for rules, composites and samples, and there is a
**LiDAR-sharpened false colour** product.

What it does and does not do: it resolves mixtures of **height classes**, so edges follow the canopy, roads, verges
and shorelines at 1 m. It cannot split a pixel that is all one height class: 10 m of continuous canopy stays one
spectrum, so broadleaf and conifer within closed canopy are still decided at 10 m. Trees and roofs share the tall class.
It applies from about zoom 15, where a Sentinel pixel spans several screen pixels.

## Conifer index (FieldMapper method)

Ported from FieldMapper's `conifer_index` (`lib/habitat/models/landcover.ts`). Each line of evidence becomes a robust
z-score over the woody pixels in view (canopy ≥ 3 m, NDVI ≥ 0.4), signed so that positive means needle-leaved, and the
scores are averaged by weight. Otsu places the split, and Sarle's bimodality coefficient (above ~0.555) says whether there
are really two groups. The point-cloud terms (laser intensity, canopy attenuation) are not available from HRDEM rasters,
so the terms are Sentinel-2's: − NIR 0.35 · − visible brightness 0.20 · − excess green 0.15, plus − ΔNDVI 0.35 and
+ leaf-off NDVI 0.20 with a leaf-off scene. Calibrate in each area. Four variants: one or two scenes, raw or sharpened.

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
