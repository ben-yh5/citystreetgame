# Refactoring Plan: OSMnx + NetworkX Backend

## Overview

Replace raw Overpass API + custom JS graph with a Python FastAPI backend using OSMnx for street data fetching and NetworkX for graph operations/routing. The backend handles data loading, graph construction, pathfinding, and all cuesheet game logic. The frontend keeps map rendering, UI interactions, and the streets/intersections game modes (which only need the street data, not the graph).

---

## Phase 1: Python Backend Setup

### 1. Create `backend/` directory structure

```
backend/
  requirements.txt     # osmnx, networkx, fastapi, uvicorn, shapely, pydantic
  main.py              # FastAPI app, CORS, all endpoints
  graph_service.py     # OSMnx city loading, street data extraction
  cuesheet_service.py  # Challenge generation, cue validation, routing (ported from cuesheet.js + graph.js)
```

### 2. `graph_service.py` — City loading with OSMnx

- `load_city(boundary_geojson)`:
  - Convert GeoJSON polygon → Shapely Polygon
  - Call `ox.graph_from_polygon(polygon, network_type="drive")` to get the directed MultiDiGraph
  - Extract street features from graph edges → GeoJSON FeatureCollection (for Mapbox map layers)
  - Extract `street_segments_data` equivalent (name → [{coordinates, type, highway, length, oneway}]) from graph edges
  - Store graph + data in a session dict
  - Return: street GeoJSON, street names list, segment data

- Key improvement over current code: OSMnx handles one-way streets, roundabouts, and access restrictions natively. Edge geometries include full road curves (Shapely LineStrings).

### 3. `cuesheet_service.py` — Port cuesheet logic from JS

Port all logic currently in `cuesheet.js` and `graph.js`, using NetworkX for graph operations:

- **Bearing utilities**: `calculate_bearing()`, `classify_turn()` — use edge geometry endpoints (not just node positions) for accurate bearings on curved roads (per the guide)
- **Pathfinding**: `nx.shortest_path(G, source, target, weight='length')` replaces custom Dijkstra
- **Closest node**: `ox.nearest_nodes(G, X=lng, Y=lat)` replaces linear scan
- **Challenge generation**: `pick_challenge_pair()` — same logic, filter by difficulty, verify path exists
- **Route init**: `init_starting_route()` — find starting street from Dijkstra path, auto-follow forward
- **Cue validation**: `validate_next_cue()` — full pipeline: `find_turn_street_ahead()` → `pick_edge_by_direction()` → `follow_street_forward()` → `check_reached_end()`
- **Hint generation**: `get_hint()` — Dijkstra-based next turn
- **Results**: Compute optimal route + cuesheet for comparison
- **Name changes**: `find_name_change_edge()` — detect when road continues straight under different name
- **Helpers**: `path_to_coordinates()`, `path_to_cuesheet()`, `match_street_name()`

### 4. `main.py` — FastAPI endpoints

Session-based (in-memory dict of session_id → graph + game state):

| Endpoint | Purpose |
|---|---|
| `POST /api/city/load` | Load city via OSMnx, return street GeoJSON + metadata |
| `POST /api/graph/shortest-path` | NetworkX shortest path, return coordinates |
| `POST /api/graph/closest-node` | Find nearest graph node to lat/lng |
| `POST /api/graph/node-streets` | Get street names at a node |
| `POST /api/cuesheet/challenge` | Generate random challenge pair |
| `POST /api/cuesheet/validate-cue` | Validate a player's cue, return updated route |
| `POST /api/cuesheet/hint` | Get next optimal cue from Dijkstra |
| `POST /api/cuesheet/results` | Compute optimal path for results display |
| `POST /api/cuesheet/custom-closest-node` | For custom route: find closest node |

All cuesheet endpoints accept/return route state as JSON so the frontend can maintain its own copy for rendering. The backend returns coordinate arrays for map drawing (not raw graph edges).

**Route state format** (returned by backend, stored by frontend):
```json
{
  "currentNode": 12345,
  "currentBearing": 45.2,
  "currentStreet": "Main Street",
  "routeCoordinates": [[lng, lat], ...],
  "confirmedCoordinates": [[lng, lat], ...],
  "continuationCoordinates": [[lng, lat], ...],
  "confirmedEdgeCount": 3,
  "reachedEnd": false,
  "endCoordinates": [[lng, lat], ...]
}
```

---

## Phase 2: Frontend Refactoring

### 5. Create `src/api/backend.js` — API client

