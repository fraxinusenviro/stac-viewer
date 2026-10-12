# Object-based image analysis (the Objects tab)

Implementation record for *Claude Code implementation specification: multiresolution LiDAR and imagery
OBIA*, v1.0 (12 October 2026). This documents **Milestone A, the bounded browser vertical slice**. It is not the
whole specification; §9 lists what is not built.

## 1. What it does

One persistent map and a six-step panel:

**Study area → Sources → Objects → Training → Classification → Review & export**

| Step | Implemented |
|---|---|
| Study area | Draw a polygon or rectangle, import GeoJSON, use the view, or pick a saved area (shared with the Fusion tab). Area shown. Preset (§11), boundary cell (0.5 / 1 / 2 m), processing buffer, analysis CRS (WGS 84 UTM or NAD83(CSRS) UTM), and a memory estimate against the device budget. |
| Sources | **RGB**: a local GeoTIFF, a COG URL, or the provincial NSODB tiles after the user records that the terms were checked; Esri World Imagery is reference-only. **LiDAR**: NRCan HRDEM DSM/DTM through the STAC adapter (CHM = DSM − DTM), ranked by each project's *true* coverage (`extent` asset), or a local CHM GeoTIFF. **Sentinel-2**: Earth Search L2A, date window and cloud limit. Every asset is range-probed before use; footprints, dates, native resolution, CRS, vertical datum, access status and the Sentinel/LiDAR date gap are shown. RGB + LiDAR alone is a complete workflow; LiDAR alone works too (structure-only boundaries). |
| Objects | Target object area, compactness, imagery / structure / terrain influence, merge similarity, minimum patch area, distinctness threshold. *Preview a window* (256 × 256 at the real cell size, same algorithm, objects cut by the window edge counted) and *Run on the whole area*. Layers: RGB, CHM, objects, quality mask, footprints, Sentinel native grid. |
| Training | Class schema (labels, colours, descriptions, one level of hierarchy; JSON import/export). Tap to label, Shift-tap to multi-select; undo/redo; training vs held-out validation roles; reference polygon/point import with an 80 % coverage rule (configurable) and a review list. |
| Classification | Predictor groups, spatial block size, folds, trees. Spatial cross-validation, the RGB + LiDAR vs + Sentinel ablation on identical folds, held-out validation, predictor importance, and the most uncertain unlabelled objects. |
| Review & export | Colour by prediction, condition or labels. Tap an object: support per source, every feature value, prediction, vote shares, training status, conditions; correct it (a *review* entry, not training data, until included). Exports below. Storage use and persistence are shown. |

Every stage is checkpointed to IndexedDB; a reload resumes from the last completed stage. Jobs run in a Web
Worker with progress and **Cancel**; the map stays usable throughout.

## 2. The invariants and where they are enforced

| Spec invariant | Where |
|---|---|
| 1. Sentinel never segments | `obia/segment.ts` takes RGB, CHM and DTM planes only; `obia/pipeline.ts` calls it before looking at Sentinel. Test: *ACCEPTANCE 2* (`test/obiaCore.test.ts`) changes every Sentinel value ×3, and removes Sentinel entirely: labels identical. |
| 2. Fine boundaries from RGB and LiDAR | `segmentationChannels`: L\*a\*b\* (converted from the three colour channels only), CHM, optional slope. |
| 3. Native support kept | `obia/sentinel.ts` reads each band at overview level 0 on its own grid (`engine.readNative`, refused rather than shrunk past 4 M pixels); `FeatureDefinition.effectiveSupportM` 10 or 20 m, `sampling: native-area-weighted`; survives export and reload (*ACCEPTANCE 1/4*). |
| 4. No upsampling described as measurement | No Sentinel plane exists on the fine grid in this tab. The Fusion tab's "sharpened" variables are not used here. |
| 5. No fake fine NIR/SWIR/NDVI | NDVI from B04/B08 at 10 m and NDMI from B8A/B11 at 20 m, each computed per native pixel and area-averaged (mean of the pixel index; recorded in the feature definition). |
| 6. Sub-pixel objects flagged | `coarse-subpixel` (object smaller than a native pixel), `coarse-mixed` (the pixels it touches are mostly not the object), `coarse-no-valid`. |
| 7. Unknowns explicit | Unprobed or unreadable assets are `unavailable` with the reason; a tile service's native resolution is "unknown"; a scene with no baseline/offset is called out; a 16-bit RGB is refused rather than rescaled; no data read inside the area is an error, not an empty result. |
| 8. Candidate units only | Stated in the tab header, the classification step and every export manifest. |

