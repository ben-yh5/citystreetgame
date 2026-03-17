/**
 * API client for the Python backend (FastAPI + OSMnx + NetworkX).
 */

const API_BASE = import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/api`
    : '/api';

async function post(path, body = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || `API error ${response.status}`);
    }
    return response.json();
}

export async function loadCity(boundaries) {
    const center = getBoundaryCenter(boundaries);
    return post('/city/load', {
        boundaries,
        lat: center[1],
        lon: center[0],
    });
}

export async function getClosestNode(cityId, lat, lng) {
    return post('/graph/closest-node', { city_id: cityId, lat, lng });
}

export async function getShortestPath(cityId, startNode, endNode) {
    return post('/graph/shortest-path', {
        city_id: cityId,
        start_node: startNode,
        end_node: endNode,
    });
}

export async function generateChallenge(cityId, difficulty, startNode = null, endNode = null) {
    const body = { city_id: cityId, difficulty };
    if (startNode != null) body.start_node = startNode;
    if (endNode != null) body.end_node = endNode;
    return post('/cuesheet/challenge', body);
}

export async function validateCue(routeId, direction, streetName) {
    return post('/cuesheet/validate-cue', {
        route_id: routeId,
        direction,
        street_name: streetName,
    });
}

export async function undoCue(routeId, cueCount) {
    return post('/cuesheet/undo', {
        route_id: routeId,
        cue_count: cueCount,
    });
}

export async function getHint(routeId) {
    return post('/cuesheet/hint', { route_id: routeId });
}

export async function getOptimalRoute(cityId, startNode, endNode) {
    return post('/cuesheet/optimal-route', {
        city_id: cityId,
        start_node: startNode,
        end_node: endNode,
    });
}

export async function generateIntersectionChallenge(cityId, difficulty) {
    return post('/intersections/challenge', {
        city_id: cityId,
        difficulty,
    });
}

function getBoundaryCenter(boundaries) {
    let coords;
    if (boundaries.type === 'Polygon') {
        coords = boundaries.coordinates[0];
    } else if (boundaries.type === 'MultiPolygon') {
        coords = boundaries.coordinates[0][0];
    } else {
        return [0, 0];
    }
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    return [
        (Math.min(...lngs) + Math.max(...lngs)) / 2,
        (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
}
