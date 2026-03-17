"""Cuesheet mode: challenge generation, cue validation, routing.

Ported from cuesheet.js + graph.js, using NetworkX for graph operations.
"""

import random
import networkx as nx
from .geo import (
    edge_exit_bearing, edge_entry_bearing, edge_coordinates,
    get_edge_name, get_edge_highway, classify_highway, classify_turn,
    match_street_name, calculate_bearing, distance_meters,
)


# ---------------------------------------------------------------------------
# Internal edge wrapper — carries the same data as the old JS edge objects
# ---------------------------------------------------------------------------

def _make_edge(G, u, v, key=0):
    """Build an edge dict with bearings and coordinates, like the old JS edges."""
    return {
        'u': u,
        'v': v,
        'key': key,
        'street_name': get_edge_name(G, u, v, key),
        'distance': G[u][v][key].get('length', 0),
        'bearing': edge_exit_bearing(G, u, v, key),
        'entry_bearing': edge_entry_bearing(G, u, v, key),
        'coordinates': edge_coordinates(G, u, v, key),
    }


def _edges_from_node(G, node):
    """Get all outgoing edges from a node as edge dicts."""
    edges = []
    for u, v, key in G.out_edges(node, keys=True):
        name = get_edge_name(G, u, v, key)
        if name is None:
            continue  # skip unnamed edges
        edges.append(_make_edge(G, u, v, key))
    return edges


def _edges_to_coords(edges):
    """Convert a list of edge dicts to a coordinate array, deduplicating junctions."""
    coords = []
    for i, edge in enumerate(edges):
        if i == 0:
            coords.extend(edge['coordinates'])
        else:
            coords.extend(edge['coordinates'][1:])
    return _dedup_coords(coords)


def _dedup_coords(coords):
    if not coords:
        return coords
    result = [coords[0]]
    for c in coords[1:]:
        if c[0] != result[-1][0] or c[1] != result[-1][1]:
            result.append(c)
    return result


# ---------------------------------------------------------------------------
# Street category helpers
# ---------------------------------------------------------------------------

def _node_matches_difficulty(G, node, difficulty):
    """Check if a node matches the difficulty filter using local edge data."""
    street_categories = {}
    for _, v, key, data in G.out_edges(node, keys=True, data=True):
        name = data.get('name')
        if isinstance(name, list):
            name = name[0] if name else None
        if not name or name in street_categories:
            continue
        hw = data.get('highway', 'residential')
        if isinstance(hw, list):
            hw = hw[0]
        cat = classify_highway(hw)
        street_categories[name] = 'major' if cat in ('major', 'primary', 'secondary', 'tertiary') else 'local'

    major_count = sum(1 for c in street_categories.values() if c == 'major')

    if difficulty == 'major-major':
        return major_count >= 2
    elif difficulty == 'major-all':
        return major_count >= 1
    elif difficulty == 'all-all':
        return len(street_categories) >= 2
    return False


# ---------------------------------------------------------------------------
# Challenge generation
# ---------------------------------------------------------------------------

def pick_challenge_pair(G, difficulty='major-major'):
    """Pick two random graph nodes as start/end, verify path exists."""
    nodes = list(G.nodes)

    major_nodes = [
        n for n in nodes
        if G.out_degree(n) >= 2
        and _node_matches_difficulty(G, n, difficulty)
    ]

    if len(major_nodes) < 2:
        return None

    for _ in range(50):
        start_id = random.choice(major_nodes)
        end_id = random.choice(major_nodes)
        if start_id == end_id:
            continue

        try:
            path = nx.shortest_path(G, start_id, end_id, weight='length')
        except nx.NetworkXNoPath:
            continue

        if len(path) < 2:
            continue

        return {
            'start_node': start_id,
            'end_node': end_id,
            'start_streets': _pick_display_streets(G, start_id),
            'end_streets': _pick_display_streets(G, end_id),
        }

    return None


def _pick_display_streets(G, node):
    """Pick the top 2 most-connected street names at a node."""
    edges = _edges_from_node(G, node)
    counts = {}
    for e in edges:
        name = e['street_name']
        if name:
            counts[name] = counts.get(name, 0) + 1
    sorted_names = sorted(counts.items(), key=lambda x: -x[1])
    return [name for name, _ in sorted_names[:2]]


# ---------------------------------------------------------------------------
# Route initialization
# ---------------------------------------------------------------------------

