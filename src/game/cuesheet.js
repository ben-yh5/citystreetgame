import { state } from '../state.js';
import {
    buildStreetGraph,
    findShortestPath,
    findClosestNode,
    getNodeStreetNames,
    pathToCoordinates,
    pathToCuesheet,
    classifyTurn,
    calculateBearing,
} from './graph.js';
import { calculateDistanceMeters } from '../utils/geo.js';
import { normalizeStreetName } from '../utils/string.js';
import { showMessage, setLoadingState } from './ui.js';

// --- CHALLENGE GENERATION ---

export function generateCuesheetChallenge() {
    if (!state.streetData || state.streetData.features.length === 0) {
        updateCuesheetDisplay(null);
        return;
    }

    if (!state.streetGraph) {
        setLoadingState(true, 'Building street graph...');
        // Defer to let the loading screen render before CPU-intensive work
        setTimeout(() => {
            buildStreetGraph();
            setLoadingState(false);
            _pickAndDisplayChallenge();
        }, 50);
        return;
    }

    _pickAndDisplayChallenge();
}

function _pickAndDisplayChallenge(customChallenge = null) {
    if (!state.streetGraph || state.streetGraph.nodes.size < 2) {
        showMessage('Not enough intersection data to generate a route challenge.', 'error');
        updateCuesheetDisplay(null);
        return;
    }

    const challenge = customChallenge || pickChallengePair();
    if (!challenge) {
        showMessage('Could not find a suitable route pair. Try a different area.', 'error');
        updateCuesheetDisplay(null);
        return;
    }

    state.cuesheetChallenge = challenge;
    state.cuesheetCues = [];
    state.cuesheetResults = null;
    state._cuesheetRoute = null;

    cleanupCuesheetMapLayers();

    // Pre-compute the starting street using Dijkstra
    const initialRoute = initStartingRoute(challenge);
    if (!initialRoute) {
        showMessage('Could not determine starting route. Try skipping.', 'error');
        updateCuesheetDisplay(null);
        return;
    }
    state._cuesheetRoute = initialRoute;

    // Insert implicit cues for starting street name changes
    if (initialRoute.nameChanges && initialRoute.nameChanges.length > 0) {
        for (const nc of initialRoute.nameChanges) {
            state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
        }
    }

    updateCuesheetDisplay(challenge);
    renderCueList();
    resetCueInput();

    addEndpointMarkers(challenge);
    drawLiveRoute(true);
}

function getStreetCategory(streetName) {
    const segments = state.streetSegmentsData.get(streetName);
    if (!segments) return 'local';
    const isMajor = segments.some(s => ['major', 'primary', 'secondary', 'tertiary'].includes(s.type));
    return isMajor ? 'major' : 'local';
}

function nodeMatchesDifficulty(nodeId) {
    const graph = state.streetGraph;
    const edges = graph.edges.get(nodeId) || [];

    // Get unique street names and their categories
    const streetCategories = new Map();
    edges.forEach(e => {
        if (!streetCategories.has(e.streetName)) {
            streetCategories.set(e.streetName, getStreetCategory(e.streetName));
        }
    });

    const majorCount = [...streetCategories.values()].filter(c => c === 'major').length;

    switch (state.intersectionDifficulty) {
        case 'major-major':
            return majorCount >= 2;
        case 'major-all':
            return majorCount >= 1;
        case 'all-all':
            return streetCategories.size >= 2;
        default:
            return false;
    }
}

function pickChallengePair() {
    const graph = state.streetGraph;
    const nodeIds = [...graph.nodes.keys()];

    const majorNodes = nodeIds.filter(id => {
        const edges = graph.edges.get(id) || [];
        if (edges.length < 2) return false;
        return nodeMatchesDifficulty(id);
    });

    if (majorNodes.length < 2) return null;

    for (let attempt = 0; attempt < 50; attempt++) {
        const i1 = Math.floor(Math.random() * majorNodes.length);
        let i2 = Math.floor(Math.random() * majorNodes.length);
        if (i1 === i2) continue;

        const startId = majorNodes[i1];
        const endId = majorNodes[i2];
        const startNode = graph.nodes.get(startId);
        const endNode = graph.nodes.get(endId);

        const path = findShortestPath(startId, endId);
        if (!path) continue;

        const startStreets = pickDisplayStreets(startId);
        const endStreets = pickDisplayStreets(endId);

        return {
            startNode: startId,
            endNode: endId,
            startStreets,
            endStreets,
            startLat: startNode.lat,
            startLng: startNode.lng,
            endLat: endNode.lat,
            endLng: endNode.lng,
        };
    }

    return null;
}

function pickDisplayStreets(nodeId) {
    const graph = state.streetGraph;
    const edges = graph.edges.get(nodeId) || [];
    const streetEdgeCounts = new Map();
    edges.forEach(e => {
        streetEdgeCounts.set(e.streetName, (streetEdgeCounts.get(e.streetName) || 0) + 1);
    });
    return [...streetEdgeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name);
}

function initStartingRoute(challenge) {
    const graph = state.streetGraph;
    const path = findShortestPath(challenge.startNode, challenge.endNode);
    if (!path || path.edges.length === 0) return null;

    const startingStreet = path.edges[0].streetName;
    challenge.startingStreet = startingStreet;

    // Find the edge for this street heading toward destination
    const nodeEdges = graph.edges.get(challenge.startNode) || [];
    const endNode = graph.nodes.get(challenge.endNode);
    const bearingToEnd = calculateBearing(
        graph.nodes.get(challenge.startNode).lat, graph.nodes.get(challenge.startNode).lng,
        endNode.lat, endNode.lng
    );

    const matchingEdges = nodeEdges.filter(e => matchStreetName(startingStreet, e.streetName));
    if (matchingEdges.length === 0) return null;

    let bestEdge = matchingEdges[0];
    let bestScore = Infinity;
    for (const edge of matchingEdges) {
        let delta = Math.abs(edge.bearing - bearingToEnd);
        if (delta > 180) delta = 360 - delta;
        if (delta < bestScore) {
            bestScore = delta;
            bestEdge = edge;
        }
    }

    const routeEdges = [bestEdge];
    const continuation = followStreetForward(bestEdge.targetNode, startingStreet, bestEdge.entryBearing);
    routeEdges.push(...continuation.edges);

    const finalNode = continuation.edges.length > 0
        ? continuation.edges[continuation.edges.length - 1].targetNode
        : bestEdge.targetNode;
    const finalBearing = continuation.edges.length > 0
        ? continuation.edges[continuation.edges.length - 1].entryBearing
        : bestEdge.entryBearing;
    const finalStreet = continuation.streetName;

    const reachedEnd = checkReachedEnd(finalNode, finalStreet, finalBearing, routeEdges);

    return {
        currentNode: finalNode,
        currentBearing: finalBearing,
        currentStreet: finalStreet,
        edges: routeEdges,
        reachedEnd: reachedEnd.reached,
        endEdges: reachedEnd.edges,
        nameChanges: continuation.nameChanges || [],
    };
}

