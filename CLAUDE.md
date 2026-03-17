# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
City Street Game — a browser-based geography game where players test their knowledge of city streets. Three game modes: Name Streets, Find Intersections, Navigate Route (cuesheet).

## Commands

### Frontend (Vite + vanilla JS)
- `npm run dev` — start Vite dev server (proxies `/api` to backend)
- `npm run build` — production build to `dist/`
- No test framework is configured.

### Backend (FastAPI + OSMnx)
- `pip install -r backend/requirements.txt` — install Python dependencies
- `python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000` — start backend
- Both frontend and backend must be running for cuesheet and intersection modes.

## Architecture

### Frontend ↔ Backend
- Frontend: Vite + vanilla JS, Mapbox GL JS (CDN), no npm runtime dependencies
- Backend: FastAPI with OSMnx (street data from OSM) + NetworkX (graph operations)
- Vite dev server proxies `/api/*` → `http://localhost:8000` (see `vite.config.js`)
- All graph/routing logic runs on backend; frontend handles UI/rendering only
- API client: `src/api/backend.js` wraps all backend calls

### Frontend Structure
- `index.js` — event listeners, app initialization
- `src/state.js` — single mutable `state` object used everywhere (global state pattern)
- `src/cache.js` — localStorage save/load
- `src/api/osm.js` — Overpass API + Nominatim city search
- `src/api/backend.js` — all backend API calls
- `src/map/mapbox.js` — map setup, layers, tooltips
- `src/utils/string.js` — `normalizeStreetName()` strips directionals and road suffixes for fuzzy matching
- `src/game/core.js` — shared logic: mode switching, city loading, undo/redo, cache restore
- `src/game/streets.js` — "Name Streets" mode
- `src/game/intersectionMode.js` — "Find Intersections" mode
- `src/game/cuesheet.js` — "Navigate Route" mode
- `src/game/ui.js` — UI updates: mode switching, stats display, loading state

### Backend Structure
- `backend/main.py` — FastAPI app, endpoints, in-memory state (`city_graphs`, `route_states`)
- `backend/cuesheet.py` — challenge generation, cue validation, Dijkstra routing, street following
- `backend/geo.py` — bearing calculations, turn classification (`L/R/S/U`), street name normalization
- `backend/models.py` — Pydantic request/response models

### Key Patterns
- **City ID**: SHA256 hash of boundary GeoJSON (stable across sessions)
- **Route state**: lives on backend keyed by `route_id` (UUID); frontend stores only coordinate arrays for rendering
- **Street name matching**: two-tier — exact case-insensitive first, then normalized (both frontend `normalizeStreetName()` and backend `match_street_name()`)
- **Cache restore**: calls `backendLoadCity()` to re-load graph since backend state is ephemeral
- **Circular dependency avoidance**: `streets.js` uses `setSaveState()` callback pattern from `core.js`
- **Cuesheet rendering**: confirmed edges = solid green line, unconfirmed (continuation) = dashed green line; `confirmed_edge_count` marks the boundary

### Cuesheet Mode
- Backend picks start/end nodes, initializes route by auto-following the starting street
- Player submits cues: direction (`L/S/R`) + street name → backend validates against graph
- `_follow_street_forward()` continues along a street until a decision point (another named street branches off)
- `_find_turn_street_ahead()` searches forward along current street for a target intersection
- Name-change passthrough: implicit `S` cues auto-inserted when road continues straight under a different name
- Hint uses Dijkstra shortest path to suggest next optimal turn
- Custom routes: user clicks map to pick start/end nodes

## Deployment
- GitHub Pages with base path `/citystreetgame/` (see `vite.config.js`)
- Mapbox GL JS v2.15.0 loaded from CDN in `index.html`
- Backend not deployed (local only); frontend-only features (Name Streets) work without it
