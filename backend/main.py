"""FastAPI backend for City Street Game.

Uses OSMnx for street data and NetworkX for graph operations.
"""

import hashlib
import json
import uuid

import networkx as nx
import osmnx as ox
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from shapely.geometry import shape

from .geo import (
    edge_coordinates, get_edge_name, get_edge_highway,
    classify_highway, match_street_name, distance_meters,
)
from .cuesheet import (
    pick_challenge_pair, init_starting_route, validate_next_cue,
    get_hint, compute_optimal_route, get_continuation_coords,
    _edges_from_node, _edges_to_coords, _dedup_coords,
    _pick_display_streets,
)
from .models import (
    CityLoadRequest, CityLoadResponse,
    ClosestNodeRequest, NodeInfo,
    ShortestPathRequest, ShortestPathResponse,
    ChallengeRequest, ChallengeResponse, ChallengeNode, InitRouteResponse,
    ValidateCueRequest, ValidateCueResponse,
    UndoRequest, HintRequest,
    OptimalRouteRequest, OptimalRouteResponse,
    IntersectionChallengeRequest, IntersectionChallengeResponse,
    IntersectionLocation,
)

app = FastAPI(title="City Street Game API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

city_graphs: dict[str, nx.MultiDiGraph] = {}
city_street_data: dict[str, dict] = {}  # city_id → {street_data, street_names, ...}
route_states: dict[str, dict] = {}  # route_id → {graph_id, challenge, route_state, explicit_cues}


def _city_id(boundaries: dict) -> str:
    """Generate a stable city ID from boundary GeoJSON."""
    raw = json.dumps(boundaries, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _nearest_node(G, lat, lng):
    """Find the nearest graph node to a lat/lng point."""
    best_node = None
    best_dist = float('inf')
    for node, data in G.nodes(data=True):
        dx = data['x'] - lng
        dy = data['y'] - lat
        dist = dx * dx + dy * dy
        if dist < best_dist:
            best_dist = dist
            best_node = node
    return best_node


# ---------------------------------------------------------------------------
# City loading
# ---------------------------------------------------------------------------

def _load_graph(boundary_geojson: dict) -> nx.MultiDiGraph:
    """Load an OSMnx graph from a GeoJSON boundary polygon."""
    polygon = shape(boundary_geojson)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)

    G = ox.graph_from_polygon(polygon, network_type="drive")
    return G


def _extract_street_data(G: nx.MultiDiGraph) -> dict:
    """Extract GeoJSON FeatureCollection and metadata from the graph."""
    street_groups: dict[str, list] = {}  # name → [segment dicts]

    for u, v, key, data in G.edges(keys=True, data=True):
        name = data.get('name')
        if isinstance(name, list):
            name = name[0] if name else None
        if not name:
            continue

        hw = data.get('highway', 'residential')
        if isinstance(hw, list):
            hw = hw[0]

        coords = edge_coordinates(G, u, v, key)
        length = data.get('length', 0)
        street_type = classify_highway(hw)

        if name not in street_groups:
            street_groups[name] = []

        street_groups[name].append({
            'coordinates': coords,
            'length': length,
            'type': street_type,
            'highway': hw,
        })

    # Build GeoJSON features
    features = []
    total_length = 0

    for street_name, segments in street_groups.items():
        seg_total = sum(s['length'] for s in segments)
        total_length += seg_total

        # Highest classification
        type_hierarchy = ['major', 'primary', 'secondary', 'tertiary', 'residential']
        highest_type = 'residential'
        for seg in segments:
            cur_idx = type_hierarchy.index(seg['type']) if seg['type'] in type_hierarchy else 4
            hi_idx = type_hierarchy.index(highest_type) if highest_type in type_hierarchy else 4
            if cur_idx < hi_idx:
                highest_type = seg['type']

        properties = {
            'name': street_name,
            'type': highest_type,
            'length': seg_total,
            'highway': segments[0]['highway'],
            'segments': len(segments),
        }

        if len(segments) == 1:
            geometry = {'type': 'LineString', 'coordinates': segments[0]['coordinates']}
        else:
            geometry = {'type': 'MultiLineString',
                        'coordinates': [s['coordinates'] for s in segments]}

        features.append({'type': 'Feature', 'properties': properties, 'geometry': geometry})

    street_names = sorted(street_groups.keys(), key=str.lower)

    return {
        'street_data': {'type': 'FeatureCollection', 'features': features},
        'street_names': street_names,
        'total_length': total_length,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/city/load", response_model=CityLoadResponse)
def load_city(req: CityLoadRequest):
    cid = _city_id(req.boundaries)

    if cid not in city_graphs:
        try:
            G = _load_graph(req.boundaries)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to load graph: {e}")

        city_graphs[cid] = G
        city_street_data[cid] = _extract_street_data(G)

    data = city_street_data[cid]
    G = city_graphs[cid]

    return CityLoadResponse(
        city_id=cid,
        street_data=data['street_data'],
        street_names=data['street_names'],
        total_length=data['total_length'],
        graph_stats={
            'nodes': G.number_of_nodes(),
            'edges': G.number_of_edges(),
        },
    )


@app.post("/api/graph/closest-node", response_model=NodeInfo)
def closest_node(req: ClosestNodeRequest):
    G = city_graphs.get(req.city_id)
    if not G:
        raise HTTPException(404, "City not loaded")

    node_id = _nearest_node(G, req.lat, req.lng)
    node_data = G.nodes[node_id]

    streets = set()
    for _, v, key in G.out_edges(node_id, keys=True):
        name = get_edge_name(G, node_id, v, key)
        if name:
            streets.add(name)
    for u, _, key in G.in_edges(node_id, keys=True):
        name = get_edge_name(G, u, node_id, key)
        if name:
            streets.add(name)

    return NodeInfo(
        node_id=node_id,
        lat=node_data['y'],
        lng=node_data['x'],
        streets=sorted(streets),
    )


@app.post("/api/graph/shortest-path", response_model=ShortestPathResponse)
def shortest_path(req: ShortestPathRequest):
    G = city_graphs.get(req.city_id)
    if not G:
        raise HTTPException(404, "City not loaded")

    result = compute_optimal_route(G, req.start_node, req.end_node)
    if not result:
        raise HTTPException(404, "No path found")

    return ShortestPathResponse(
        coordinates=result['coordinates'],
        total_distance=result['total_distance'],
        cues=result['cues'],
    )


@app.post("/api/cuesheet/challenge", response_model=ChallengeResponse)
def generate_challenge(req: ChallengeRequest):
    G = city_graphs.get(req.city_id)
    if not G:
        raise HTTPException(404, "City not loaded")

    # Support custom start/end nodes for custom routes
    if req.start_node is not None and req.end_node is not None:
        if req.start_node not in G.nodes or req.end_node not in G.nodes:
            raise HTTPException(400, "Invalid start or end node")
        try:
            nx.shortest_path(G, req.start_node, req.end_node, weight='length')
        except nx.NetworkXNoPath:
            raise HTTPException(400, "No path between start and end nodes")

        start_node = req.start_node
        end_node = req.end_node
        challenge = {
            'start_node': start_node,
            'end_node': end_node,
            'start_streets': _pick_display_streets(G, start_node),
            'end_streets': _pick_display_streets(G, end_node),
        }
    else:
        challenge = pick_challenge_pair(G, req.difficulty)
        if not challenge:
            raise HTTPException(400, "Could not find a suitable route pair")

        start_node = challenge['start_node']
        end_node = challenge['end_node']

    start_data = G.nodes[start_node]
    end_data = G.nodes[end_node]

    # Initialize route
    route = init_starting_route(G, start_node, end_node)
    if not route:
        raise HTTPException(400, "Could not determine starting route")

    route_id = str(uuid.uuid4())[:8]
    challenge_id = str(uuid.uuid4())[:8]

    # Compute rendering coordinates
    route_coords = _edges_to_coords(route['edges'])
    confirmed_count = route['confirmed_edge_count']

    # Continuation preview
    cont_coords = get_continuation_coords(G, route, end_node)

    # End coordinates
    end_coords = _edges_to_coords(route['end_edges']) if route.get('end_edges') else []

    # Store route state
    route_states[route_id] = {
        'city_id': req.city_id,
        'challenge': {
            'start_node': start_node,
            'end_node': end_node,
            'starting_street': route['starting_street'],
        },
        'route_state': route,
        'explicit_cues': [],
    }

    current_node_data = G.nodes[route['current_node']]
    current_streets = set()
    for _, v, k in G.out_edges(route['current_node'], keys=True):
        n = get_edge_name(G, route['current_node'], v, k)
        if n:
            current_streets.add(n)

    return ChallengeResponse(
        challenge_id=challenge_id,
        start_node=ChallengeNode(
            node_id=start_node,
            lat=start_data['y'],
            lng=start_data['x'],
            streets=challenge['start_streets'],
        ),
        end_node=ChallengeNode(
            node_id=end_node,
            lat=end_data['y'],
            lng=end_data['x'],
            streets=challenge['end_streets'],
        ),
        route=InitRouteResponse(
            route_id=route_id,
            starting_street=route['starting_street'],
            current_node=NodeInfo(
                node_id=route['current_node'],
                lat=current_node_data['y'],
                lng=current_node_data['x'],
                streets=sorted(current_streets),
            ),
            route_coordinates=route_coords,
            continuation_coordinates=cont_coords,
            confirmed_edge_count=confirmed_count,
            reached_end=route['reached_end'],
            end_coordinates=end_coords,
            name_changes=route.get('name_changes', []),
        ),
    )


@app.post("/api/cuesheet/validate-cue", response_model=ValidateCueResponse)
def validate_cue(req: ValidateCueRequest):
    rs = route_states.get(req.route_id)
    if not rs:
        raise HTTPException(404, "Route not found")

    G = city_graphs.get(rs['city_id'])
    if not G:
        raise HTTPException(404, "City not loaded")

    end_node = rs['challenge']['end_node']
    result = validate_next_cue(
        G, rs['route_state'], req.direction, req.street_name, end_node
    )

    if not result['valid']:
        return ValidateCueResponse(valid=False, error=result.get('error'))

    # Update stored route state
    rs['route_state'] = result['route']
    rs['explicit_cues'].append({
        'direction': req.direction,
        'street_name': result['matched_street_name'],
    })

    route = result['route']
    route_coords = _edges_to_coords(route['edges'])
    confirmed_coords = _edges_to_coords(route['edges'][:route['confirmed_edge_count']])
    cont_coords = get_continuation_coords(G, route, end_node)
    end_coords = _edges_to_coords(route.get('end_edges', []))

    current_node_data = G.nodes[route['current_node']]
    current_streets = set()
    for _, v, k in G.out_edges(route['current_node'], keys=True):
        n = get_edge_name(G, route['current_node'], v, k)
        if n:
            current_streets.add(n)

    return ValidateCueResponse(
        valid=True,
        matched_street_name=result['matched_street_name'],
        current_street=route['current_street'],
        current_node=NodeInfo(
            node_id=route['current_node'],
            lat=current_node_data['y'],
            lng=current_node_data['x'],
            streets=sorted(current_streets),
        ),
        route_coordinates=route_coords,
        confirmed_coordinates=confirmed_coords,
        continuation_coordinates=cont_coords,
        confirmed_edge_count=route['confirmed_edge_count'],
        reached_end=route['reached_end'],
        end_coordinates=end_coords,
        pre_turn_name_changes=result.get('pre_turn_name_changes', []),
        post_turn_name_changes=result.get('post_turn_name_changes', []),
    )


@app.post("/api/cuesheet/undo")
def undo_cue(req: UndoRequest):
    rs = route_states.get(req.route_id)
    if not rs:
        raise HTTPException(404, "Route not found")

    G = city_graphs.get(rs['city_id'])
    if not G:
        raise HTTPException(404, "City not loaded")

    start_node = rs['challenge']['start_node']
    end_node = rs['challenge']['end_node']

    # Truncate explicit cues
    explicit_cues = rs['explicit_cues'][:req.cue_count]

    # Re-init route
    route = init_starting_route(G, start_node, end_node)
    if not route:
        raise HTTPException(400, "Could not reinitialize route")

    # Replay explicit cues
    replayed_cues = []
    for cue in explicit_cues:
        result = validate_next_cue(
            G, route, cue['direction'], cue['street_name'], end_node
        )
        if not result['valid']:
            break
        route = result['route']
        replayed_cues.append(cue)

    rs['route_state'] = route
    rs['explicit_cues'] = replayed_cues

    route_coords = _edges_to_coords(route['edges'])
    confirmed_coords = _edges_to_coords(route['edges'][:route['confirmed_edge_count']])
    cont_coords = get_continuation_coords(G, route, end_node)
    end_coords = _edges_to_coords(route.get('end_edges', []))

    current_node_data = G.nodes[route['current_node']]
    current_streets = set()
    for _, v, k in G.out_edges(route['current_node'], keys=True):
        n = get_edge_name(G, route['current_node'], v, k)
        if n:
            current_streets.add(n)

    name_changes = route.get('name_changes', [])

    # Collect all name changes from replay
    # (These are the implicit cues that would have been inserted)
    all_name_changes = list(name_changes)

    return {
        'starting_street': rs['challenge']['starting_street'],
        'current_street': route['current_street'],
        'current_node': NodeInfo(
            node_id=route['current_node'],
            lat=current_node_data['y'],
            lng=current_node_data['x'],
            streets=sorted(current_streets),
        ).model_dump(),
        'route_coordinates': route_coords,
        'confirmed_coordinates': confirmed_coords,
        'continuation_coordinates': cont_coords,
        'confirmed_edge_count': route['confirmed_edge_count'],
        'reached_end': route['reached_end'],
        'end_coordinates': end_coords,
        'name_changes': all_name_changes,
        'replayed_cues': replayed_cues,
    }


@app.post("/api/cuesheet/hint")
def hint(req: HintRequest):
    rs = route_states.get(req.route_id)
    if not rs:
        raise HTTPException(404, "Route not found")

    G = city_graphs.get(rs['city_id'])
    if not G:
        raise HTTPException(404, "City not loaded")

    route = rs['route_state']
    end_node = rs['challenge']['end_node']

    if route.get('reached_end'):
        return {'message': 'Route already reaches the destination'}

    hint_cue = get_hint(G, route, end_node)
    if not hint_cue:
        # Try checking if destination reachable on current street
        return {'message': f'Keep following {route["current_street"] or "the current street"}'}

    # Validate the hint cue
    result = validate_next_cue(
        G, route, hint_cue['direction'], hint_cue['street_name'], end_node
    )

    if result['valid']:
        # Apply it
        rs['route_state'] = result['route']
        rs['explicit_cues'].append({
            'direction': hint_cue['direction'],
            'street_name': result['matched_street_name'],
        })

        new_route = result['route']
        route_coords = _edges_to_coords(new_route['edges'])
        confirmed_coords = _edges_to_coords(new_route['edges'][:new_route['confirmed_edge_count']])
        cont_coords = get_continuation_coords(G, new_route, end_node)
        end_coords = _edges_to_coords(new_route.get('end_edges', []))

        current_node_data = G.nodes[new_route['current_node']]
        current_streets = set()
        for _, v, k in G.out_edges(new_route['current_node'], keys=True):
            n = get_edge_name(G, new_route['current_node'], v, k)
            if n:
                current_streets.add(n)

        return {
            'cue': {
                'direction': hint_cue['direction'],
                'street_name': result['matched_street_name'],
            },
            'valid': True,
            'current_street': new_route['current_street'],
            'current_node': NodeInfo(
                node_id=new_route['current_node'],
                lat=current_node_data['y'],
                lng=current_node_data['x'],
                streets=sorted(current_streets),
            ).model_dump(),
            'route_coordinates': route_coords,
            'confirmed_coordinates': confirmed_coords,
            'continuation_coordinates': cont_coords,
            'confirmed_edge_count': new_route['confirmed_edge_count'],
            'reached_end': new_route['reached_end'],
            'end_coordinates': end_coords,
            'pre_turn_name_changes': result.get('pre_turn_name_changes', []),
            'post_turn_name_changes': result.get('post_turn_name_changes', []),
        }

    return {'message': f'Keep following {route["current_street"] or "the current street"}'}


@app.post("/api/cuesheet/optimal-route", response_model=OptimalRouteResponse)
def optimal_route(req: OptimalRouteRequest):
    G = city_graphs.get(req.city_id)
    if not G:
        raise HTTPException(404, "City not loaded")

    result = compute_optimal_route(G, req.start_node, req.end_node)
    if not result:
        raise HTTPException(404, "No path found")

    return OptimalRouteResponse(
        coordinates=result['coordinates'],
        cues=result['cues'],
        total_distance=result['total_distance'],
    )


@app.post("/api/intersections/challenge", response_model=IntersectionChallengeResponse)
def intersection_challenge(req: IntersectionChallengeRequest):
    G = city_graphs.get(req.city_id)
    if not G:
        raise HTTPException(404, "City not loaded")

    import random

    # Find intersections from graph nodes
    # An intersection is a node where 2+ different named streets meet
    intersections = []
    for node in G.nodes:
        streets = set()
        street_types = {}
        for _, v, key in G.out_edges(node, keys=True):
            name = get_edge_name(G, node, v, key)
            hw = get_edge_highway(G, node, v, key)
            if name:
                streets.add(name)
                if name not in street_types:
                    street_types[name] = classify_highway(hw)
        for u, _, key in G.in_edges(node, keys=True):
            name = get_edge_name(G, u, node, key)
            hw = get_edge_highway(G, u, node, key)
            if name:
                streets.add(name)
                if name not in street_types:
                    street_types[name] = classify_highway(hw)

        if len(streets) >= 2:
            intersections.append({
                'node': node,
                'streets': streets,
                'street_types': street_types,
            })

    if not intersections:
        raise HTTPException(400, "No intersections found")

    # Filter by difficulty
    random.shuffle(intersections)

    for ix in intersections:
        street_list = sorted(ix['streets'])
        # Try all pairs of streets at this intersection
        for i in range(len(street_list)):
            for j in range(i + 1, len(street_list)):
                s1, s2 = street_list[i], street_list[j]
                t1 = ix['street_types'].get(s1, 'residential')
                t2 = ix['street_types'].get(s2, 'residential')
                cat1 = 'major' if t1 in ('major', 'primary', 'secondary', 'tertiary') else 'local'
                cat2 = 'major' if t2 in ('major', 'primary', 'secondary', 'tertiary') else 'local'

                ok = False
                if req.difficulty == 'major-major':
                    ok = cat1 == 'major' and cat2 == 'major'
                elif req.difficulty == 'major-all':
                    ok = cat1 == 'major' or cat2 == 'major'
                elif req.difficulty == 'all-all':
                    ok = True

                if ok:
                    node_data = G.nodes[ix['node']]

                    # Find all locations where these two streets meet
                    locations = []
                    for other_ix in intersections:
                        if s1 in other_ix['streets'] and s2 in other_ix['streets']:
                            nd = G.nodes[other_ix['node']]
                            loc = {'lat': nd['y'], 'lng': nd['x']}
                            # Deduplicate nearby locations
                            is_dup = any(
                                distance_meters(loc['lat'], loc['lng'], l['lat'], l['lng']) < 20
                                for l in locations
                            )
                            if not is_dup:
                                locations.append(loc)

                    return IntersectionChallengeResponse(
                        street1=s1,
                        street2=s2,
                        type1=t1,
                        type2=t2,
                        locations=[IntersectionLocation(**l) for l in locations],
                        multiple_locations=len(locations) > 1,
                        location_count=len(locations),
                    )

    raise HTTPException(400, "No suitable intersection found for difficulty")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