// --- UI ---

function updateCuesheetDisplay(challenge) {
    const fromEl = document.getElementById('cuesheet-from');
    const toEl = document.getElementById('cuesheet-to');
    if (!fromEl || !toEl) return;

    if (challenge) {
        fromEl.textContent = challenge.startStreets.join(' & ');
        toEl.textContent = challenge.endStreets.join(' & ');
    } else {
        fromEl.textContent = 'Load a city first';
        toEl.textContent = '';
    }
}

function resetCueInput() {
    const streetInput = document.getElementById('cuesheet-street-input');
    const submitBtn = document.getElementById('cuesheet-submit-btn');
    const skipBtn = document.getElementById('cuesheet-skip-btn');
    const addBtn = document.getElementById('cuesheet-add-btn');
    const hintBtn = document.getElementById('cuesheet-hint-btn');
    const cuesheetInput = document.querySelector('.cuesheet-input');

    // Always show L/R buttons and default to L
    state._selectedDirection = 'L';
    const btns = document.querySelectorAll('#cuesheet-dir-btns .dir-btn');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dir === 'L'));

    hideSuggestions();
    if (streetInput) {
        streetInput.value = '';
        streetInput.placeholder = 'Street name...';
        streetInput.focus();
    }

    if (submitBtn) {
        submitBtn.textContent = 'Check Route';
        submitBtn.disabled = false;
    }
    if (skipBtn) skipBtn.style.display = '';
    if (addBtn) addBtn.style.display = '';
    if (hintBtn) hintBtn.style.display = '';
    if (cuesheetInput) cuesheetInput.style.display = '';
}

export function selectDirection(dir) {
    state._selectedDirection = dir;
    const btns = document.querySelectorAll('#cuesheet-dir-btns .dir-btn');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dir === dir));
}

// --- CUE MANAGEMENT ---

export function addCue() {
    const streetInput = document.getElementById('cuesheet-street-input');
    if (!streetInput || !state.cuesheetChallenge) return;

    const streetName = streetInput.value.trim();
    if (!streetName) return;

    // If results are showing, don't add cues
    if (state.cuesheetResults) return;

    const direction = state._selectedDirection || 'L';

    // Try the typed name first, then fall back to first autocomplete suggestion
    let validation = validateNextCue({ direction, streetName });
    if (!validation.valid) {
        const dropdown = document.getElementById('cuesheet-suggestions');
        const firstSuggestion = dropdown?.querySelector('.cuesheet-suggestion');
        if (firstSuggestion) {
            const fallbackName = firstSuggestion.textContent;
            const fallbackValidation = validateNextCue({ direction, streetName: fallbackName });
            if (fallbackValidation.valid) {
                validation = fallbackValidation;
            }
        }
    }

    if (!validation.valid) {
        showMessage(validation.error, 'error');
        return;
    }

    // Insert pre-turn implicit cues (name changes on current street before the turn)
    if (validation.preTurnNameChanges && validation.preTurnNameChanges.length > 0) {
        for (const nc of validation.preTurnNameChanges) {
            state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
        }
    }

    // Use the actual street name from the graph edge
    const cue = { direction, streetName: validation.matchedStreetName };
    state.cuesheetCues.push(cue);

    // Insert post-turn implicit cues (name changes on new street after the turn)
    if (validation.postTurnNameChanges && validation.postTurnNameChanges.length > 0) {
        for (const nc of validation.postTurnNameChanges) {
            state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
        }
    }

    // Update the live route state
    state._cuesheetRoute = validation.route;

    // Draw the live route on the map
    drawLiveRoute();

    renderCueList();
    resetCueInput();

    // Check if route reached destination
    if (validation.route.reachedEnd) {
        showMessage('Route reaches the destination!', 'success');
    }
}

export function removeCue(index) {
    state.cuesheetCues.splice(index);  // Remove this cue and everything after it

    // Rebuild route from scratch with remaining cues
    rebuildRoute();
    renderCueList();
    resetCueInput();
}

function rebuildRoute() {
    state._cuesheetRoute = null;
    cleanupCuesheetMapLayers();

    // Filter out implicit cues — they'll be regenerated during replay
    const explicitCues = state.cuesheetCues.filter(c => !c.implicit);
    state.cuesheetCues = [];

    // Restore the initial starting route
    const challenge = state.cuesheetChallenge;
    if (!challenge) return;

    const initialRoute = initStartingRoute(challenge);
    if (!initialRoute) return;
    state._cuesheetRoute = initialRoute;

    // Insert initial name changes
    if (initialRoute.nameChanges && initialRoute.nameChanges.length > 0) {
        for (const nc of initialRoute.nameChanges) {
            state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
        }
    }

    // Replay explicit cues, regenerating implicit ones
    for (let i = 0; i < explicitCues.length; i++) {
        const cue = explicitCues[i];
        const validation = validateNextCue(cue);
        if (!validation.valid) {
            showMessage(`Removed invalid cues from "${cue.streetName}" onward`, 'error');
            break;
        }
        if (validation.preTurnNameChanges) {
            for (const nc of validation.preTurnNameChanges) {
                state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
            }
        }
        state.cuesheetCues.push(cue);
        if (validation.postTurnNameChanges) {
            for (const nc of validation.postTurnNameChanges) {
                state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
            }
        }
        state._cuesheetRoute = validation.route;
    }

    addEndpointMarkers(challenge);
    drawLiveRoute();
}

// --- LIVE VALIDATION ---

function matchStreetName(inputName, edgeStreetName) {
    if (inputName.toLowerCase() === edgeStreetName.toLowerCase()) return true;
    if (normalizeStreetName(inputName) === normalizeStreetName(edgeStreetName)) return true;
    return false;
}

