# CLAUDE.md

## Project Overview
City Street Game — a browser-based geography game where players test their knowledge of city streets. Built with Vite + vanilla JS, Mapbox GL JS for map rendering, and OpenStreetMap/Overpass API for street data.

## Commands
- `npm run dev` — start Vite dev server
- `npm run build` — production build to `dist/`
- `npm run preview` — preview production build
- No test framework is configured.

## Architecture

### File Structure
```
index.html          Entry point HTML
index.js            Event listeners, app initialization
index.css           All styles
src/
  state.js          Global mutable state object (single export)
  cache.js          localStorage save/load (saveGameState, loadGameState)
  api/osm.js        Overpass API + Nominatim city search
  map/mapbox.js     Mapbox GL map setup, layers, tooltips
  utils/geo.js      Distance calculations, geometry helpers
  utils/string.js   Street name normalization
  game/
    core.js         Shared logic: mode switching, city loading, undo/redo, restore
    streets.js      "Name Streets" mode: input handling, matching, autofill
    intersectionMode.js  "Find Intersections" mode: map click, guess, scoring
    intersections.js     Intersection generation utilities (finding street crossings)
    cuesheet.js     "Navigate Route" mode: challenge generation, cue validation, hints
    graph.js        Street graph construction from OSM data + Dijkstra pathfinding
    ui.js           UI updates: mode switching, stats display, loading state
```

### Key Patterns
- **Global state**: `src/state.js` exports a single mutable `state` object used everywhere
- **Street data**: `state.streetSegmentsData` is a `Map<streetName, [{coordinates, type, highway, length, oneway}]>`
- **Game modes**: Switched via `switchGameMode()` in core.js, which calls `updateModeUI()` and mode-specific init
- **Circular dependency avoidance**: `streets.js` uses `setSaveState()` pattern to receive `saveState` callback from core.js
- **No frameworks/libraries**: Pure vanilla JS with ES modules, only external dependency is Mapbox GL JS (loaded via CDN)

### Street Graph (graph.js)
- Nodes = OSM coordinates shared by 2+ different street names (intersection points)
- Nearby nodes within 15m are merged into super-nodes (handles roundabouts), but nodes sharing a street name are never merged (prevents parallel road issues like viaducts)
- Edges store: target node, street name, distance, exit/entry bearings, full coordinate path
- One-way roads enforced: reverse edges skipped for `oneway` segments (OSM `oneway=yes/1/-1`, implicit for motorways)
- Graph is built lazily on first cuesheet mode entry, invalidated when city changes
- Dijkstra pathfinding for shortest path between any two nodes

### Cuesheet Mode (cuesheet.js)
- Picks two random graph nodes as start/end, verifies Dijkstra path exists
- Player builds turn-by-turn directions: direction (L/S/R) + street name
- Validation replays cues on the graph using BFS-style street following
- Results show player route (green/red) + optimal Dijkstra route (cyan dashed)
- `pickEdgeByDirection()` uses bearing-based turn classification with Dijkstra tiebreaker
- **Street name autocomplete**: dropdown of all city streets (substring match, capped at 8). Enter tries typed name first, falls back to first suggestion. Cues store the actual graph edge street name.
- **Name-change passthrough**: when a road continues straight under a different name (e.g., bridge), `findNameChangeEdge()` detects it (requires exactly one straight-ahead edge with a different name). Implicit "S" cues are auto-inserted in the cue list for each name transition.
- **Direction shortcuts**: typing `:l`, `:r`, `:s` (or `l:`, `r:`, `s:`) anywhere in the input selects that direction

## Deployment
- Deployed to GitHub Pages with base path `/citystreetgame/` (see vite.config.js)
- Mapbox GL JS v2.15.0 loaded from CDN in index.html