def init_starting_route(G, start_node, end_node):
    """Initialize the route by finding the starting street and auto-following it."""
    try:
        path = nx.shortest_path(G, start_node, end_node, weight='length')
    except nx.NetworkXNoPath:
        return None

    if len(path) < 2:
        return None

    # First edge of Dijkstra path determines starting street
    first_u, first_v = path[0], path[1]
    # Find the key for this edge
    first_key = _best_edge_key(G, first_u, first_v)
    starting_street = get_edge_name(G, first_u, first_v, first_key)
    if not starting_street:
        return None

    # Find the edge from start_node on this street heading toward destination
    all_start_edges = _edges_from_node(G, start_node)
    matching_edges = [e for e in all_start_edges
                      if match_street_name(starting_street, e['street_name'])]
    if not matching_edges:
        return None

    # Pick the edge most aligned with the bearing to destination
    end_data = G.nodes[end_node]
    start_data = G.nodes[start_node]
    bearing_to_end = calculate_bearing(
        start_data['y'], start_data['x'], end_data['y'], end_data['x']
    )

    best_edge = matching_edges[0]
    best_score = float('inf')
    for edge in matching_edges:
        delta = abs(edge['bearing'] - bearing_to_end)
        if delta > 180:
            delta = 360 - delta
        if delta < best_score:
            best_score = delta
            best_edge = edge

    route_edges = [best_edge]
    continuation = _follow_street_forward(
        G, best_edge['v'], starting_street, best_edge['entry_bearing'],
        end_node
    )
    route_edges.extend(continuation['edges'])

    final_node = (continuation['edges'][-1]['v']
                  if continuation['edges'] else best_edge['v'])
    final_bearing = (continuation['edges'][-1]['entry_bearing']
                     if continuation['edges'] else best_edge['entry_bearing'])
    final_street = continuation['street_name']

    reached = _check_reached_end(
        G, final_node, final_street, final_bearing, route_edges, end_node
    )

    return {
        'current_node': final_node,
        'current_bearing': final_bearing,
        'current_street': final_street,
        'edges': route_edges,
        'confirmed_edge_count': 0,
        'reached_end': reached['reached'],
        'end_edges': reached['edges'],
        'name_changes': continuation.get('name_changes', []),
        'starting_street': starting_street,
        'explicit_cues': [],
    }


def _best_edge_key(G, u, v):
    """Find the best edge key between u and v (prefer named edges)."""
    if not G.has_edge(u, v):
        return 0
    for key in G[u][v]:
        name = get_edge_name(G, u, v, key)
        if name:
            return key
    return 0


# ---------------------------------------------------------------------------
# Cue validation
# ---------------------------------------------------------------------------

def validate_next_cue(G, route_state, direction, street_name, end_node):
    """Validate a player's cue against the current route state.

    Returns dict with 'valid', 'error', 'route' (updated state), etc.
    """
    current_node = route_state['current_node']
    current_bearing = route_state['current_bearing']
    current_street = route_state['current_street']
    route_edges = list(route_state['edges'])

    # Search forward along current street for the target street
    search = _find_turn_street_ahead(
        G, current_node, current_street, current_bearing, street_name,
        direction
    )

    if not search:
        # Check if street exists with wrong direction (better error)
        any_result = _find_turn_street_ahead(
            G, current_node, current_street, current_bearing, street_name
        )
        if any_result:
            dir_name = {'L': 'left', 'R': 'right', 'S': 'straight', 'U': 'U-turn'}
            turn_edges = _edges_from_node(G, any_result['node'])
            dir_matches = [e for e in turn_edges
                           if match_street_name(street_name, e['street_name'])]
            actual_dirs = [classify_turn(any_result['bearing'], e['bearing'])
                           for e in dir_matches]
            hint = (f" (it's {dir_name.get(actual_dirs[0], actual_dirs[0])})"
                    if actual_dirs else '')
            return {
                'valid': False,
                'error': f'"{street_name}" is not {dir_name.get(direction, direction)}{hint}',
            }
        return {
            'valid': False,
            'error': f'"{street_name}" is not reachable along {current_street or "the current street"}',
        }

    pre_turn_name_changes = search.get('name_changes', [])
    route_edges.extend(search['transit_edges'])

    # Pick edge by direction
    turn_node_edges = _edges_from_node(G, search['node'])
    direct_matches = [e for e in turn_node_edges
                      if match_street_name(street_name, e['street_name'])]

    chosen_edge = _pick_edge_by_direction(
        G, direct_matches, search['bearing'], direction, end_node
    )
    if not chosen_edge:
        dir_name = {'L': 'left', 'R': 'right', 'S': 'straight', 'U': 'U-turn'}
        actual_dirs = [classify_turn(search['bearing'], e['bearing'])
                       for e in direct_matches]
        player_dir = dir_name.get(direction, direction)
        hint = (f" (it's {dir_name.get(actual_dirs[0], actual_dirs[0])})"
                if actual_dirs else '')
        return {
            'valid': False,
            'error': f'"{street_name}" is not {player_dir}{hint}',
        }

    confirmed_edge_count = len(route_edges)
    route_edges.append(chosen_edge)

    new_node = chosen_edge['v']
    new_bearing = chosen_edge['entry_bearing']

    # Follow new street forward
    continuation = _follow_street_forward(
        G, new_node, chosen_edge['street_name'], new_bearing, end_node
    )
    route_edges.extend(continuation['edges'])

    post_turn_name_changes = continuation.get('name_changes', [])

    final_node = (continuation['edges'][-1]['v']
                  if continuation['edges'] else new_node)
    final_bearing = (continuation['edges'][-1]['entry_bearing']
                     if continuation['edges'] else new_bearing)
    final_street = continuation['street_name']

    reached = _check_reached_end(
        G, final_node, final_street, final_bearing, route_edges, end_node
    )

    return {
        'valid': True,
        'matched_street_name': chosen_edge['street_name'],
        'pre_turn_name_changes': pre_turn_name_changes,
        'post_turn_name_changes': post_turn_name_changes,
        'route': {
            'current_node': final_node,
            'current_bearing': final_bearing,
            'current_street': final_street,
            'edges': route_edges,
            'confirmed_edge_count': confirmed_edge_count,
            'reached_end': reached['reached'],
            'end_edges': reached['edges'],
        }
    }