// Check for a street name change: the road continues straight but under a different name
// (e.g., at a bridge or city boundary). Returns the edge if found, null otherwise.
function findNameChangeEdge(nodeEdges, currentStreetName, currentBearing, visited) {
    const allForward = nodeEdges.filter(e => {
        if (visited.has(e.targetNode)) return false;
        return classifyTurn(currentBearing, e.bearing) === 'S';
    });
    // Only treat as name change if exactly one straight-ahead edge and it's a different name
    if (allForward.length === 1 && !matchStreetName(currentStreetName, allForward[0].streetName)) {
        return allForward[0];
    }
    return null;
}

// When multiple same-name edges continue forward (parallel roads merging/diverging),
// pick the one most aligned with our current bearing to stay on the same physical road.
function pickStraightest(edges, currentBearing) {
    if (edges.length <= 1) return edges[0] || null;
    return edges.reduce((best, e) => {
        let deltaBest = Math.abs(currentBearing - best.bearing);
        if (deltaBest > 180) deltaBest = 360 - deltaBest;
        let deltaE = Math.abs(currentBearing - e.bearing);
        if (deltaE > 180) deltaE = 360 - deltaE;
        return deltaE < deltaBest ? e : best;
    });
}

function validateNextCue(cue) {
    const graph = state.streetGraph;
    const challenge = state.cuesheetChallenge;
    if (!graph || !challenge) return { valid: false, error: 'No challenge active' };
    if (!state._cuesheetRoute) return { valid: false, error: 'No route state' };

    const currentNode = state._cuesheetRoute.currentNode;
    const currentBearing = state._cuesheetRoute.currentBearing;
    const routeEdges = [...state._cuesheetRoute.edges];

    // Search forward along the current street for the target street.
    // Pass direction so divided streets (separate carriageway nodes) find the correct one.
    const currentStreet = state._cuesheetRoute.currentStreet;
    const searchResult = findTurnStreetAhead(currentNode, currentStreet, currentBearing, cue.streetName, cue.direction);

    if (!searchResult) {
        // Check if the street exists but with wrong direction (for better error message)
        const anyResult = findTurnStreetAhead(currentNode, currentStreet, currentBearing, cue.streetName);
        if (anyResult) {
            const dirName = d => d === 'L' ? 'left' : d === 'R' ? 'right' : d === 'S' ? 'straight' : 'U-turn';
            const turnEdges = graph.edges.get(anyResult.node) || [];
            const dirMatches = turnEdges.filter(e => matchStreetName(cue.streetName, e.streetName));
            const actualDirs = dirMatches.map(e => classifyTurn(anyResult.bearing, e.bearing));
            const hint = actualDirs.length > 0 ? `(it's ${dirName(actualDirs[0])})` : '';
            return { valid: false, error: `"${cue.streetName}" is not ${dirName(cue.direction)} ${hint}` };
        }
        return { valid: false, error: `"${cue.streetName}" is not reachable along ${currentStreet || 'the current street'}` };
    }

    // Pre-turn name changes (current street changed names while walking to the turn)
    const preTurnNameChanges = searchResult.nameChanges || [];

    // Add transit edges (continuing on current street to reach the turn)
    routeEdges.push(...searchResult.transitEdges);

    const turnNodeEdges = graph.edges.get(searchResult.node) || [];
    const directMatches = turnNodeEdges.filter(e => matchStreetName(cue.streetName, e.streetName));

    // Check turn direction matches
    const chosenEdge = pickEdgeByDirection(directMatches, searchResult.bearing, cue.direction);
    if (!chosenEdge) {
        const actualDirs = directMatches.map(e => classifyTurn(searchResult.bearing, e.bearing));
        const dirName = d => d === 'L' ? 'left' : d === 'R' ? 'right' : d === 'S' ? 'straight' : 'U-turn';
        const playerDir = dirName(cue.direction);
        const hint = actualDirs.length > 0 ? `(it's ${dirName(actualDirs[0])})` : '';
        return { valid: false, error: `"${cue.streetName}" is not ${playerDir} ${hint}` };
    }

    routeEdges.push(chosenEdge);

    const newNode = chosenEdge.targetNode;
    const newBearing = chosenEdge.entryBearing;

    // Follow the new street forward through intermediate intersections
    const continuation = followStreetForward(newNode, chosenEdge.streetName, newBearing);
    routeEdges.push(...continuation.edges);

    // Post-turn name changes (the new street changed names while following forward)
    const postTurnNameChanges = continuation.nameChanges || [];

    const finalNode = continuation.edges.length > 0
        ? continuation.edges[continuation.edges.length - 1].targetNode
        : newNode;
    const finalBearing = continuation.edges.length > 0
        ? continuation.edges[continuation.edges.length - 1].entryBearing
        : newBearing;
    // Use the street name after any name changes (e.g., bridge transitions)
    const finalStreet = continuation.streetName;

    const reachedEnd = checkReachedEnd(finalNode, finalStreet, finalBearing, routeEdges);

    return {
        valid: true,
        matchedStreetName: chosenEdge.streetName,
        preTurnNameChanges,
        postTurnNameChanges,
        route: {
            currentNode: finalNode,
            currentBearing: finalBearing,
            currentStreet: finalStreet,
            edges: routeEdges,
            reachedEnd: reachedEnd.reached,
            endEdges: reachedEnd.edges,
        }
    };
}

function pickEdgeByDirection(edges, incomingBearing, direction) {
    if (!direction || !incomingBearing) return edges[0] || null;

    // Score each edge by direction match
    const scored = [];
    for (const edge of edges) {
        const turn = classifyTurn(incomingBearing, edge.bearing);
        let score = 0;

        if (turn === direction) {
            score = 100;
        } else if (direction === 'S' && (turn === 'L' || turn === 'R')) {
            score = 50;
        } else if ((direction === 'L' || direction === 'R') && turn === 'S') {
            // Only accept S as L/R if the edge leans in the requested direction.
            // Prevents divided streets from matching the wrong carriageway.
            let delta = edge.bearing - incomingBearing;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            if ((direction === 'L' && delta < 0) || (direction === 'R' && delta > 0)) {
                score = 50;
            }
        }

        if (score > 0) scored.push({ edge, score });
    }

    if (scored.length === 0) return null;
    if (scored.length === 1) return scored[0].edge;

    // Multiple matches — prefer highest direction score first
    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0].score;
    const tied = scored.filter(s => s.score === topScore);

    if (tied.length === 1) return tied[0].edge;

    // Tiebreak: pick the edge leading to the shortest path to destination
    const endNode = state.cuesheetChallenge?.endNode;
    if (endNode) {
        let bestEdge = tied[0].edge;
        let bestDist = Infinity;
        for (const { edge } of tied) {
            const path = findShortestPath(edge.targetNode, endNode);
            const dist = path ? path.totalDistance : Infinity;
            if (dist < bestDist) {
                bestDist = dist;
                bestEdge = edge;
            }
        }
        return bestEdge;
    }

    return tied[0].edge;
}