## 3. Conventions

- **Analysis grid** (`obia/grid.ts`): north-up, metric UTM; transform in GDAL GeoTransform order
  `[originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]`, top-left pixel **corner**, PixelIsArea;
  origin snapped to a whole multiple of the cell size. lon/lat ⇄ grid through proj4; NAD83(CSRS) on a null datum shift
  as everywhere in this viewer (~1.4 m from ITRF in Nova Scotia). Areas are planar areas in the projected CRS (within
  0.1 % of ellipsoidal).
- **Fine inputs** are sampled onto the grid by **nearest neighbour** from the source's own grid (`engine.sampleGrid`):
  categorical-safe, no interpolation. CHM = DSM − DTM per cell; small negatives are clamped to 0.
- **Normalization** (`recipe.REFERENCE_SCALES`): fixed reference differences — L\* 8, a\*/b\* 6, CHM 2 m, slope 5° —
  rather than per-tile statistics, so a preview window and the whole area are normalized identically. A group's
  channels are multiplied by influence / √(channels in the group). SLIC distance
  `D² = Σ(Δc)² + compactness² (Δxy / S)²`, `S = √(target area) / cell`. Deterministic: lattice seeds, fixed iterations,
  no randomness.
- **Merging**: Felzenszwalb–Huttenlocher on the region adjacency graph (tolerance `mergeSimilarity × S²`), then the
  minimum-patch pass: a small object joins its most similar neighbour only if within `keepDistinctAbove` reference
  differences; otherwise it is kept and flagged `below-min-patch`.
- **The integer label raster is authoritative.** Polygons are traced from it on export along pixel edges, never
  simplified.
- **Sentinel intersection areas** are measured on the analysis grid. With the default WGS 84 UTM grid at 0.5 / 1 / 2 m
  against 10 / 20 m pixels they are **exact**; in NAD83(CSRS) UTM they are exact to within the fine pixels cut by a
  native edge, and the run says `approximate (fine-grid)`.
- **Effective count** `(Σa)² / Σa²` describes weight concentration only; it is not a count of independent observations.
- **Masking**: SCL classes 0, 1, 3, 8, 9, 10, 11 invalid, cloud/shadow/cirrus dilated by one SCL pixel; missing is
  NaN/null, never 0. A single date only (seasonal composites are Milestone B).

## 4. Training and validation

- Original references are stored as imported (`ObiaProject.references`), apart from object labels.
- Polygons label an object when one class covers ≥ 80 % of it and no two classes overlap in it; otherwise *review*.
  Points label only with the stated assumption that a point represents its object.
- A re-segmentation carries manual labels to the new objects **by location and holds them as pending**, excluded from
  training until confirmed; reference labels are re-applied from the originals.
- Random Forest (`obia/rf.ts`): CART on Gini, bootstrap, √p features per split, seeded (mulberry32), 100 trees,
  depth 16. Written here rather than added as a dependency: FieldMapper's trainer has no licence for this Apache-2.0
  repository, and a small learner is easier to verify than to vet. Missing values: medians fitted on the training rows
  of each fold and stored with the model.
- **Folds**: square spatial blocks (default 100 m) dealt to k folds deterministically. Coarse support is handled by a
  **buffer**: in each fold, training objects sharing a native Sentinel pixel (of the coarsest raster) with a test
  object are dropped from that fold's training set, and the count is reported. (Unioning blocks through shared pixels
  instead chained every contiguous labelled patch into one or two groups.) *ACCEPTANCE 10* checks that no training
  object of any fold shares a pixel with its test set.
- **Reporting**: per-class precision/recall/F1, confusion matrix, macro-F1, accuracy by object and by area. A class with
  fewer than 5 objects or labelled in one spatial group gets no metrics; macro-F1 needs two eligible classes; nothing is
  reported from fewer than two folds. Held-out validation labels are never trained on or offered as uncertain objects.
- Scores are vote shares, labelled "not calibrated probabilities" wherever they appear.

## 5. Exports

| Export | Format | CRS |
|---|---|---|
| Project bundle (reloadable) | JSON: recipe, recipe hash, sources, grid, run-length-coded label raster, objects, feature definitions, classes, labels, references, model, evaluation, manifest | analysis CRS, stated in full |
| Objects | GeoJSON polygons with class, scores, support, flags, every feature | EPSG:4326 (RFC 7946), 7 d.p. |
| Dissolved by class | GeoJSON, a separate derived layer | EPSG:4326 |
| Feature table | CSV, one row per object (centroid in the analysis CRS) | analysis CRS |
| Model + preprocessing | JSON: forest, imputer medians, classes, feature definitions, evaluation | — |
| Segment IDs, classes | GeoTIFF (Int32 / UInt8, uncompressed, PixelIsArea, EPSG key). **Not** Cloud-Optimized. | analysis CRS |

