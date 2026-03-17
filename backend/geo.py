"""Bearing calculations and turn classification utilities."""

import math


def calculate_bearing(lat1, lng1, lat2, lng2):
    """Compute compass bearing from point 1 to point 2 in degrees (0-360)."""
    to_rad = math.radians
    d_lng = to_rad(lng2 - lng1)
    y = math.sin(d_lng) * math.cos(to_rad(lat2))
    x = (math.cos(to_rad(lat1)) * math.sin(to_rad(lat2)) -
         math.sin(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.cos(d_lng))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def classify_turn(incoming_bearing, outgoing_bearing):
    """Classify turn direction given incoming and outgoing bearings.

    Returns: 'L', 'R', 'S', or 'U'
    """
    delta = outgoing_bearing - incoming_bearing
    while delta > 180:
        delta -= 360
    while delta < -180:
        delta += 360

    if abs(delta) > 170:
        return 'U'
    if delta >= 45:
        return 'R'
    if delta <= -45:
        return 'L'
    return 'S'


def distance_meters(lat1, lng1, lat2, lng2):
    """Haversine distance in meters between two points."""
    R = 6371000
    to_rad = math.radians
    dlat = to_rad(lat2 - lat1)
    dlng = to_rad(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) *
         math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def edge_exit_bearing(G, u, v, key=0):
    """Get the bearing leaving node u along edge (u, v, key).

    Uses the first two points of the edge geometry for accuracy on curved roads.
    """
    data = G[u][v][key]
    if 'geometry' in data:
        coords = list(data['geometry'].coords)
    else:
        coords = [(G.nodes[u]['x'], G.nodes[u]['y']),
                   (G.nodes[v]['x'], G.nodes[v]['y'])]
    lon1, lat1 = coords[0]
    lon2, lat2 = coords[1]
    return calculate_bearing(lat1, lon1, lat2, lon2)


def edge_entry_bearing(G, u, v, key=0):
    """Get the bearing arriving at node v along edge (u, v, key).

    Uses the last two points of the edge geometry for accuracy on curved roads.
    """
    data = G[u][v][key]
    if 'geometry' in data:
        coords = list(data['geometry'].coords)
    else:
        coords = [(G.nodes[u]['x'], G.nodes[u]['y']),
                   (G.nodes[v]['x'], G.nodes[v]['y'])]
    lon1, lat1 = coords[-2]
    lon2, lat2 = coords[-1]
    return calculate_bearing(lat1, lon1, lat2, lon2)


def edge_coordinates(G, u, v, key=0):
    """Get the full coordinate path of an edge as [[lng, lat], ...]."""
    data = G[u][v][key]
    if 'geometry' in data:
        return [[c[0], c[1]] for c in data['geometry'].coords]
    else:
        return [[G.nodes[u]['x'], G.nodes[u]['y']],
                [G.nodes[v]['x'], G.nodes[v]['y']]]


def get_edge_name(G, u, v, key=0):
    """Get the street name for an edge, handling OSMnx's list-type names."""
    data = G[u][v][key]
    name = data.get('name', None)
    if isinstance(name, list):
        return name[0] if name else None
    return name


def get_edge_highway(G, u, v, key=0):
    """Get the highway classification for an edge."""
    data = G[u][v][key]
    hw = data.get('highway', 'residential')
    if isinstance(hw, list):
        return hw[0] if hw else 'residential'
    return hw


def classify_highway(highway):
    """Classify highway type into game categories."""
    if highway in ('motorway', 'motorway_link', 'trunk', 'trunk_link',
                   'primary', 'primary_link'):
        return 'major'
    if highway in ('secondary', 'secondary_link'):
        return 'primary'
    if highway in ('tertiary', 'tertiary_link'):
        return 'secondary'
    return 'residential'


def normalize_street_name(name):
    """Normalize street name for fuzzy matching."""
    if not name:
        return ''
    s = name.lower().strip()
    replacements = [
        ('avenue', 'ave'), ('street', 'st'), ('boulevard', 'blvd'),
        ('drive', 'dr'), ('road', 'rd'), ('lane', 'ln'), ('court', 'ct'),
        ('place', 'pl'), ('terrace', 'ter'), ('circle', 'cir'),
        ('highway', 'hwy'), ('parkway', 'pkwy'), ('way', 'way'),
        ('north', 'n'), ('south', 's'), ('east', 'e'), ('west', 'w'),
        ('northeast', 'ne'), ('northwest', 'nw'),
        ('southeast', 'se'), ('southwest', 'sw'),
    ]
    for full, abbr in replacements:
        s = s.replace(full, abbr)
    s = s.replace('.', '').replace(',', '')
    return ' '.join(s.split())


def match_street_name(input_name, edge_name):
    """Check if two street names match (case-insensitive + normalized)."""
    if not input_name or not edge_name:
        return False
    if input_name.lower() == edge_name.lower():
        return True
    return normalize_street_name(input_name) == normalize_street_name(edge_name)