function findTurnStreetAhead(fromNode, currentStreet, bearing, targetStreet, direction = null) {
    // Search forward along the current street for an intersection with the target street.
    // Also follows through street name changes (bridges, boundaries).
    // If direction is specified, skips nodes where the target street exists but
    // no edge matches the direction (handles divided streets with separate carriageway nodes).
    // Returns { node, bearing, transitEdges, nameChanges } or null if not found.
    const graph = state.streetGraph;
    let currentNode = fromNode;
    let currentBearing = bearing;
    let walkStreet = currentStreet;
    const visited = new Set([fromNode]);
    let transitEdges = [];
    const nameChanges = [];
    let firstWrongDir = null; // track first occurrence with wrong direction for error messages

    // First check the current node
    const nodeEdges = graph.edges.get(currentNode) || [];
    const directMatches = nodeEdges.filter(e => matchStreetName(targetStreet, e.streetName));
    if (directMatches.length > 0) {
        if (!direction || pickEdgeByDirection(directMatches, currentBearing, direction)) {
            return { node: currentNode, bearing: currentBearing, transitEdges: [], nameChanges: [] };
        }
        firstWrongDir = { node: currentNode, bearing: currentBearing, transitEdges: [], nameChanges: [] };
    }

    // Walk forward along the current street, past decision points
    for (let i = 0; i < 50; i++) {
        const edges = graph.edges.get(currentNode) || [];
        let continuations = edges.filter(e => {
            if (!matchStreetName(walkStreet, e.streetName)) return false;
            if (visited.has(e.targetNode)) return false;
            return classifyTurn(currentBearing, e.bearing) !== 'U';
        });

        // Follow through name changes if no same-name continuation
        if (continuations.length === 0) {
            const nameChange = findNameChangeEdge(edges, walkStreet, currentBearing, visited);
            if (nameChange) {
                continuations = [nameChange];
                walkStreet = nameChange.streetName;
                nameChanges.push({ streetName: nameChange.streetName });
            } else {
                break;
            }
        }

        const edge = pickStraightest(continuations, currentBearing);
        transitEdges.push(edge);
        visited.add(edge.targetNode);
        currentNode = edge.targetNode;
        currentBearing = edge.entryBearing;

        // Check if the target street is at this node
        const nextNodeEdges = graph.edges.get(currentNode) || [];
        const matches = nextNodeEdges.filter(e => matchStreetName(targetStreet, e.streetName));
        if (matches.length > 0) {
            // If direction specified, verify an edge matches before returning.
            // For divided streets, the wrong carriageway's node is skipped.
            if (direction) {
                const dirMatch = pickEdgeByDirection(matches, currentBearing, direction);
                if (!dirMatch) {
                    if (!firstWrongDir) {
                        firstWrongDir = { node: currentNode, bearing: currentBearing, transitEdges: [...transitEdges], nameChanges: [...nameChanges] };
                    }
                    continue; // keep walking to find the correct carriageway
                }
            }
            return { node: currentNode, bearing: currentBearing, transitEdges, nameChanges };
        }
    }

    return null;
}

function followStreetForward(fromNodeId, streetName, bearing) {
    // Follow the street through intermediate intersections where it's the only
    // continuation (i.e., no choice to be made). Also follows through street
    // name changes when the road just continues (e.g., "Aurora Ave N" → "Aurora Bridge").
    // Returns nameChanges array tracking each name transition.
    const graph = state.streetGraph;
    const edges = [];
    let currentNode = fromNodeId;
    let currentBearing = bearing;
    let currentStreetName = streetName;
    const visited = new Set([fromNodeId]);
    const nameChanges = [];

    for (let i = 0; i < 50; i++) {  // safety limit
        const nodeEdges = graph.edges.get(currentNode) || [];

        // Find continuations on the same street, going roughly forward
        let continuations = nodeEdges.filter(e => {
            if (!matchStreetName(currentStreetName, e.streetName)) return false;
            if (visited.has(e.targetNode)) return false;
            return classifyTurn(currentBearing, e.bearing) !== 'U';
        });

        // If no same-name continuation, check for a name change (road continues
        // straight under a different name, e.g., at a bridge or city boundary)
        let isNameChange = false;
        if (continuations.length === 0) {
            const nameChange = findNameChangeEdge(nodeEdges, currentStreetName, currentBearing, visited);
            if (nameChange) {
                continuations = [nameChange];
                currentStreetName = nameChange.streetName;
                nameChanges.push({ streetName: nameChange.streetName });
                isNameChange = true;
            } else {
                break;
            }
        }

        // Check if this is a "decision point" — other streets available for turning.
        // Skip this check for name changes: a name change IS the road continuing,
        // so other streets branching off shouldn't stop us.
        if (!isNameChange) {
            const otherStreets = nodeEdges.filter(e => {
                if (matchStreetName(currentStreetName, e.streetName)) return false;
                if (visited.has(e.targetNode)) return false;
                return classifyTurn(currentBearing, e.bearing) !== 'U';
            });

            if (otherStreets.length > 0) {
                break;
            }
        }

        const edge = pickStraightest(continuations, currentBearing);
        edges.push(edge);
        visited.add(edge.targetNode);
        currentNode = edge.targetNode;
        currentBearing = edge.entryBearing;

        // Stop if we've reached the destination
        if (state.cuesheetChallenge && currentNode === state.cuesheetChallenge.endNode) {
            break;
        }
    }

    return { edges, endNode: currentNode, endBearing: currentBearing, streetName: currentStreetName, nameChanges };
}