New module with functions that call the Python backend:
- `loadCity(boundaries)` → POST /api/city/load
- `getShortestPath(sessionId, startNode, endNode)` → POST /api/graph/shortest-path
- `getClosestNode(sessionId, lat, lng)` → POST /api/graph/closest-node
- `generateChallenge(sessionId, difficulty)` → POST /api/cuesheet/challenge
- `validateCue(sessionId, routeState, cue)` → POST /api/cuesheet/validate-cue
- `getHint(sessionId, routeState, challenge)` → POST /api/cuesheet/hint
- `getResults(sessionId, challenge, routeState)` → POST /api/cuesheet/results

### 6. Modify `src/api/osm.js`

- Keep `searchCities()` — still calls Nominatim directly (no change)
- Keep `getCityBoundaries()` — still calls Nominatim directly (no change)
- Remove `fetchStreetsFromOSM()` and `processOSMData()` — replaced by backend call
- Keep `getStreetType()`, `createFallbackBoundary()`, `isValidBoundary()` — still needed

### 7. Modify `src/game/core.js`

- `loadStreetsForCity()`: Call `backend.loadCity(boundaries)` instead of `fetchStreetsFromOSM(boundaries)`
  - Receive street GeoJSON + streetSegmentsData from backend
  - Store sessionId in state
  - Rest of the function stays the same (setupCityMapLayers, etc.)
- Remove `state.streetGraph = null` line (no longer tracked in frontend)

### 8. Refactor `src/game/cuesheet.js`

Major simplification — all graph logic removed, replaced with backend API calls:

- `generateCuesheetChallenge()`: Call `backend.generateChallenge()`, no more `buildStreetGraph()`
- `addCue()`: Call `backend.validateCue()`, receive coordinates for drawing
- `removeCue()`: Call backend to rebuild route from remaining explicit cues
- `submitCuesheet()`: Call `backend.getResults()` for optimal route
- `getHint()`: Call `backend.getHint()`
- `startCustomRoute()` / `handleCustomRouteClick()`: Call `backend.getClosestNode()` and `backend.getShortestPath()` for validation

**Keep in frontend** (unchanged):
- All UI rendering: `renderCueList()`, `drawLiveRoute()`, `addRouteLayer()`, `addEndpointMarkers()`
- Autocomplete: `handleStreetAutocomplete()`, `handleSuggestionKeydown()`
- Direction selection: `selectDirection()`
- Map layer management: `cleanupCuesheetMapLayers()`

### 9. Simplify `src/game/graph.js`

Remove most of the file. Only keep if needed:
- `calculateBearing()` / `classifyTurn()` — only if the frontend still needs these for display purposes. Otherwise remove entirely.
- Remove: `buildStreetGraph()`, `findShortestPath()`, `findClosestNode()`, `getNodeStreetNames()`, `pathToCoordinates()`, `pathToCuesheet()`, `addEdge()`, `coordKey()`

### 10. Update `src/state.js`

- Add: `sessionId` (backend session identifier)
- Remove: `streetGraph`, `roundaboutCoords`
- Keep everything else (cuesheetChallenge, cuesheetCues, _cuesheetRoute store rendering data now)

---

## Phase 3: Ensure All Game Modes Work

### 11. Streets mode (`streets.js`) — No changes needed

- Only uses `state.streetData` (GeoJSON) and `state.streetSegmentsData` for name matching
- These are populated by the backend response in `loadCity()`
- Map rendering unchanged

### 12. Intersections mode (`intersectionMode.js`, `intersections.js`) — No changes needed

- Only uses `state.streetData` and `state.streetSegmentsData` for geometric intersection detection
- All intersection logic is client-side (segment-to-segment distance calculations)
- These data structures come from the backend now but have the same format

### 13. Cache (`cache.js`) — Minor update

- `saveGameState()` / `loadGameState()`: Add sessionId to cached data
- On restore: may need to re-establish backend session if expired

---

## Phase 4: Dev Setup

### 14. Vite proxy config

Update `vite.config.js` to proxy `/api` requests to the Python backend:
```js
export default defineConfig({
  base: '/citystreetgame/',
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    }
  }
})
```

### 15. Start scripts

- Backend: `cd backend && uvicorn main:app --reload --port 8000`
- Frontend: `npm run dev` (Vite dev server with proxy)
- Add convenience scripts to package.json or a Makefile

---

## Key Benefits of This Refactoring

1. **Better graph quality**: OSMnx builds proper directed graphs from OSM data, handling one-way streets, roundabouts, access restrictions natively
2. **Accurate bearings**: Edge geometries (Shapely LineStrings) give correct turn angles on curved roads, fixing the "node-to-node bearing" pitfall
3. **Simpler frontend**: ~600 lines of graph construction and cuesheet validation logic removed from JS
4. **NetworkX pathfinding**: Battle-tested Dijkstra, no more custom priority queue
5. **Roundabout support**: OSMnx handles `junction=roundabout` edges naturally
6. **Extensibility**: Easy to add new graph-based features (A* routing, turn costs, etc.)
