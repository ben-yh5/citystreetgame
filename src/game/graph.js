import { state } from '../state.js';
import { calculateDistanceMeters } from '../utils/geo.js';

// --- BEARING UTILITIES ---

export function calculateBearing(lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);

    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function classifyTurn(incomingBearing, outgoingBearing) {
    // Incoming bearing is the direction you're traveling.
    // We need to compare outgoing to the forward direction (incoming).
    let delta = outgoingBearing - incomingBearing;
    // Normalize to -180..180
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;

    if (Math.abs(delta) > 170) return 'U';
    if (delta >= 45) return 'R';
    if (delta <= -45) return 'L';
    return 'S';
}

function coordKey(coord) {
    // coord is [lng, lat]
    return `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
}

const NODE_MERGE_DISTANCE = 15; // meters — merge nodes within this distance (roundabouts, complex intersections)

// --- GRAPH CONSTRUCTION ---

export function buildStreetGraph() {
    if (!state.streetSegmentsData || state.streetSegmentsData.size === 0) return null;

    // Step 1: Map every coordinate to the street names that pass through it
    const coordStreets = new Map(); // coordKey -> Set<streetName>
    const coordLatLng = new Map(); // coordKey -> { lat, lng }

    state.streetSegmentsData.forEach((segments, streetName) => {
        segments.forEach(segment => {
            segment.coordinates.forEach(coord => {
                const key = coordKey(coord);
                if (!coordStreets.has(key)) {
                    coordStreets.set(key, new Set());
                    coordLatLng.set(key, { lat: coord[1], lng: coord[0] });
                }
                coordStreets.get(key).add(streetName);
            });
        });
    });

    // Add roundabout coordinates — marks named street endpoints at roundabouts
    // as intersections (2+ names) so they get detected and merged
    const ROUNDABOUT_PSEUDO = '__roundabout__';
    if (state.roundaboutCoords) {
        for (const rKey of state.roundaboutCoords) {
            if (coordStreets.has(rKey)) {
                coordStreets.get(rKey).add(ROUNDABOUT_PSEUDO);
            }
        }
    }

    // Step 2: Find intersection nodes (coords with 2+ different street names)
    // Also include segment endpoints as potential nodes
    const intersectionNodes = new Map(); // coordKey -> { lat, lng, streets: Set }
    const endpointNodes = new Set(); // coordKeys that are segment endpoints

    // Mark all segment endpoints
    state.streetSegmentsData.forEach((segments, streetName) => {
        segments.forEach(segment => {
            const coords = segment.coordinates;
            if (coords.length >= 2) {
                endpointNodes.add(coordKey(coords[0]));
                endpointNodes.add(coordKey(coords[coords.length - 1]));
            }
        });
    });

    // Identify intersection nodes: 2+ streets OR endpoint connected to other streets
    coordStreets.forEach((streets, key) => {
        if (streets.size >= 2) {
            const pos = coordLatLng.get(key);
            intersectionNodes.set(key, { lat: pos.lat, lng: pos.lng, streets: new Set(streets) });
        }
    });

    // Also add endpoints that connect segments of the same street (where OSM ways join)
    // These are needed so edges don't span across multiple OSM ways incorrectly
    endpointNodes.forEach(key => {
        if (!intersectionNodes.has(key) && coordStreets.has(key)) {
            const streets = coordStreets.get(key);
            const pos = coordLatLng.get(key);
            // Only add if this endpoint is also an endpoint of another segment
            // (i.e., it connects two OSM ways)
            intersectionNodes.set(key, { lat: pos.lat, lng: pos.lng, streets: new Set(streets) });
        }
    });

    // Step 3: Merge nearby nodes (handles roundabouts, complex intersections)
    const mergedNodes = mergeNearbyNodes(intersectionNodes);

    // Step 4: Build edges
    const edges = new Map(); // nodeId -> [{targetNode, streetName, distance, bearing, entryBearing, coordinates}]

    // Initialize edge lists
    mergedNodes.forEach((_, nodeId) => {
        edges.set(nodeId, []);
    });

    // Create a mapping from original coordKey to merged nodeId
    const coordToMergedNode = new Map();
    mergedNodes.forEach((nodeData, nodeId) => {
        if (nodeData.originalKeys) {
            nodeData.originalKeys.forEach(origKey => {
                coordToMergedNode.set(origKey, nodeId);
            });
        } else {
            coordToMergedNode.set(nodeId, nodeId);
        }
    });

    // For each segment, walk coordinates and create edges between consecutive intersection nodes
    state.streetSegmentsData.forEach((segments, streetName) => {
        segments.forEach(segment => {
            const coords = segment.coordinates;
            if (coords.length < 2) return;

            let lastNodeId = null;
            let edgeCoords = [];
            let edgeDistance = 0;

            for (let i = 0; i < coords.length; i++) {
                const key = coordKey(coords[i]);
                const mergedNodeId = coordToMergedNode.get(key);

                if (i > 0) {
                    edgeDistance += calculateDistanceMeters(
                        coords[i - 1][1], coords[i - 1][0],
                        coords[i][1], coords[i][0]
                    );
                }

                edgeCoords.push(coords[i]);

                if (mergedNodeId && mergedNodes.has(mergedNodeId)) {
                    // This is an intersection node
                    if (lastNodeId !== null && lastNodeId !== mergedNodeId && edgeCoords.length >= 2 && edgeDistance > 0) {
                        // Create edge from lastNodeId to this node
                        const exitBearing = calculateBearing(
                            edgeCoords[0][1], edgeCoords[0][0],
                            edgeCoords[1][1], edgeCoords[1][0]
                        );
                        const entryBearing = calculateBearing(
                            edgeCoords[edgeCoords.length - 2][1], edgeCoords[edgeCoords.length - 2][0],
                            edgeCoords[edgeCoords.length - 1][1], edgeCoords[edgeCoords.length - 1][0]
                        );

                        // Add forward edge (always — coordinates already reflect oneway=-1 reversal)
                        addEdge(edges, lastNodeId, mergedNodeId, streetName, edgeDistance, exitBearing, entryBearing, [...edgeCoords]);

                        // Add reverse edge only if not one-way
                        if (!segment.oneway) {
                            const reverseCoords = [...edgeCoords].reverse();
                            const reverseExitBearing = calculateBearing(
                                reverseCoords[0][1], reverseCoords[0][0],
                                reverseCoords[1][1], reverseCoords[1][0]
                            );
                            const reverseEntryBearing = calculateBearing(
                                reverseCoords[reverseCoords.length - 2][1], reverseCoords[reverseCoords.length - 2][0],
                                reverseCoords[reverseCoords.length - 1][1], reverseCoords[reverseCoords.length - 1][0]
                            );
                            addEdge(edges, mergedNodeId, lastNodeId, streetName, edgeDistance, reverseExitBearing, reverseEntryBearing, reverseCoords);
                        }
                    }

                    lastNodeId = mergedNodeId;
                    edgeCoords = [coords[i]];
                    edgeDistance = 0;
                }
            }
        });
    });

    // Remove nodes with no edges (dead ends that didn't connect)
    const connectedNodes = new Map();
    mergedNodes.forEach((nodeData, nodeId) => {
        if (edges.has(nodeId) && edges.get(nodeId).length > 0) {
            connectedNodes.set(nodeId, nodeData);
        }
    });

    const graph = { nodes: connectedNodes, edges };
    state.streetGraph = graph;
    console.log(`Built street graph: ${connectedNodes.size} nodes, ${[...edges.values()].reduce((s, e) => s + e.length, 0)} edges`);
    return graph;
}

function addEdge(edges, fromId, toId, streetName, distance, bearing, entryBearing, coordinates) {
    if (!edges.has(fromId)) edges.set(fromId, []);

    // Check for duplicate edge (same target and same street)
    const existing = edges.get(fromId);
    const isDup = existing.some(e =>
        e.targetNode === toId && e.streetName === streetName && Math.abs(e.distance - distance) < 1
    );
    if (isDup) return;

    existing.push({
        targetNode: toId,
        streetName,
        distance,
        bearing,
        entryBearing,
        coordinates
    });
}

function mergeNearbyNodes(nodes) {
    const merged = new Map();
    const nodeList = [...nodes.entries()];
    const consumed = new Set();

    for (let i = 0; i < nodeList.length; i++) {
        if (consumed.has(nodeList[i][0])) continue;

        const [key1, data1] = nodeList[i];
        const cluster = [key1];
        const clusterStreets = new Set(data1.streets);
        let sumLat = data1.lat;
        let sumLng = data1.lng;

        for (let j = i + 1; j < nodeList.length; j++) {
            if (consumed.has(nodeList[j][0])) continue;

            const [key2, data2] = nodeList[j];
            const dist = calculateDistanceMeters(data1.lat, data1.lng, data2.lat, data2.lng);

            if (dist <= NODE_MERGE_DISTANCE) {
                // Don't merge nodes that share a real street name — they're likely
                // parallel segments (divided highway, viaduct, interchange ramps).
                // Skip the roundabout pseudo-name so roundabout nodes can merge.
                let sharesStreet = false;
                for (const s of data2.streets) {
                    if (s === '__roundabout__') continue;
                    if (clusterStreets.has(s)) { sharesStreet = true; break; }
                }
                if (sharesStreet) continue;

                cluster.push(key2);
                data2.streets.forEach(s => clusterStreets.add(s));
                sumLat += data2.lat;
                sumLng += data2.lng;
                consumed.add(key2);
            }
        }

        consumed.add(key1);

        // Use centroid as the merged node position
        const mergedLat = sumLat / cluster.length;
        const mergedLng = sumLng / cluster.length;
        const mergedKey = cluster.length === 1 ? key1 : coordKey([mergedLng, mergedLat]);

        merged.set(mergedKey, {
            lat: mergedLat,
            lng: mergedLng,
            streets: clusterStreets,
            originalKeys: cluster
        });
    }

    return merged;
}

// --- DIJKSTRA ---

export function findShortestPath(startNodeId, endNodeId) {
    const graph = state.streetGraph;
    if (!graph) return null;

    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    // Priority queue using a simple sorted array (sufficient for our graph sizes)
    const queue = [];

    dist.set(startNodeId, 0);
    queue.push({ nodeId: startNodeId, distance: 0 });

    while (queue.length > 0) {
        // Get node with smallest distance
        queue.sort((a, b) => a.distance - b.distance);
        const { nodeId: current } = queue.shift();

        if (visited.has(current)) continue;
        visited.add(current);

        if (current === endNodeId) break;

        const neighbors = graph.edges.get(current) || [];
        for (const edge of neighbors) {
            if (visited.has(edge.targetNode)) continue;

            const newDist = dist.get(current) + edge.distance;
            if (!dist.has(edge.targetNode) || newDist < dist.get(edge.targetNode)) {
                dist.set(edge.targetNode, newDist);
                prev.set(edge.targetNode, current);
                prevEdge.set(edge.targetNode, edge);
                queue.push({ nodeId: edge.targetNode, distance: newDist });
            }
        }
    }

    if (!dist.has(endNodeId)) return null;

    // Reconstruct path
    const path = [];
    const pathEdges = [];
    let current = endNodeId;

    while (current !== startNodeId) {
        path.unshift(current);
        if (prevEdge.has(current)) {
            pathEdges.unshift(prevEdge.get(current));
        }
        current = prev.get(current);
        if (!current) return null;
    }
    path.unshift(startNodeId);

    return {
        path,
        edges: pathEdges,
        totalDistance: dist.get(endNodeId)
    };
}

// --- HELPERS ---

export function findClosestNode(lat, lng) {
    const graph = state.streetGraph;
    if (!graph) return null;

    let closestId = null;
    let closestDist = Infinity;

    graph.nodes.forEach((nodeData, nodeId) => {
        const d = calculateDistanceMeters(lat, lng, nodeData.lat, nodeData.lng);
        if (d < closestDist) {
            closestDist = d;
            closestId = nodeId;
        }
    });

    return closestId;
}

export function getNodeStreetNames(nodeId) {
    const graph = state.streetGraph;
    if (!graph || !graph.nodes.has(nodeId)) return [];

    return [...graph.nodes.get(nodeId).streets].filter(s => s !== '__roundabout__');
}

export function pathToCoordinates(pathEdges) {
    const coords = [];
    pathEdges.forEach((edge, i) => {
        if (i === 0) {
            coords.push(...edge.coordinates);
        } else {
            // Skip the first coord (it's the same as the last coord of the previous edge)
            coords.push(...edge.coordinates.slice(1));
        }
    });
    return coords;
}

export function pathToCuesheet(pathEdges) {
    const cues = [];
    if (pathEdges.length === 0) return cues;

    // First cue: just the starting street name
    cues.push({ direction: null, streetName: pathEdges[0].streetName });

    let currentStreet = pathEdges[0].streetName;
    let lastBearing = pathEdges[0].entryBearing;

    for (let i = 1; i < pathEdges.length; i++) {
        const edge = pathEdges[i];
        if (edge.streetName !== currentStreet) {
            const turn = classifyTurn(lastBearing, edge.bearing);
            cues.push({ direction: turn, streetName: edge.streetName });
            currentStreet = edge.streetName;
        }
        lastBearing = edge.entryBearing;
    }

    return cues;
}