function getFullStreetContinuation(fromNodeId, streetName, bearing) {
    // Follow the street through ALL nodes (ignoring decision points) for display purposes.
    // Also follows through name changes (bridges, boundaries).
    const graph = state.streetGraph;
    const edges = [];
    let currentNode = fromNodeId;
    let currentBearing = bearing;
    let currentStreetName = streetName;
    const visited = new Set([fromNodeId]);

    for (let i = 0; i < 100; i++) {
        const nodeEdges = graph.edges.get(currentNode) || [];
        let continuations = nodeEdges.filter(e => {
            if (!matchStreetName(currentStreetName, e.streetName)) return false;
            if (visited.has(e.targetNode)) return false;
            return classifyTurn(currentBearing, e.bearing) !== 'U';
        });

        if (continuations.length === 0) {
            const nameChange = findNameChangeEdge(nodeEdges, currentStreetName, currentBearing, visited);
            if (nameChange) {
                continuations = [nameChange];
                currentStreetName = nameChange.streetName;
            } else {
                break;
            }
        }

        const edge = pickStraightest(continuations, currentBearing);
        edges.push(edge);
        visited.add(edge.targetNode);
        currentNode = edge.targetNode;
        currentBearing = edge.entryBearing;
    }

    return edges;
}

function checkReachedEnd(currentNode, currentStreet, bearing, routeEdges) {
    // Check if the end node is reachable by continuing on the current street
    const graph = state.streetGraph;
    const endNodeId = state.cuesheetChallenge.endNode;

    if (currentNode === endNodeId) {
        return { reached: true, edges: [] };
    }

    // Try following the current street to see if we pass through the end node
    const visited = new Set();
    // Add all nodes already in the route to avoid backtracking
    routeEdges.forEach(e => visited.add(e.targetNode));
    // But allow the end node
    visited.delete(endNodeId);
    visited.delete(currentNode);

    const queue = [{ nodeId: currentNode, bearing, edges: [], street: currentStreet }];
    const queueVisited = new Set([currentNode]);

    while (queue.length > 0) {
        const { nodeId, bearing: curBearing, edges, street } = queue.shift();

        if (nodeId === endNodeId && nodeId !== currentNode) {
            return { reached: true, edges };
        }

        if (edges.length > 100) continue;

        const nodeEdges = graph.edges.get(nodeId) || [];
        let continuations = nodeEdges.filter(e => {
            if (!matchStreetName(street, e.streetName)) return false;
            if (queueVisited.has(e.targetNode)) return false;
            return classifyTurn(curBearing, e.bearing) !== 'U';
        });

        // Follow through name changes
        let nextStreet = street;
        if (continuations.length === 0) {
            const nameChange = findNameChangeEdge(nodeEdges, street, curBearing, queueVisited);
            if (nameChange) {
                continuations = [nameChange];
                nextStreet = nameChange.streetName;
            }
        }

        for (const edge of continuations) {
            queueVisited.add(edge.targetNode);
            queue.push({
                nodeId: edge.targetNode,
                bearing: edge.entryBearing,
                edges: [...edges, edge],
                street: nextStreet
            });
        }
    }

    return { reached: false, edges: [] };
}

// --- LIVE ROUTE DRAWING ---

function drawLiveRoute(fitViewport = false) {
    const route = state._cuesheetRoute;
    const challenge = state.cuesheetChallenge;
    if (!route || !challenge) return;

    // Remove previous route layers (but keep endpoint markers)
    ['cuesheet-player-route', 'cuesheet-continuation', 'cuesheet-optimal-route'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    // Draw the confirmed route (solid green)
    const routeCoords = edgesToCoords(route.edges);
    if (routeCoords.length >= 2) {
        addRouteLayer('cuesheet-player-route', routeCoords, '#00ff88', 4, false);
    }

    if (route.reachedEnd && route.endEdges && route.endEdges.length > 0) {
        // Draw continuation to end as solid green too
        const endCoords = edgesToCoords(route.endEdges);
        if (endCoords.length >= 2) {
            // Prepend the current position for continuity
            const lastRouteCoord = routeCoords.length > 0 ? routeCoords[routeCoords.length - 1] : null;
            const fullEndCoords = lastRouteCoord ? [lastRouteCoord, ...endCoords] : endCoords;
            addRouteLayer('cuesheet-continuation', deduplicateCoords(fullEndCoords), '#00ff88', 4, true);
        }
    } else {
        // Draw dashed continuation showing where current street goes (full extent)
        const contEdges = getFullStreetContinuation(route.currentNode, route.currentStreet, route.currentBearing);
        if (contEdges.length > 0) {
            const contCoords = edgesToCoords(contEdges);
            if (contCoords.length >= 2) {
                addRouteLayer('cuesheet-continuation', contCoords, '#00ff88', 3, true);
            }
        }
    }

    // Only fit viewport on initial challenge load
    if (fitViewport) {
        const bounds = new mapboxgl.LngLatBounds();
        routeCoords.forEach(c => bounds.extend(c));
        bounds.extend([challenge.startLng, challenge.startLat]);
        bounds.extend([challenge.endLng, challenge.endLat]);
        if (!bounds.isEmpty()) {
            state.map.fitBounds(bounds, { padding: 80, duration: 500, maxZoom: 16 });
        }
    }
}

function edgesToCoords(edges) {
    const coords = [];
    edges.forEach((edge, i) => {
        if (i === 0) {
            coords.push(...edge.coordinates);
        } else {
            coords.push(...edge.coordinates.slice(1));
        }
    });
    return deduplicateCoords(coords);
}

function deduplicateCoords(coords) {
    if (coords.length === 0) return coords;
    const result = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
        const prev = result[result.length - 1];
        if (coords[i][0] !== prev[0] || coords[i][1] !== prev[1]) {
            result.push(coords[i]);
        }
    }
    return result;
}

// --- CUE LIST RENDERING ---

