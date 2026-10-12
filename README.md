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
| Objects | RGB + LiDAR objects, Sentinel-2 at native support | **Object-based image analysis of a study area** (below and [docs/OBIA.md](docs/OBIA.md)). |
| Fusion | Both of the above, per pixel | **Rule-based classes** from a rule set you edit (below), the **structure · greenness · water** composite (CHM · NDVI · NDWI as RGB), and a **custom fusion RGB** of any variable. An optional **leaf-off scene** adds leaf-off indices and bands and the seasonal change (Δ NDVI, Δ EVI, Δ NIR…). "Find inputs for the study area" picks the newest LiDAR project with a DSM, the clearest leaf-on scene (June–September) and the clearest leaf-off one (late April–mid May, or November) of the last three years. |

The approach follows [taylor-geospatial/s2-stac-geoparquet](https://github.com/taylor-geospatial/s2-stac-geoparquet):
a static index on object storage, a pure-JS parquet reader instead of DuckDB-WASM, `cache: "no-store"`
range reads, and client-side COG warping through a proj4 control grid.

## Objects tab: object-based image analysis

A six-step workflow — **Study area → Sources → Objects → Training → Classification → Review & export** — on one map:

- Fine objects are segmented on a metric UTM grid from **RGB (CIE L\*a\*b\*) and the canopy height model** only.
  Sentinel-2 never takes part in segmentation.
- **Sentinel-2 is read at native resolution** (10 m and 20 m, never resampled) and summarized per object by the area of
  each native pixel the object covers, with its valid fraction, native-pixel count and an effective count. Objects
  smaller than a pixel, or mostly made of other cover, are flagged as coarse/mixed.
- Classes form a tree: structure first (forest, shrub, low vegetation, water, built), then **composition** within it —
  coniferous / broadleaf / mixed forest and shrub; graminoid, ericaceous, moss, lichen and seedlings in the ground layer —
  with a separate model per level. A second Sentinel-2 date (leaf-off or autumn), red edge, crown shape from the CHM,
  photo colour composition and an object-level conifer score supply the evidence; what separates well and what does
  not is set out in [docs/OBIA.md](docs/OBIA.md#4a-vegetation-composition-level-2).
- **LiDAR returns** from the CanElevation point cloud — first-return intensity (a 1064 nm NIR band: broadleaf crowns
  bright, conifers dark), vegetation-intensity spread, penetration, canopy attenuation and ground-layer intensity —
  summarized per object at their own 2 m cell support, like Sentinel. Intensity is uncalibrated; mixed acquisitions
  are flagged.
- Labels by tapping objects or by importing reference polygons (≥ 80 % coverage by one class) and points; training and
  held-out validation roles; undo/redo.
- A seeded **Random Forest** with **spatial cross-validation** (blocks, with a buffer against shared Sentinel pixels),
  the RGB + LiDAR vs + Sentinel comparison on identical folds, and metrics suppressed where the labels cannot support
  them. Scores are vote shares, not probabilities.
- Exports: reloadable project bundle, object GeoJSON, class-dissolved GeoJSON, feature CSV, model JSON, segment-ID and
  class GeoTIFFs. Every stage is saved in the browser and resumes after a reload.
- Over-budget areas are refused before reading, never silently coarsened. A synthetic test fixture runs the whole
  workflow offline.

Results are **candidate mapped units**, not regulatory wetland boundaries or confirmed communities. What is and is
not built, the conventions, tests and measured limits: [docs/OBIA.md](docs/OBIA.md).

## Study areas, analyses and results

The Fusion tab is laid out as FieldMapper's HabLab tools are: two pages, **Set up** and **Results**, and Set up in four
numbered steps.

1. **Study area**: *This view* (the map view when Run is pressed), a *Saved area*, or *Draw* a polygon or rectangle on
   the map and name it. Areas are kept in this browser, can be renamed, zoomed to, deleted, and imported or exported as
   GeoJSON. Every analysis reads the area's bounding box and is then **masked to its outline**: an object cut by the
   outline keeps only its inside part, a cell less than half inside is left out, and nothing outside counts towards a
   class area. The conifer index is calibrated on the area's woody pixels, and "Find inputs" searches the area.
2. **Inputs**: LiDAR, leaf-on and leaf-off scenes, orthophoto and point cloud.
3. **Classes**: strata × cover or rules (or a composite), with the on-screen pixel preview, the conifer index and
   sample comparison.
4. **Analysis**: one tool at a time from a segmented bar, with its parameters and one Run button naming the area it
   runs on. A tool that cannot run says why (Class areas needs classes). Progress and outcomes go to a folded **run log**.
   - **Class areas**: the classes at every pixel of the area (2 m where the area allows, up to ~120 km² at 10 m), with
     hectares and share per class, and the unclassified remainder.
   - **Objects**: patches or tree crowns (below).
   - **Feature table**: one row per Sentinel-2 pixel (below).

A run that produces something switches to **Results**. Results accumulate: every run is a card and a map layer of its
own (newest on top, its area outlined), so two areas, or one area under two rule sets, sit side by side. A card states
what the run was made from (area, classes, input dates, time) and its class table, and offers show/hide, opacity, zoom,
downloads (class-areas CSV, objects GeoJSON, GeoParquet or CSV), **Run again**, **Save area** for a run made on the view,
and **Discard**. When the classes or inputs change after a run, its card says so and offers to run it again on the same
area. Tapping the map inspects the topmost visible result. Results live in the tab's memory: a card is marked until it
is downloaded, and leaving the page with any not downloaded asks first. *Class areas of every run* writes one CSV of
all of them for comparison.

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
z-score over the woody pixels of the study area (canopy ≥ 3 m, NDVI ≥ 0.4), signed so that positive means needle-leaved, and the
scores are averaged by weight. Otsu places the split, and Sarle's bimodality coefficient (above ~0.555) says whether there
are really two groups. The point-cloud terms (laser intensity, canopy attenuation) are not available from HRDEM rasters,
so the raster-only variants use Sentinel-2's: − NIR 0.35 · − visible brightness 0.20 · − excess green 0.15, plus − ΔNDVI 0.35 and
+ leaf-off NDVI 0.20 with a leaf-off scene. Calibrate in each area. Four variants: one or two scenes, raw or sharpened. Two more put FieldMapper's own six terms
back, from the point cloud and the orthophoto (next section).

## Point-cloud evidence, orthophoto and the candidate-cover "4th band" (proof of concept)

The Fusion tab can also read two sources that HRDEM rasters and 10 m Sentinel-2 cannot supply:

- **The point cloud itself.** `src/pointcloud/` reads the CanElevation COPC tiles the index lists, in a Web Worker
  (copc.js + laz-perf, ported from FieldMapper's `copcSource`). It reads only the hierarchy pages and octree nodes that
  meet the ground in view, and only to the depth the cell size needs. It then computes FieldMapper's first-return
  metrics per cell: **vegetation intensity** (the laser is near-infrared, 1064 nm), **ground intensity**, **first-return
  intensity**, **penetration** (share of pulses reaching the ground), **canopy attenuation** (Beer–Lambert over the
  canopy) and **first-return density**. Heights are above a ground surface built from the class 2 and 9 returns. The
  metrics are computed per 128 × 128-cell chunk on the tiles' own UTM grid. Cells are 2, 4, 8 or 16 m, chosen by zoom;
  nothing is read zoomed out past level ~13. Intensity is uncalibrated, so compare it within one acquisition.
- **An orthophoto** (`src/xyz.ts`): colour tiles sampled in the browser. The provincial **NSODB** (1:10 000, or 1:2 000
  urban) is the default, and its photo year is read from the service's `Photo_Date` layer and stated beside the product.
  **Esri World Imagery** is the alternative. Neither carries NIR. Derived planes: brightness, excess green and crown
  **texture** (brightness s.d. over ±5 m, meaningful from zoom ~16).

What they add:

- Variables in the rule and strata editors, under **LiDAR point cloud** and **Orthophoto (RGB)**.
- The **six-term conifer index** (`ci6`, `ci6b` with leaf-off), FieldMapper's own terms and weights: − vegetation
  intensity 0.35 · − ortho brightness 0.20 · − ortho excess green 0.15 · + canopy attenuation 0.15 · + ortho texture 0.15
  · − Sentinel-2 NIR 0.30.
- The rule preset **Candidate cover — LiDAR intensity + orthophoto + Sentinel**: water (including laser dropout), built
  structures (tall, not green in the photo, and no pulse reaching the ground), coniferous / mixed / deciduous from `ci6`,
  herbaceous, low ground cover, and bare or impervious (grey in the photo even where 10 m NDVI is mixed with roadside
  trees).
- **Show as → Tint over the orthophoto**: any class product (rules or strata) drawn as a tint on the photo, with the
  shares in the legend. This is the "4th band" on the RGB.
- **Pseudo colour-infrared** (LiDAR intensity · ortho red · ortho green) and **point-cloud evidence** (vegetation
  intensity · penetration · attenuation) composites.

Costs and limits: a first draw at zoom 16 reads ~25 M returns (~270 MB of COPC) and takes 15–25 s, and calibrating the
index takes ~10 s. The LiDAR (2018–2019 here), the orthophoto (2017 here) and the Sentinel scenes are different years.
Orthophoto pixels are computed in the viewer's browser from the tiles the service serves to it, and nothing is stored or
redistributed. Whether NSODB permits derived products beyond that has not been confirmed; the downloadable files are
sold under a restricted licence. This is a proof of concept, not a production map.

## Objects (object-based classification)

The **Objects** analysis classifies **objects** instead of pixels (`src/segment/`):

1. Every input is sampled over the study area on one grid, masked to its outline. The grid is linear in Web Mercator, so
   the result lies exactly on the map, and its pixels are 2 m (coarser past ~1.2 M pixels; refused past 8 m, about 77 km²).
2. **Superpixels** (SLIC) are drawn on canopy height and, when an orthophoto is chosen, its brightness and excess green,
   after a 3 × 3 smoothing. The coarse imagery is deliberately left out, so it does not draw 10 m squares.
3. Neighbouring superpixels are **merged** by Felzenszwalb–Huttenlocher's criterion: uniform ground joins into larger
   patches and edges stay edges. The superpixel size, merge tolerance and compactness are sliders.
4. Each object carries the **mean of every input** over its pixels (the majority for Sentinel scene classes), plus
   measures that exist only for a region: area, compactness, canopy-height 90th percentile and spread, and photo
   texture. These are offered as variables under *Objects (segmentation only)*; on the pixel map they have no value.
5. The object is classified by the **same rules or strata** the pixel map uses, evaluated once per object. An index is
   computed from the object's mean reflectance and a stratum from its mean canopy height.

**Tree crowns** (Objects → Tree crowns, 1 m pixels, an area under ~2.7 km²) replace the patches with individual crowns: treetops are
local maxima of the smoothed canopy height model within a window that widens with height, and crowns grow from them
downhill, tallest first, while a pixel stays above the minimum tree height, above 0.45 × its treetop and within a
height-dependent radius (Dalponte & Coomes 2016, as in lidR). What no crown reaches is left out. This finds dominant and
co-dominant crowns, not understorey the top surface cannot see.

**Object height** can be the object's mean canopy height or its **90th percentile**. The P90 is read by the strata and by
every height rule, so a stand with gaps is classed by its canopy, not by the average of canopy and gaps.

Tap an object for its values. **Download GeoJSON** writes every object as a polygon traced along the pixel edges, with its
class and every variable that can be evaluated on it as attributes (about 55 with all sources on). On a 1.8 × 1.5 km view
at zoom 16 this is ~3,000 objects in ~17 s, most of it reading the inputs. It is a proof of concept: objects are
classified when segmented; after editing rules the result's card says so and offers **Run again**.

## Feature table (grid export)

The **Feature table** analysis produces one row per cell of **Sentinel-2's own pixel lattice** (10 or 20 m, in the scene's UTM
CRS, aligned to its COG origin), so the imagery is never resampled; each cell is a Sentinel pixel. Every finer input (1 m
LiDAR, point-cloud metrics, orthophoto) is sampled at 2 m and averaged into the cell. Each row also carries:

- canopy-height P90 and spread, and photo texture;
- the share of the cell in each class of the selected rules or strata;
- `cell_id` (`epsg:size:col:row`), the centre in UTM and lon/lat, and coverage;
- H3 ids at resolution 13 (~44 m², the cell centre) and 11 (~2 150 m², for roll-ups and joins).

Any column can be previewed on the map, and a cell can be tapped. The download is **GeoParquet 1.1** (cell polygons in
lon/lat as WKB; opens in DuckDB, QGIS, GDAL, pandas/GeoPandas) or CSV. A 1.5 × 1.2 km view at zoom 16 gives ~6,700 cells ×
67 columns in ~16 s (2 MB of GeoParquet). Cells less than half inside the study area are left out. h3-js and the parquet
writer load only when the table is built or written.

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