GeoPackage and COG output are not implemented (no verified writer in the repository).

## 6. Measured (headless Chromium 141, Linux container, live NRCan + Earth Search, 12 Oct 2026)

| Area | Cells (1 m) | Objects | Fine reads | Sentinel reads (7 bands) | Segment | Features | Sentinel stats | Total |
|---|---|---|---|---|---|---|---|---|
| 8.85 ha | 341 × 340 | 869 | 0.7 s | 4.4 s | 0.2 s | 0.1 s | 0.1 s | 5.5 s |
| 61.1 ha | 847 × 810 | 4,964 | 6.2 s | 4.3 s | 0.7 s | 0.2 s | 0.2 s | 11.7 s |

CHM-only boundaries (no lawful RGB source was available for a live run). Training 36–200 objects and predicting
all objects: 0.1–0.3 s. Memory is **estimated** before each run (86 MiB for the 61 ha run against a 1 GiB budget);
it was not measured — the browser does not expose it without cross-origin isolation. These are one device's
numbers, not guarantees for any other. The budget refusal was verified (a 10 km² view at 0.5 m, ~59 GiB estimated,
refused before reading).

## 7. Test fixture

`src/obia/fixture.ts` — **SYNTHETIC, not real data**: 240 × 160 m at 1 m with alternating forest and meadow stands,
six ponds below the minimum patch area, a NoData corner, aligned 10 m and 20 m Sentinel rasters with a cloudy SCL
pixel, and reference polygons. Used by the unit tests and by *Load the test fixture* in the Study area step. Its
perfect scores are a property of a separable synthetic scene.

## 8. Tests (`npm test`)

`test/obiaCore` (grid, recipe hash, Lab, segmentation, minimum patch, weighted sampling with full/partial/sub-pixel/
missing pixels, indices, SCL masking, CHM band denominators, Sentinel independence, determinism) · `obiaModel`
(forest, imputer, folds, leakage, CV report and suppression, ablation, labels undo/redo, reference coverage rule,
classification with held-out validation) · `obiaSources` (STAC conformance, pagination, relative links, GET/POST
fallback, range probe) · `obiaExport` (GeoTIFF read-back, RLE, bundle round trip, polygon areas vs object areas,
Sentinel support after reload) · `obiaBudget`.

Acceptance criteria covered by tests: 1, 2, 3, 4, 5, 6, 9 (reload; split/merge is not built), 10, 11, 12 (partly:
inaccessible URLs, servers ignoring ranges, authentication refusals, zero valid observations; the refusal of a
non-8-bit RGB and of an unknown CRS is code-reviewed, not tested), 14 (GeoTIFFs read back with geotiff.js
only — no GDAL here). Verified in the browser: 13 (cancel, progress, responsive map, refusal before allocation,
reload recovery) and 15 (§6). Not applicable yet: 7 (no tiling: the bounded domain is enforced), 8 (no point-cloud
metrics in this tab).

## 9. Not built (Milestones B and C)

- Point-cloud (COPC) metrics in this tab. The Fusion tab's point-cloud reader reads octree levels to the depth a cell
  size needs — a spatially thinned sample — so it is not used analytically here.
- Seasonal Sentinel composites (several dates, medians, observation counts); parent / neighbourhood context.
- Split / merge editing with lineage; a reviewed correction can be included in training explicitly, but geometry is
  not editable.
- Large-area tiling: the area is one bounded domain, refused over the measured budget.
- GeoPackage and COG writers; STAC publishing; the backend job adapter (`AnalysisJobAdapter`) — no backend exists in
  this repository.
- Hydrological features; terrain is limited to mean elevation and slope.
- Swipe inspection between sources; a mosaic seam / date-boundary map for orthophotos.
- Calibrated probabilities; crown segmentation in this tab (the Fusion tab has a crown tool).

## 10. Run

```bash
npm install
npm run dev        # then the "Objects" tab
npm test           # all suites, Node ≥ 22.18
```

Live integrations: NRCan datacube STAC (HRDEM), Element 84 Earth Search (Sentinel-2) — both verified 12 Oct 2026, both
anonymous. Local imports: GeoTIFF RGB (8-bit) and CHM. Fixture: synthetic.