function renderCueList() {
    const list = document.getElementById('cuesheet-list');
    if (!list) return;

    list.innerHTML = '';

    // Show the pre-loaded starting street as a static first row
    if (state.cuesheetChallenge && state.cuesheetChallenge.startingStreet) {
        const startRow = document.createElement('div');
        startRow.className = 'cuesheet-cue-row starting';
        const startDir = document.createElement('span');
        startDir.className = 'cue-direction cue-start';
        startDir.textContent = 'Start';
        const startArrow = document.createElement('span');
        startArrow.className = 'cue-arrow';
        startArrow.textContent = '\u2192';
        const startName = document.createElement('span');
        startName.className = 'cue-street-name';
        startName.textContent = state.cuesheetChallenge.startingStreet;
        startRow.appendChild(startDir);
        startRow.appendChild(startArrow);
        startRow.appendChild(startName);
        list.appendChild(startRow);
    }

    state.cuesheetCues.forEach((cue, i) => {
        const row = document.createElement('div');
        row.className = 'cuesheet-cue-row' + (cue.implicit ? ' implicit' : '');

        const dirLabel = document.createElement('span');
        dirLabel.className = 'cue-direction';
        dirLabel.textContent = cue.direction;
        dirLabel.classList.add(`cue-${cue.direction.toLowerCase()}`);

        const arrow = document.createElement('span');
        arrow.className = 'cue-arrow';
        arrow.textContent = '\u2192';

        const name = document.createElement('span');
        name.className = 'cue-street-name';
        name.textContent = cue.streetName;

        row.appendChild(dirLabel);
        row.appendChild(arrow);
        row.appendChild(name);

        if (!cue.implicit) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'cue-delete-btn';
            deleteBtn.textContent = '\u00d7';
            deleteBtn.addEventListener('click', () => removeCue(i));
            row.appendChild(deleteBtn);
        }

        list.appendChild(row);
    });

    list.scrollTop = list.scrollHeight;
}

// --- SUBMIT / RESULTS ---

export function submitCuesheet() {
    // If showing results, act as "New Route"
    if (state.cuesheetResults) {
        state.cuesheetResults = null;
        generateCuesheetChallenge();
        return;
    }

    if (!state.cuesheetChallenge || state.cuesheetCues.length === 0) {
        showMessage('Add at least one cue before submitting.', 'error');
        return;
    }

    const route = state._cuesheetRoute;
    if (!route) {
        showMessage('No valid route to submit.', 'error');
        return;
    }

    state.cuesheetResults = route;
    showResults(route);
}

function showResults(route) {
    const challenge = state.cuesheetChallenge;

    // Show the full player route (including continuation to end if reached)
    let allEdges = [...route.edges];
    if (route.reachedEnd && route.endEdges) {
        allEdges.push(...route.endEdges);
    }
    const playerCoords = edgesToCoords(allEdges);
    const playerDistance = allEdges.reduce((sum, e) => sum + e.distance, 0);

    // Clear live route and redraw as final
    ['cuesheet-player-route', 'cuesheet-continuation'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    const playerColor = route.reachedEnd ? '#00ff88' : '#ff6464';
    if (playerCoords.length >= 2) {
        addRouteLayer('cuesheet-player-route', playerCoords, playerColor, 5, false);
    }

    // Show Dijkstra optimal
    const optimal = findShortestPath(challenge.startNode, challenge.endNode);
    if (optimal) {
        const optimalCoords = pathToCoordinates(optimal.edges);
        if (optimalCoords.length >= 2) {
            addRouteLayer('cuesheet-optimal-route', optimalCoords, '#00c8ff', 3, true);
        }

        const optimalCues = pathToCuesheet(optimal.edges);
        showOptimalCuesheet(optimalCues, optimal.totalDistance);
    }

    if (route.reachedEnd) {
        const playerKm = (playerDistance / 1000).toFixed(1);
        const optimalKm = optimal ? (optimal.totalDistance / 1000).toFixed(1) : '?';
        showMessage(`Valid route! Your path: ${playerKm} km | Shortest: ${optimalKm} km`, 'success');
    } else {
        showMessage('Route does not reach the destination', 'error');
    }

    // Update buttons — hide input row, show New Route
    const submitBtn = document.getElementById('cuesheet-submit-btn');
    const skipBtn = document.getElementById('cuesheet-skip-btn');
    const addBtn = document.getElementById('cuesheet-add-btn');
    const hintBtn = document.getElementById('cuesheet-hint-btn');
    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (submitBtn) submitBtn.textContent = 'New Route';
    if (skipBtn) skipBtn.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (hintBtn) hintBtn.style.display = 'none';
    if (cuesheetInput) cuesheetInput.style.display = 'none';
}

function showOptimalCuesheet(cues, totalDistance) {
    const list = document.getElementById('cuesheet-list');
    if (!list) return;

    const divider = document.createElement('div');
    divider.className = 'cuesheet-divider';
    divider.textContent = `Shortest path (${(totalDistance / 1000).toFixed(1)} km):`;
    list.appendChild(divider);

    cues.forEach(cue => {
        const row = document.createElement('div');
        row.className = 'cuesheet-cue-row optimal';

        const dirLabel = document.createElement('span');
        dirLabel.className = 'cue-direction';
        if (cue.direction === null) {
            dirLabel.textContent = 'Start';
            dirLabel.classList.add('cue-start');
        } else {
            dirLabel.textContent = cue.direction;
            dirLabel.classList.add(`cue-${cue.direction.toLowerCase()}`);
        }

        const arrow = document.createElement('span');
        arrow.className = 'cue-arrow';
        arrow.textContent = '\u2192';

        const name = document.createElement('span');
        name.className = 'cue-street-name';
        name.textContent = cue.streetName;

        row.appendChild(dirLabel);
        row.appendChild(arrow);
        row.appendChild(name);
        list.appendChild(row);
    });

    list.scrollTop = list.scrollHeight;
}

// --- MAP HELPERS ---

function addRouteLayer(id, coords, color, width, dashed) {
    if (!state.map) return;

    if (state.map.getLayer(id)) state.map.removeLayer(id);
    if (state.map.getSource(id)) state.map.removeSource(id);

    state.map.addSource(id, {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {}
        }
    });

    const paint = {
        'line-color': color,
        'line-width': width,
        'line-opacity': 0.8,
    };
    if (dashed) {
        paint['line-dasharray'] = [4, 3];
    }

    state.map.addLayer({ id, type: 'line', source: id, paint });
}

function addEndpointMarkers(challenge) {
    if (state._cuesheetMarkers) {
        state._cuesheetMarkers.forEach(m => m.remove());
    }

    const startMarker = new mapboxgl.Marker({ color: '#00ff88' })
        .setLngLat([challenge.startLng, challenge.startLat])
        .setPopup(new mapboxgl.Popup().setText('Start: ' + challenge.startStreets.join(' & ')))
        .addTo(state.map);

    const endMarker = new mapboxgl.Marker({ color: '#ff6464' })
        .setLngLat([challenge.endLng, challenge.endLat])
        .setPopup(new mapboxgl.Popup().setText('End: ' + challenge.endStreets.join(' & ')))
        .addTo(state.map);

    state._cuesheetMarkers = [startMarker, endMarker];
}

