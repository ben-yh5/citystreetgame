# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
City Street Game — a browser-based geography game where players test their knowledge of city streets. Three game modes: Name Streets, Find Intersections, Navigate Route (cuesheet).

## Commands

### Frontend (Vite + vanilla JS)
- `npm run dev` — start Vite dev server
- `npm run build` — production build to `dist/`
- No test framework is configured.

The app is fully static — no backend process needs to be running for any game mode.

## Architecture

### Frontend — fully client-side
- Vite + vanilla JS, Mapbox GL JS (CDN), no npm runtime dependencies
- All street data, geometry, and graph/routing logic run in the browser
- Street data comes from a live Overpass API call (`fetchStreetsFromOSM()` in `src/api/osm.js`), with Seattle backed by a monthly-refreshed static cache (see below)
- A `backend/` FastAPI service (OSMnx + NetworkX) exists in the repo from an earlier architecture but is **not currently wired up** — `src/api/backend.js` (its client wrapper) is not imported anywhere in `src/`. Treat it as unused/legacy unless someone reconnects it.

### Frontend Structure
- `index.js` — event listeners, app initialization
- `src/state.js` — single mutable `state` object used everywhere (global state pattern)
- `src/cache.js` — localStorage save/load
- `src/api/osm.js` — Overpass API + Nominatim city search; populates `state.streetData` / `state.streetSegmentsData`
- `src/api/backend.js` — client wrapper for the unused `backend/` FastAPI service (dead code, not imported)
- `src/map/mapbox.js` — map setup, layers, tooltips
- `src/utils/string.js` — `normalizeStreetName()` strips directionals and road suffixes for fuzzy matching
- `src/game/core.js` — shared logic: mode switching, city loading, undo/redo, cache restore
- `src/game/streets.js` — "Name Streets" mode
- `src/game/graph.js` — client-side street graph, Dijkstra shortest path, bearing/turn classification (used by cuesheet mode)
- `src/game/intersectionMode.js` + `src/game/intersections.js` — "Find Intersections" mode: geometric line-segment intersection detection against `state.streetData`
- `src/game/cuesheet.js` — "Navigate Route" mode, built on `graph.js`
- `src/game/ui.js` — UI updates: mode switching, stats display, loading state

### Backend Structure (unused — see above)
- `backend/main.py` — FastAPI app, endpoints, in-memory state (`city_graphs`, `route_states`)
- `backend/cuesheet.py` — challenge generation, cue validation, Dijkstra routing, street following
- `backend/geo.py` — bearing calculations, turn classification (`L/R/S/U`), street name normalization
- `backend/models.py` — Pydantic request/response models
- Kept in the repo in case the client-side approach needs to be replaced; not deployed, not started by any dev command, not called by the frontend

### Key Patterns
- **Street name matching**: two-tier — exact case-insensitive first, then normalized (`normalizeStreetName()` in `src/utils/string.js`)
- **Circular dependency avoidance**: `streets.js` uses `setSaveState()` callback pattern from `core.js`
- **Cuesheet rendering**: confirmed edges = solid green line, unconfirmed (continuation) = dashed green line

### Find Intersections Mode
- `generateRandomIntersection()` (`src/game/intersections.js`) picks a candidate street (filtered by difficulty from `state.streetData`), then checks other streets' line geometry for segment-pair proximity (≤5m) via `getClosestPointsBetweenSegments`
- Street classification at a specific location comes from `state.streetSegmentsData`, not the overall street type
- Pure geometry, no graph structure

### Navigate Route (Cuesheet) Mode
- `buildStreetGraph()` (`src/game/graph.js`) builds a node/edge graph client-side from `state.streetSegmentsData`
- `findShortestPath()` runs Dijkstra in the browser; `calculateBearing()`/`classifyTurn()` compute turn directions (`L/R/S/U`)
- Player submits cues: direction + street name → validated against the client-side graph

### Seattle OSM Data Cache
- `public/data/osm/seattle-ways.json` is a static snapshot of the Overpass response for Seattle's street ways, clipped to Seattle's city-limit bbox (+ small buffer)
- Refreshed monthly by `.github/workflows/fetch-seattle-osm.yml`, which runs `scripts/fetch-seattle-osm.mjs`
- The city boundary is still fetched live from Nominatim on every city selection (cheap, not the reliability bottleneck) and used to filter the cached ways via point-in-polygon, same as the live-Overpass path
- `fetchStreetsFromOSM(boundaries, cityMeta)` uses the cache when `cityMeta.osmId`/`osmType` match Seattle's known OSM relation (`237385`, see `FALLBACK_SEATTLE` in `osm.js`), set on `state.selectedCityOsmId`/`selectedCityOsmType` when a city is confirmed in `core.js`; falls back to a live Overpass fetch on any load failure or when a different city is selected
- OSM-ID matching was chosen over bbox comparison because Seattle's official boundary is a MultiPolygon with two similarly-sized parts — `getLargestPolygon()`'s area tie-break isn't stable across independent Nominatim requests, so bbox equality between a live fetch and the cache is unreliable
- **Note:** the fetch script's Overpass query is deliberately broader than what this app itself needs (no `name` requirement, includes `living_street`/`service`), because `seattle-ways.json` is also published via GitHub Pages as a shared raw-data source for other projects. This app's own `processOSMData()` already discards unnamed ways, so the extra breadth is harmless here — but don't narrow the query back down without checking what else reads this file.

## Deployment
- GitHub Pages with base path `/citystreetgame/` (see `vite.config.js`)
- Mapbox GL JS v2.15.0 loaded from CDN in `index.html`
- Fully static site; no backend to deploy
