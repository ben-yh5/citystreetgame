# Generating Turn-by-Turn Cuesheets with OSMnx and NetworkX

## 1. Getting a Routable Graph

OSMnx downloads OpenStreetMap data and builds a NetworkX `MultiDiGraph` where edges are directed road segments. The key is to request a graph that already respects one-way streets and driving restrictions:

```python
import osmnx as ox

# This gives you a directed graph filtered for driving
G = ox.graph_from_place("Seattle, WA, USA", network_type="drive")
```

The `network_type="drive"` filter does the heavy lifting — it excludes pedestrian paths, cycleways, and service roads, and it respects `oneway` tags. OSMnx converts two-way streets into pairs of directed edges (one per direction) and keeps one-way streets as a single directed edge. So by only following edge directions, you're already obeying one-way rules.

## 2. Routing with Shortest Path

```python
orig = ox.nearest_nodes(G, X=orig_lon, Y=orig_lat)
dest = ox.nearest_nodes(G, X=dest_lon, Y=dest_lat)

route = ox.shortest_path(G, orig, dest, weight="length")
# route is a list of node IDs
```

Because the graph is directed, `shortest_path` (which wraps Dijkstra or A*) will never route you the wrong way down a one-way street — those edges simply don't exist in that direction.

## 3. Computing Turn Angles (the Core of Cuesheet Generation)

At each intermediate node in the route, you need to determine the turn direction. This means computing the **bearing change** between the incoming edge and the outgoing edge.

```python
import numpy as np

def bearing(lat1, lon1, lat2, lon2):
    """Compute compass bearing from point 1 to point 2 in degrees."""
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlon = lon2 - lon1
    x = np.sin(dlon) * np.cos(lat2)
    y = np.cos(lat1) * np.sin(lat2) - np.sin(lat1) * np.cos(lat2) * np.cos(dlon)
    return (np.degrees(np.arctan2(x, y)) + 360) % 360

def turn_direction(bearing_in, bearing_out):
    """
    Compute the turn type from the difference in bearings.
    bearing_in is the direction you ARRIVED from, so we flip it
    to get the direction you were TRAVELING.
    """
    # The "approach bearing" is what direction you're facing when you arrive
    approach = (bearing_in + 180) % 360  # flip: you came FROM that bearing
    delta = (bearing_out - approach + 360) % 360

    # Map 0-360 degree delta to left/straight/right
    if delta < 30 or delta > 330:
        return "straight"
    elif 30 <= delta <= 180:
        return "right"
    else:
        return "left"
```

**Important subtlety**: OSMnx edges have a `geometry` attribute (a Shapely LineString) when the road curves. Don't just use the start/end node coordinates — use the last few points of the incoming geometry and the first few points of the outgoing geometry to get accurate bearings at the junction:

```python
def get_edge_bearings(G, u, v, key=0):
    """Get the bearing of the LAST segment of an edge (approach bearing)."""
    edge_data = G[u][v][key]
    if "geometry" in edge_data:
        coords = list(edge_data["geometry"].coords)
    else:
        coords = [
            (G.nodes[u]["x"], G.nodes[u]["y"]),
            (G.nodes[v]["x"], G.nodes[v]["y"]),
        ]
    # Last two points give the bearing at the destination end
    lon1, lat1 = coords[-2]
    lon2, lat2 = coords[-1]
    return bearing(lat1, lon1, lat2, lon2)
```

## 4. Building the Cuesheet

```python
def generate_cuesheet(G, route):
    cues = []
    for i in range(1, len(route) - 1):
        prev, curr, nxt = route[i - 1], route[i], route[i + 1]

        # Bearing arriving at curr
        b_in = get_edge_bearings(G, prev, curr)
        # Bearing leaving curr
        # For outgoing, use the FIRST segment of the edge
        edge_data = G[curr][nxt][0]
        if "geometry" in edge_data:
            coords = list(edge_data["geometry"].coords)
        else:
            coords = [
                (G.nodes[curr]["x"], G.nodes[curr]["y"]),
                (G.nodes[nxt]["x"], G.nodes[nxt]["y"]),
            ]
        lon1, lat1 = coords[0]
        lon2, lat2 = coords[1]
        b_out = bearing(lat1, lon1, lat2, lon2)

        direction = turn_direction(b_in, b_out)

        # Get road name from edge attributes
        road_name = G[curr][nxt][0].get("name", "unnamed road")
        prev_road = G[prev][curr][0].get("name", "unnamed road")

        # Only emit a cue when something changes
        if direction != "straight" or road_name != prev_road:
            dist = G[prev][curr][0].get("length", 0)
            cues.append({
                "direction": direction,
                "onto": road_name,
                "distance_m": dist,
            })

    return cues
```