export function cleanupCuesheetMapLayers() {
    if (!state.map) return;

    ['cuesheet-player-route', 'cuesheet-continuation', 'cuesheet-optimal-route'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    if (state._cuesheetMarkers) {
        state._cuesheetMarkers.forEach(m => m.remove());
        state._cuesheetMarkers = null;
    }
}

export function skipChallenge() {
    cleanupCuesheetMapLayers();
    generateCuesheetChallenge();
}

// --- CUSTOM ROUTE PICKING ---

export function startCustomRoute() {
    if (!state.streetData || state.streetData.features.length === 0) {
        showMessage('Load a city first.', 'error');
        return;
    }

    if (!state.streetGraph) {
        setLoadingState(true, 'Building street graph...');
        setTimeout(() => {
            buildStreetGraph();
            setLoadingState(false);
            _enterPickingMode();
        }, 50);
        return;
    }
    _enterPickingMode();
}

function _enterPickingMode() {
    cleanupCuesheetMapLayers();
    state.cuesheetChallenge = null;
    state.cuesheetCues = [];
    state.cuesheetResults = null;
    state._cuesheetRoute = null;

    state._cuesheetCustomPicking = 'start';

    const fromEl = document.getElementById('cuesheet-from');
    const toEl = document.getElementById('cuesheet-to');
    if (fromEl) fromEl.textContent = 'Click map to set start';
    if (toEl) toEl.textContent = '';

    // Hide cue input controls during picking
    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (cuesheetInput) cuesheetInput.style.display = 'none';
    const cuesheetList = document.getElementById('cuesheet-list');
    if (cuesheetList) cuesheetList.innerHTML = '';

    const customBtn = document.getElementById('cuesheet-custom-btn');
    if (customBtn) customBtn.textContent = 'Cancel';

    if (state.map) state.map.getCanvas().style.cursor = 'crosshair';
}

export function handleCustomRouteClick(lngLat) {
    if (!state._cuesheetCustomPicking) return false;

    const graph = state.streetGraph;
    if (!graph) return false;

    const nodeId = findClosestNode(lngLat.lat, lngLat.lng);
    if (!nodeId) {
        showMessage('No intersection found nearby.', 'error');
        return true;
    }

    const node = graph.nodes.get(nodeId);
    const dist = calculateDistanceMeters(lngLat.lat, lngLat.lng, node.lat, node.lng);
    if (dist > 500) {
        showMessage('No intersection found nearby. Try closer to a street.', 'error');
        return true;
    }

    if (state._cuesheetCustomPicking === 'start') {
        // Place start marker
        if (state._cuesheetMarkers) {
            state._cuesheetMarkers.forEach(m => m.remove());
        }
        const marker = new mapboxgl.Marker({ color: '#00ff88' })
            .setLngLat([node.lng, node.lat])
            .addTo(state.map);
        state._cuesheetMarkers = [marker];

        state._cuesheetCustomStart = { nodeId, lat: node.lat, lng: node.lng };
        state._cuesheetCustomPicking = 'end';

        const fromEl = document.getElementById('cuesheet-from');
        const toEl = document.getElementById('cuesheet-to');
        const streets = getNodeStreetNames(nodeId);
        if (fromEl) fromEl.textContent = streets.slice(0, 2).join(' & ') || 'Start';
        if (toEl) toEl.textContent = 'Click map to set end';

        return true;
    }

    if (state._cuesheetCustomPicking === 'end') {
        if (nodeId === state._cuesheetCustomStart.nodeId) {
            showMessage('End must be different from start.', 'error');
            return true;
        }

        // Validate path exists
        const path = findShortestPath(state._cuesheetCustomStart.nodeId, nodeId);
        if (!path) {
            showMessage('No path between these points. Try different locations.', 'error');
            return true;
        }

        // Build challenge object
        const startNode = graph.nodes.get(state._cuesheetCustomStart.nodeId);
        const endNode = graph.nodes.get(nodeId);
        const challenge = {
            startNode: state._cuesheetCustomStart.nodeId,
            endNode: nodeId,
            startStreets: pickDisplayStreets(state._cuesheetCustomStart.nodeId),
            endStreets: pickDisplayStreets(nodeId),
            startLat: startNode.lat,
            startLng: startNode.lng,
            endLat: endNode.lat,
            endLng: endNode.lng,
        };

        // Exit picking mode
        state._cuesheetCustomPicking = null;
        if (state.map) state.map.getCanvas().style.cursor = '';

        // Remove picking markers (replaced by challenge markers)
        if (state._cuesheetMarkers) {
            state._cuesheetMarkers.forEach(m => m.remove());
            state._cuesheetMarkers = null;
        }

        const customBtn = document.getElementById('cuesheet-custom-btn');
        if (customBtn) customBtn.textContent = 'Custom';

        // Restore cue input controls
        const cuesheetInput = document.querySelector('.cuesheet-input');
        if (cuesheetInput) cuesheetInput.style.display = '';

        _pickAndDisplayChallenge(challenge);
        return true;
    }

    return false;
}

export function cancelCustomRoute() {
    state._cuesheetCustomPicking = null;
    state._cuesheetCustomStart = null;

    if (state.map) state.map.getCanvas().style.cursor = '';

    if (state._cuesheetMarkers) {
        state._cuesheetMarkers.forEach(m => m.remove());
        state._cuesheetMarkers = null;
    }

    const customBtn = document.getElementById('cuesheet-custom-btn');
    if (customBtn) customBtn.textContent = 'Custom';

    // Restore cue input controls
    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (cuesheetInput) cuesheetInput.style.display = '';

    generateCuesheetChallenge();
}

export function getHint() {
    if (!state.cuesheetChallenge || state.cuesheetResults || !state._cuesheetRoute) return;

    const challenge = state.cuesheetChallenge;
    const route = state._cuesheetRoute;
    const graph = state.streetGraph;

    if (route.reachedEnd) {
        showMessage('Route already reaches the destination — submit it!', 'success');
        return;
    }

    // Use Dijkstra to find the optimal path, then extract the next turn from it.
    // This is more accurate than the greedy candidate approach, especially for
    // divided streets where wrong-carriageway edges could lead to detours.
    const path = findShortestPath(route.currentNode, challenge.endNode);
    if (!path || path.edges.length === 0) {
        showMessage('No path to destination found.', 'error');
        return;
    }

    // Walk the Dijkstra path to find the first real turn (not a name change)
    let walkStreet = route.currentStreet;
    let prevBearing = route.currentBearing;

    for (let i = 0; i < path.edges.length; i++) {
        const edge = path.edges[i];

        if (matchStreetName(walkStreet, edge.streetName)) {
            // Still on the same street — keep walking
            prevBearing = edge.entryBearing;
            continue;
        }

        // Different street name. Is this a name change or a real turn?
        const turnDir = classifyTurn(prevBearing, edge.bearing);

        if (turnDir === 'S') {
            // Straight continuation with different name — check if it's a name change.
            // It's a name change if the current street has no same-name forward continuation.
            const turnNode = i > 0 ? path.edges[i - 1].targetNode : route.currentNode;
            const nodeEdges = graph.edges.get(turnNode) || [];
            const traversed = new Set();
            for (let j = 0; j < i; j++) traversed.add(path.edges[j].targetNode);
            const sameNameForward = nodeEdges.filter(e =>
                matchStreetName(walkStreet, e.streetName) &&
                !traversed.has(e.targetNode) &&
                classifyTurn(prevBearing, e.bearing) !== 'U'
            );
            if (sameNameForward.length === 0) {
                // Name change — implicit cues handle this, skip
                walkStreet = edge.streetName;
                prevBearing = edge.entryBearing;
                continue;
            }
        }

        if (turnDir === 'U') {
            // Dijkstra wants a U-turn — can't express as a cue, skip
            prevBearing = edge.entryBearing;
            walkStreet = edge.streetName;
            continue;
        }

        // Real turn — construct cue and validate
        const cue = { direction: turnDir, streetName: edge.streetName };
        const validation = validateNextCue(cue);

        if (validation.valid) {
            if (validation.preTurnNameChanges) {
                for (const nc of validation.preTurnNameChanges) {
                    state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
                }
            }
            state.cuesheetCues.push(cue);
            if (validation.postTurnNameChanges) {
                for (const nc of validation.postTurnNameChanges) {
                    state.cuesheetCues.push({ direction: 'S', streetName: nc.streetName, implicit: true });
                }
            }
            state._cuesheetRoute = validation.route;
            drawLiveRoute();
            renderCueList();
            resetCueInput();

            if (validation.route.reachedEnd) {
                showMessage('Route reaches the destination!', 'success');
            }
            return;
        }
        // Validation failed for this turn — try continuing along Dijkstra path
        // (might happen if validation system can't reproduce the exact Dijkstra edge)
        break;
    }

    // No turn found in Dijkstra path — destination is reachable via name changes
    // on the current street. Auto-complete the route with the Dijkstra path edges.
    const reachedEnd = checkReachedEnd(route.currentNode, route.currentStreet, route.currentBearing, route.edges);
    if (reachedEnd.reached) {
        state._cuesheetRoute = {
            ...route,
            reachedEnd: true,
            endEdges: reachedEnd.edges,
        };
        drawLiveRoute();
        renderCueList();
        showMessage('Route reaches the destination!', 'success');
        return;
    }

    showMessage('Keep following ' + (route.currentStreet || 'the current street'), 'info');
}

// --- STREET AUTOCOMPLETE ---

let _allStreetNames = null; // cached sorted array
let _activeIndex = -1;      // keyboard nav index

function getAllStreetNames() {
    if (_allStreetNames && _allStreetNames._forData === state.streetSegmentsData) {
        return _allStreetNames;
    }
    if (!state.streetSegmentsData) return [];
    const names = [...state.streetSegmentsData.keys()].sort((a, b) => a.localeCompare(b));
    names._forData = state.streetSegmentsData;
    _allStreetNames = names;
    return names;
}

export function handleStreetAutocomplete() {
    const input = document.getElementById('cuesheet-street-input');
    const dropdown = document.getElementById('cuesheet-suggestions');
    if (!input || !dropdown) return;

    const query = input.value.trim().toLowerCase();
    if (query.length === 0) {
        dropdown.style.display = 'none';
        _activeIndex = -1;
        return;
    }

    const allNames = getAllStreetNames();
    const matches = allNames.filter(name => name.toLowerCase().includes(query)).slice(0, 8);

    if (matches.length === 0) {
        dropdown.style.display = 'none';
        _activeIndex = -1;
        return;
    }

    _activeIndex = -1;
    dropdown.innerHTML = '';
    matches.forEach((name, i) => {
        const div = document.createElement('div');
        div.className = 'cuesheet-suggestion';
        div.textContent = name;
        div.addEventListener('mousedown', (e) => {
            e.preventDefault(); // prevent blur
            input.value = name;
            dropdown.style.display = 'none';
            _activeIndex = -1;
        });
        dropdown.appendChild(div);
    });
    dropdown.style.display = 'block';
}

export function handleSuggestionKeydown(e) {
    const dropdown = document.getElementById('cuesheet-suggestions');
    if (!dropdown || dropdown.style.display === 'none') return;

    const items = dropdown.querySelectorAll('.cuesheet-suggestion');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _activeIndex = Math.min(_activeIndex + 1, items.length - 1);
        updateActiveItem(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _activeIndex = Math.max(_activeIndex - 1, -1);
        updateActiveItem(items);
    } else if (e.key === 'Enter' && _activeIndex >= 0) {
        e.preventDefault();
        const input = document.getElementById('cuesheet-street-input');
        input.value = items[_activeIndex].textContent;
        dropdown.style.display = 'none';
        _activeIndex = -1;
        addCue();
    } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        _activeIndex = -1;
    }
}

function updateActiveItem(items) {
    items.forEach((item, i) => {
        item.classList.toggle('active', i === _activeIndex);
    });
    if (_activeIndex >= 0) {
        items[_activeIndex].scrollIntoView({ block: 'nearest' });
    }
}

export function hideSuggestions() {
    const dropdown = document.getElementById('cuesheet-suggestions');
    if (dropdown) dropdown.style.display = 'none';
    _activeIndex = -1;
}