def _pick_edge_by_direction(G, edges, incoming_bearing, direction, end_node=None):
    """Pick the best edge matching the requested direction."""
    if not direction or incoming_bearing is None:
        return edges[0] if edges else None

    scored = []
    for edge in edges:
        turn = classify_turn(incoming_bearing, edge['bearing'])
        score = 0

        if turn == direction:
            score = 100
        elif direction == 'S' and turn in ('L', 'R'):
            score = 50
        elif direction in ('L', 'R') and turn == 'S':
            delta = edge['bearing'] - incoming_bearing
            while delta > 180:
                delta -= 360
            while delta < -180:
                delta += 360
            if (direction == 'L' and delta < 0) or (direction == 'R' and delta > 0):
                score = 50

        if score > 0:
            scored.append({'edge': edge, 'score': score})

    if not scored:
        return None
    if len(scored) == 1:
        return scored[0]['edge']

    scored.sort(key=lambda s: -s['score'])
    top_score = scored[0]['score']
    tied = [s for s in scored if s['score'] == top_score]

    if len(tied) == 1:
        return tied[0]['edge']

    # Tiebreak: shortest path to destination
    if end_node:
        best_edge = tied[0]['edge']
        best_dist = float('inf')
        for s in tied:
            try:
                length = nx.shortest_path_length(
                    G, s['edge']['v'], end_node, weight='length'
                )
            except nx.NetworkXNoPath:
                length = float('inf')
            if length < best_dist:
                best_dist = length
                best_edge = s['edge']
        return best_edge

    return tied[0]['edge']


def _find_turn_street_ahead(G, from_node, current_street, bearing,
                             target_street, direction=None):
    """Search forward along current street for an intersection with target street."""
    current_node = from_node
    current_bearing = bearing
    walk_street = current_street
    visited = {from_node}
    transit_edges = []
    name_changes = []

    # Check current node first
    node_edges = _edges_from_node(G, current_node)
    direct_matches = [e for e in node_edges
                      if match_street_name(target_street, e['street_name'])]
    if direct_matches:
        if not direction or _pick_edge_by_direction(G, direct_matches, current_bearing, direction):
            return {'node': current_node, 'bearing': current_bearing,
                    'transit_edges': [], 'name_changes': []}

    # Walk forward
    for _ in range(50):
        edges = _edges_from_node(G, current_node)
        continuations = [
            e for e in edges
            if match_street_name(walk_street, e['street_name'])
            and e['v'] not in visited
            and classify_turn(current_bearing, e['bearing']) != 'U'
        ]

        if not continuations:
            name_change = _find_name_change_edge(edges, walk_street, current_bearing, visited)
            if name_change:
                continuations = [name_change]
                walk_street = name_change['street_name']
                name_changes.append({'street_name': name_change['street_name']})
            else:
                break

        edge = _pick_straightest(continuations, current_bearing)
        transit_edges.append(edge)
        visited.add(edge['v'])
        current_node = edge['v']
        current_bearing = edge['entry_bearing']

        # Check for target street at this node
        next_edges = _edges_from_node(G, current_node)
        matches = [e for e in next_edges
                   if match_street_name(target_street, e['street_name'])]
        if matches:
            if direction:
                dir_match = _pick_edge_by_direction(G, matches, current_bearing, direction)
                if not dir_match:
                    continue
            return {'node': current_node, 'bearing': current_bearing,
                    'transit_edges': transit_edges, 'name_changes': name_changes}

    return None