## 5. Handling Special Road Features

### One-way streets

Already handled. The directed graph won't let you route against traffic.

### Barriers / access restrictions

OSMnx respects `access=no` and `barrier` tags when you use `network_type="drive"`. Nodes or edges that are impassable to cars are excluded from the graph. If you need finer control, you can post-filter:

```python
# Remove edges with specific access restrictions
edges_to_remove = [
    (u, v, k) for u, v, k, d in G.edges(keys=True, data=True)
    if d.get("access") in ("no", "private")
]
G.remove_edges_from(edges_to_remove)
```

### Traffic circles / roundabouts

OSM tags these with `junction=roundabout`. They appear in the graph as a sequence of short one-way edges forming a loop. The routing algorithm naturally follows them in the correct direction. For the cuesheet, you can detect them and emit a cleaner instruction:

```python
def is_roundabout(G, node1, node2):
    return G[node1][node2][0].get("junction") == "roundabout"

# In your cuesheet generator, when you detect a sequence of
# roundabout edges, collapse them into a single instruction:
# "Enter roundabout, take the 2nd exit onto Main St"
```

You count exits by counting outgoing edges at each roundabout node that lead to a non-roundabout edge.

## 6. Fork Behavior

Forks are where a node has multiple outgoing edges that all go roughly "forward" (none is a sharp turn). The right behavior with only three direction labels:

- **Compute bearings to all outgoing edges at the fork node.** The route already picked one — you just need to describe it relative to the alternatives.
- **If the route follows the road that continues most straight**, call it "straight." If two roads diverge roughly symmetrically, the one more to the left is "left" and the one more to the right is "right." Even if neither is a full 90° turn, the relative classification tells the driver which fork to take.
- **A practical threshold scheme**: at a two-way fork, compute the bisector angle between the two options. The one to the left of the bisector is "left," and the one to the right is "right." If there are three options, the middle one is "straight."

```python
def classify_fork(G, prev_node, curr_node, next_node):
    """At a fork, classify direction relative to other options."""
    b_in = get_edge_bearings(G, prev_node, curr_node)
    approach = (b_in + 180) % 360

    # Get bearings to ALL successors (not just the chosen one)
    successors = list(G.successors(curr_node))
    if len(successors) <= 2:
        # Simple turn, use standard logic
        return turn_direction(b_in, ...)

    # Compute deltas for all options
    options = []
    for s in successors:
        edge_data = G[curr_node][s][0]
        # ... compute b_out for this edge ...
        delta = (b_out - approach + 360) % 360
        options.append((s, delta))

    # Sort by delta (clockwise from straight ahead)
    options.sort(key=lambda x: x[1])

    # Find where next_node falls in the sorted list
    # Leftmost option = "left", rightmost = "right", middle = "straight"
```

## Summary of the Pipeline

1. `ox.graph_from_place(..., network_type="drive")` gives you a directed, driving-legal graph
2. `ox.shortest_path()` routes without violating one-way or access rules
3. At each node in the route, compute bearing change using edge geometries (not just node positions)
4. Map bearing deltas to left/straight/right with thresholds (~30° dead zone for "straight")
5. Detect roundabouts via `junction=roundabout` and collapse into "take Nth exit" instructions
6. At forks, classify the chosen edge relative to the other options rather than in absolute terms

The main pitfall people hit is using node-to-node bearings instead of the actual edge geometry — curved roads will give wildly wrong turn directions if you ignore the intermediate points.