def _follow_street_forward(G, from_node, street_name, bearing, end_node=None):
    """Follow street through intermediate intersections with no decisions."""
    edges = []
    current_node = from_node
    current_bearing = bearing
    current_street = street_name
    visited = {from_node}
    name_changes = []

    for _ in range(50):
        node_edges = _edges_from_node(G, current_node)

        continuations = [
            e for e in node_edges
            if match_street_name(current_street, e['street_name'])
            and e['v'] not in visited
            and classify_turn(current_bearing, e['bearing']) != 'U'
        ]

        is_name_change = False
        if not continuations:
            name_change = _find_name_change_edge(
                node_edges, current_street, current_bearing, visited
            )
            if name_change:
                continuations = [name_change]
                current_street = name_change['street_name']
                name_changes.append({'street_name': name_change['street_name']})
                is_name_change = True
            else:
                break

        if not is_name_change:
            other_streets = [
                e for e in node_edges
                if not match_street_name(current_street, e['street_name'])
                and e['v'] not in visited
                and classify_turn(current_bearing, e['bearing']) != 'U'
            ]
            if other_streets:
                break

        edge = _pick_straightest(continuations, current_bearing)
        edges.append(edge)
        visited.add(edge['v'])
        current_node = edge['v']
        current_bearing = edge['entry_bearing']

        if end_node and current_node == end_node:
            break

    return {
        'edges': edges,
        'end_node': current_node,
        'end_bearing': current_bearing,
        'street_name': current_street,
        'name_changes': name_changes,
    }


def _get_full_street_continuation(G, from_node, street_name, bearing):
    """Follow street through ALL nodes for display (ignoring decision points)."""
    edges = []
    current_node = from_node
    current_bearing = bearing
    current_street = street_name
    visited = {from_node}

    for _ in range(100):
        node_edges = _edges_from_node(G, current_node)
        continuations = [
            e for e in node_edges
            if match_street_name(current_street, e['street_name'])
            and e['v'] not in visited
            and classify_turn(current_bearing, e['bearing']) != 'U'
        ]

        if not continuations:
            name_change = _find_name_change_edge(
                node_edges, current_street, current_bearing, visited
            )
            if name_change:
                continuations = [name_change]
                current_street = name_change['street_name']
            else:
                break

        edge = _pick_straightest(continuations, current_bearing)
        edges.append(edge)
        visited.add(edge['v'])
        current_node = edge['v']
        current_bearing = edge['entry_bearing']

    return edges


def _find_name_change_edge(node_edges, current_street, current_bearing, visited):
    """Detect when a road continues straight under a different name."""
    all_forward = [
        e for e in node_edges
        if e['v'] not in visited
        and classify_turn(current_bearing, e['bearing']) == 'S'
    ]
    if (len(all_forward) == 1
            and not match_street_name(current_street, all_forward[0]['street_name'])):
        return all_forward[0]
    return None


def _pick_straightest(edges, current_bearing):
    """Pick the edge most aligned with the current bearing."""
    if len(edges) <= 1:
        return edges[0] if edges else None

    best = edges[0]
    best_delta = abs(current_bearing - best['bearing'])
    if best_delta > 180:
        best_delta = 360 - best_delta

    for e in edges[1:]:
        delta = abs(current_bearing - e['bearing'])
        if delta > 180:
            delta = 360 - delta
        if delta < best_delta:
            best_delta = delta
            best = e

    return best


def _check_reached_end(G, current_node, current_street, bearing,
                        route_edges, end_node):
    """BFS check if destination is reachable by continuing on current street."""
    if current_node == end_node:
        return {'reached': True, 'edges': []}

    visited_nodes = {e['v'] for e in route_edges}
    visited_nodes.discard(end_node)
    visited_nodes.discard(current_node)

    queue = [{'node': current_node, 'bearing': bearing,
              'edges': [], 'street': current_street}]
    queue_visited = {current_node}

    while queue:
        item = queue.pop(0)
        node = item['node']
        cur_bearing = item['bearing']
        cur_edges = item['edges']
        street = item['street']

        if node == end_node and node != current_node:
            return {'reached': True, 'edges': cur_edges}

        if len(cur_edges) > 100:
            continue

        node_edges = _edges_from_node(G, node)
        continuations = [
            e for e in node_edges
            if match_street_name(street, e['street_name'])
            and e['v'] not in queue_visited
            and classify_turn(cur_bearing, e['bearing']) != 'U'
        ]

        next_street = street
        if not continuations:
            name_change = _find_name_change_edge(
                node_edges, street, cur_bearing, queue_visited
            )
            if name_change:
                continuations = [name_change]
                next_street = name_change['street_name']

        for edge in continuations:
            queue_visited.add(edge['v'])
            queue.append({
                'node': edge['v'],
                'bearing': edge['entry_bearing'],
                'edges': cur_edges + [edge],
                'street': next_street,
            })

    return {'reached': False, 'edges': []}


# ---------------------------------------------------------------------------
# Hint generation
# ---------------------------------------------------------------------------

def get_hint(G, route_state, end_node):
    """Use Dijkstra to find the next optimal turn."""
    current_node = route_state['current_node']
    current_bearing = route_state['current_bearing']
    current_street = route_state['current_street']

    try:
        path = nx.shortest_path(G, current_node, end_node, weight='length')
    except nx.NetworkXNoPath:
        return None

    if len(path) < 2:
        return None

    # Build edge sequence from path
    path_edges = []
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        key = _best_edge_key(G, u, v)
        path_edges.append(_make_edge(G, u, v, key))

    walk_street = current_street
    prev_bearing = current_bearing

    for i, edge in enumerate(path_edges):
        if match_street_name(walk_street, edge['street_name']):
            prev_bearing = edge['entry_bearing']
            continue

        turn_dir = classify_turn(prev_bearing, edge['bearing'])

        if turn_dir == 'S':
            # Check if it's a name change
            turn_node = path_edges[i - 1]['v'] if i > 0 else current_node
            node_edges = _edges_from_node(G, turn_node)
            traversed = {pe['v'] for pe in path_edges[:i]}
            same_name_forward = [
                e for e in node_edges
                if match_street_name(walk_street, e['street_name'])
                and e['v'] not in traversed
                and classify_turn(prev_bearing, e['bearing']) != 'U'
            ]
            if not same_name_forward:
                walk_street = edge['street_name']
                prev_bearing = edge['entry_bearing']
                continue

        if turn_dir == 'U':
            prev_bearing = edge['entry_bearing']
            walk_street = edge['street_name']
            continue

        # Real turn
        return {
            'direction': turn_dir,
            'street_name': edge['street_name'],
        }

    return None


# ---------------------------------------------------------------------------
# Optimal route computation
# ---------------------------------------------------------------------------

def compute_optimal_route(G, start_node, end_node):
    """Compute the optimal Dijkstra route and generate a cuesheet."""
    try:
        path = nx.shortest_path(G, start_node, end_node, weight='length')
    except nx.NetworkXNoPath:
        return None

    if len(path) < 2:
        return None

    path_edges = []
    total_distance = 0
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        key = _best_edge_key(G, u, v)
        edge = _make_edge(G, u, v, key)
        path_edges.append(edge)
        total_distance += edge['distance']

    coordinates = _edges_to_coords(path_edges)

    # Generate cuesheet
    cues = []
    if path_edges:
        cues.append({'direction': None, 'street_name': path_edges[0]['street_name']})
        current_street = path_edges[0]['street_name']
        last_bearing = path_edges[0]['entry_bearing']

        for i in range(1, len(path_edges)):
            edge = path_edges[i]
            if not match_street_name(current_street, edge['street_name']):
                turn = classify_turn(last_bearing, edge['bearing'])
                cues.append({'direction': turn, 'street_name': edge['street_name']})
                current_street = edge['street_name']
            last_bearing = edge['entry_bearing']

    return {
        'coordinates': coordinates,
        'cues': cues,
        'total_distance': total_distance,
    }


# ---------------------------------------------------------------------------
# Continuation coordinates (dashed preview)
# ---------------------------------------------------------------------------

def get_continuation_coords(G, route_state, end_node):
    """Get the dashed continuation line coordinates."""
    current_node = route_state['current_node']
    current_bearing = route_state['current_bearing']
    current_street = route_state['current_street']
    confirmed_count = route_state.get('confirmed_edge_count', 0)
    edges = route_state['edges']

    unconfirmed_edges = edges[confirmed_count:]

    if route_state.get('reached_end') and route_state.get('end_edges'):
        dashed_edges = unconfirmed_edges + route_state['end_edges']
    else:
        further = _get_full_street_continuation(
            G, current_node, current_street, current_bearing
        )
        dashed_edges = unconfirmed_edges + further

    if dashed_edges:
        return _edges_to_coords(dashed_edges)
    return []
