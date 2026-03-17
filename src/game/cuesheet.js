import { state } from '../state.js';
import {
    generateChallenge as apiGenerateChallenge,
    validateCue as apiValidateCue,
    undoCue as apiUndoCue,
    getHint as apiGetHint,
    getOptimalRoute as apiGetOptimalRoute,
    getClosestNode as apiGetClosestNode,
} from '../api/backend.js';
import { calculateDistanceMeters } from '../utils/geo.js';
import { normalizeStreetName } from '../utils/string.js';
import { showMessage, setLoadingState } from './ui.js';
import { highlightStreet, clearHighlight } from '../map/mapbox.js';

// --- CHALLENGE GENERATION ---

export async function generateCuesheetChallenge() {
    if (!state.streetData || state.streetData.features.length === 0) {
        updateCuesheetDisplay(null);
        return;
    }

    if (!state.cityId) {
        showMessage('City not loaded on backend. Please reload the area.', 'error');
        updateCuesheetDisplay(null);
        return;
    }

    setLoadingState(true, 'Generating route challenge...');

    try {
        await _pickAndDisplayChallenge();
    } catch (error) {
        console.error('Error generating challenge:', error);
        showMessage('Could not generate a route challenge. Try a different area.', 'error');
        updateCuesheetDisplay(null);
    } finally {
        setLoadingState(false);
    }
}

async function _pickAndDisplayChallenge(customChallenge = null) {
    let challengeData;

    if (customChallenge) {
        challengeData = customChallenge;
    } else {
        challengeData = await apiGenerateChallenge(
            state.cityId, state.intersectionDifficulty
        );
    }

    const challenge = {
        startNode: challengeData.start_node.node_id,
        endNode: challengeData.end_node.node_id,
        startStreets: challengeData.start_node.streets,
        endStreets: challengeData.end_node.streets,
        startLat: challengeData.start_node.lat,
        startLng: challengeData.start_node.lng,
        endLat: challengeData.end_node.lat,
        endLng: challengeData.end_node.lng,
        startingStreet: challengeData.route.starting_street,
    };

    state.cuesheetChallenge = challenge;
    state.cuesheetCues = [];
    state.cuesheetResults = null;

    // Store route state from backend
    const route = challengeData.route;
    state._cuesheetRouteId = route.route_id;
    state._cuesheetRouteCoords = route.route_coordinates;
    state._cuesheetConfirmedCoords = [];
    state._cuesheetContinuationCoords = route.continuation_coordinates;
    state._cuesheetConfirmedEdgeCount = route.confirmed_edge_count;
    state._cuesheetReachedEnd = route.reached_end;
    state._cuesheetEndCoords = route.end_coordinates;
    state._cuesheetCurrentStreet = route.starting_street;

    cleanupCuesheetMapLayers();

    // Insert implicit cues for starting street name changes
    if (route.name_changes && route.name_changes.length > 0) {
        for (const nc of route.name_changes) {
            state.cuesheetCues.push({
                direction: 'S',
                streetName: nc.street_name,
                implicit: true,
            });
        }
    }

    updateCuesheetDisplay(challenge);
    renderCueList();
    resetCueInput();

    addEndpointMarkers(challenge);
    drawLiveRoute(true);
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
    const customBtn = document.getElementById('cuesheet-custom-btn');
    const cuesheetInput = document.querySelector('.cuesheet-input');

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
    if (skipBtn) { skipBtn.textContent = 'Skip'; skipBtn.style.display = ''; }
    if (addBtn) addBtn.style.display = '';
    if (hintBtn) hintBtn.style.display = '';
    if (customBtn) customBtn.style.display = '';
    if (cuesheetInput) cuesheetInput.style.display = '';
}

export function selectDirection(dir) {
    state._selectedDirection = dir;
    const btns = document.querySelectorAll('#cuesheet-dir-btns .dir-btn');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dir === dir));
}

// --- CUE MANAGEMENT ---

export async function addCue() {
    const streetInput = document.getElementById('cuesheet-street-input');
    if (!streetInput || !state.cuesheetChallenge) return;

    const streetName = streetInput.value.trim();
    if (!streetName) return;

    if (state.cuesheetResults) return;

    const direction = state._selectedDirection || 'L';

    // Try the typed name first
    let result = await _tryValidateCue(direction, streetName);

    // If invalid, try all matching street names (handles variants like
    // "Eastlake Ave N" vs "Eastlake Ave NE" vs "Eastlake Ave")
    if (!result.valid) {
        const candidates = _findMatchingStreetNames(streetName);
        for (const candidate of candidates) {
            const candidateResult = await _tryValidateCue(direction, candidate);
            if (candidateResult.valid) {
                result = candidateResult;
                break;
            }
        }
    }

    if (!result.valid) {
        showMessage(result.error, 'error');
        return;
    }

    // Insert pre-turn implicit cues
    if (result.pre_turn_name_changes && result.pre_turn_name_changes.length > 0) {
        for (const nc of result.pre_turn_name_changes) {
            state.cuesheetCues.push({
                direction: 'S',
                streetName: nc.street_name,
                implicit: true,
            });
        }
    }

    // Add the actual cue
    const cue = { direction, streetName: result.matched_street_name };
    state.cuesheetCues.push(cue);

    // Insert post-turn implicit cues
    if (result.post_turn_name_changes && result.post_turn_name_changes.length > 0) {
        for (const nc of result.post_turn_name_changes) {
            state.cuesheetCues.push({
                direction: 'S',
                streetName: nc.street_name,
                implicit: true,
            });
        }
    }

    // Update route rendering state from backend response
    _updateRouteFromResponse(result);

    drawLiveRoute();
    renderCueList();
    resetCueInput();

    if (result.reached_end) {
        showMessage('Route reaches the destination!', 'success');
    }
}

function _findMatchingStreetNames(input) {
    const allNames = state.streetNames || [];
    const query = input.toLowerCase();
    const normalizedQuery = normalizeStreetName(query);

    // Exact normalized equality — same logic as the streets game
    return allNames.filter(name => {
        if (name.toLowerCase() === query) return false; // already tried exact
        return normalizeStreetName(name) === normalizedQuery;
    });
}

async function _tryValidateCue(direction, streetName) {
    try {
        return await apiValidateCue(state._cuesheetRouteId, direction, streetName);
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

function _updateRouteFromResponse(response) {
    state._cuesheetRouteCoords = response.route_coordinates || [];
    state._cuesheetConfirmedCoords = response.confirmed_coordinates || [];
    state._cuesheetContinuationCoords = response.continuation_coordinates || [];
    state._cuesheetConfirmedEdgeCount = response.confirmed_edge_count || 0;
    state._cuesheetReachedEnd = response.reached_end || false;
    state._cuesheetEndCoords = response.end_coordinates || [];
    state._cuesheetCurrentStreet = response.current_street || null;
}

export async function removeCue(index) {
    state.cuesheetCues.splice(index);

    // Count explicit cues remaining
    const explicitCount = state.cuesheetCues.filter(c => !c.implicit).length;

    try {
        const result = await apiUndoCue(state._cuesheetRouteId, explicitCount);

        // Rebuild cue list from backend response
        state.cuesheetCues = [];

        // Add initial name changes
        if (result.name_changes && result.name_changes.length > 0) {
            for (const nc of result.name_changes) {
                state.cuesheetCues.push({
                    direction: 'S',
                    streetName: nc.street_name,
                    implicit: true,
                });
            }
        }

        // Replay explicit cues from backend
        if (result.replayed_cues) {
            for (const cue of result.replayed_cues) {
                state.cuesheetCues.push({
                    direction: cue.direction,
                    streetName: cue.street_name,
                });
            }
        }

        state._cuesheetRouteCoords = result.route_coordinates || [];
        state._cuesheetConfirmedCoords = result.confirmed_coordinates || [];
        state._cuesheetContinuationCoords = result.continuation_coordinates || [];
        state._cuesheetConfirmedEdgeCount = result.confirmed_edge_count || 0;
        state._cuesheetReachedEnd = result.reached_end || false;
        state._cuesheetEndCoords = result.end_coordinates || [];
        state._cuesheetCurrentStreet = result.current_street || null;

        cleanupCuesheetMapLayers();
        addEndpointMarkers(state.cuesheetChallenge);
        drawLiveRoute();
    } catch (error) {
        console.error('Error undoing cue:', error);
        showMessage('Error rebuilding route', 'error');
    }

    renderCueList();
    resetCueInput();
}

// --- LIVE ROUTE DRAWING ---

function drawLiveRoute(fitViewport = false) {
    const challenge = state.cuesheetChallenge;
    if (!challenge) return;

    // Remove previous route layers (but keep endpoint markers)
    ['cuesheet-player-route', 'cuesheet-continuation', 'cuesheet-optimal-route'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    // Draw confirmed route (solid green)
    const confirmedCoords = state._cuesheetConfirmedCoords;
    if (confirmedCoords && confirmedCoords.length >= 2) {
        addRouteLayer('cuesheet-player-route', confirmedCoords, '#00ff88', 4, false);
    }

    // Draw continuation (dashed green)
    const contCoords = state._cuesheetContinuationCoords;
    if (contCoords && contCoords.length >= 2) {
        addRouteLayer('cuesheet-continuation', contCoords, '#00ff88', 3, true);
    } else if (state._cuesheetRouteCoords && state._cuesheetRouteCoords.length >= 2
               && (!confirmedCoords || confirmedCoords.length < 2)) {
        // If no confirmed yet, draw the whole route as dashed
        addRouteLayer('cuesheet-continuation', state._cuesheetRouteCoords, '#00ff88', 3, true);
    }

    // Fit viewport on initial challenge load
    if (fitViewport) {
        const allCoords = state._cuesheetRouteCoords || [];
        const bounds = new mapboxgl.LngLatBounds();
        allCoords.forEach(c => bounds.extend(c));
        bounds.extend([challenge.startLng, challenge.startLat]);
        bounds.extend([challenge.endLng, challenge.endLat]);
        if (!bounds.isEmpty()) {
            state.map.fitBounds(bounds, { padding: 80, duration: 500, maxZoom: 16 });
        }
    }
}

// --- CUE LIST RENDERING ---

function _addRowInteraction(row, streetName) {
    row.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('cue-delete-btn')) return;
        row.classList.add('holding');
        highlightStreet(streetName);
    });
    row.addEventListener('mouseup', () => {
        row.classList.remove('holding');
        clearHighlight();
    });
    row.addEventListener('mouseleave', () => {
        row.classList.remove('holding');
        clearHighlight();
    });
    row.addEventListener('dblclick', () => {
        const features = (state.streetData?.features || []).filter(f => f.properties.name === streetName);
        if (features.length === 0) return;
        const bounds = new mapboxgl.LngLatBounds();
        features.forEach(f => {
            if (f.geometry.type === 'LineString') {
                f.geometry.coordinates.forEach(c => bounds.extend(c));
            } else if (f.geometry.type === 'MultiLineString') {
                f.geometry.coordinates.forEach(bg => bg.forEach(c => bounds.extend(c)));
            }
        });
        if (!bounds.isEmpty()) {
            state.map.fitBounds(bounds, { padding: 50, maxZoom: 16, duration: 1000 });
        }
    });
}

function renderCueList() {
    const list = document.getElementById('cuesheet-list');
    if (!list) return;

    list.innerHTML = '';

    // Starting street row
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
        _addRowInteraction(startRow, state.cuesheetChallenge.startingStreet);
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

        _addRowInteraction(row, cue.streetName);
        list.appendChild(row);
    });

    list.scrollTop = list.scrollHeight;
}

// --- SUBMIT / RESULTS ---

export async function submitCuesheet() {
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

    state.cuesheetResults = {
        reachedEnd: state._cuesheetReachedEnd,
        routeCoords: state._cuesheetRouteCoords,
        endCoords: state._cuesheetEndCoords,
    };

    await showResults();
}

export function continueEditing() {
    if (!state.cuesheetResults) return;

    state.cuesheetResults = null;

    // Remove optimal route layer
    if (state.map) {
        if (state.map.getLayer('cuesheet-optimal-route')) state.map.removeLayer('cuesheet-optimal-route');
        if (state.map.getSource('cuesheet-optimal-route')) state.map.removeSource('cuesheet-optimal-route');
    }

    drawLiveRoute();
    renderCueList();
    resetCueInput();
}

async function showResults() {
    const challenge = state.cuesheetChallenge;
    const results = state.cuesheetResults;

    // Clear live route and redraw as final
    ['cuesheet-player-route', 'cuesheet-continuation'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    // Draw player route
    let playerCoords = results.routeCoords || [];
    if (results.reachedEnd && results.endCoords && results.endCoords.length > 0) {
        playerCoords = [...playerCoords, ...results.endCoords];
    }
    const playerColor = results.reachedEnd ? '#00ff88' : '#ff6464';
    if (playerCoords.length >= 2) {
        addRouteLayer('cuesheet-player-route', playerCoords, playerColor, 5, false);
    }

    // Fetch and show optimal route from backend
    try {
        const optimal = await apiGetOptimalRoute(
            state.cityId, challenge.startNode, challenge.endNode
        );

        if (optimal && optimal.coordinates.length >= 2) {
            addRouteLayer('cuesheet-optimal-route', optimal.coordinates, '#00c8ff', 3, true);
            showOptimalCuesheet(optimal.cues, optimal.total_distance);
        }

        if (results.reachedEnd) {
            const optimalKm = (optimal.total_distance / 1000).toFixed(1);
            showMessage(`Valid route! Shortest: ${optimalKm} km`, 'success');
        } else {
            showMessage('Route does not reach the destination', 'error');
        }
    } catch (error) {
        console.error('Error fetching optimal route:', error);
        if (results.reachedEnd) {
            showMessage('Valid route!', 'success');
        } else {
            showMessage('Route does not reach the destination', 'error');
        }
    }

    // Update buttons
    const submitBtn = document.getElementById('cuesheet-submit-btn');
    const skipBtn = document.getElementById('cuesheet-skip-btn');
    const addBtn = document.getElementById('cuesheet-add-btn');
    const hintBtn = document.getElementById('cuesheet-hint-btn');
    const customBtn = document.getElementById('cuesheet-custom-btn');
    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (submitBtn) submitBtn.textContent = 'New Route';
    if (skipBtn) { skipBtn.textContent = 'Continue'; skipBtn.style.display = ''; }
    if (addBtn) addBtn.style.display = 'none';
    if (hintBtn) hintBtn.style.display = 'none';
    if (customBtn) customBtn.style.display = 'none';
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
        name.textContent = cue.street_name;

        row.appendChild(dirLabel);
        row.appendChild(arrow);
        row.appendChild(name);
        _addRowInteraction(row, cue.street_name);
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

export async function skipChallenge() {
    cleanupCuesheetMapLayers();
    generateCuesheetChallenge();
}

// --- CUSTOM ROUTE PICKING ---

export async function startCustomRoute() {
    if (!state.streetData || state.streetData.features.length === 0) {
        showMessage('Load a city first.', 'error');
        return;
    }

    if (!state.cityId) {
        showMessage('City not loaded on backend. Please reload the area.', 'error');
        return;
    }

    _enterPickingMode();
}

function _enterPickingMode() {
    cleanupCuesheetMapLayers();
    state.cuesheetChallenge = null;
    state.cuesheetCues = [];
    state.cuesheetResults = null;
    state._cuesheetRouteId = null;

    state._cuesheetCustomPicking = 'start';

    const fromEl = document.getElementById('cuesheet-from');
    const toEl = document.getElementById('cuesheet-to');
    if (fromEl) fromEl.textContent = 'Click map to set start';
    if (toEl) toEl.textContent = '';

    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (cuesheetInput) cuesheetInput.style.display = 'none';
    const cuesheetList = document.getElementById('cuesheet-list');
    if (cuesheetList) cuesheetList.innerHTML = '';

    const customBtn = document.getElementById('cuesheet-custom-btn');
    if (customBtn) customBtn.textContent = 'Cancel';

    if (state.map) state.map.getCanvas().style.cursor = 'crosshair';
}

export async function handleCustomRouteClick(lngLat) {
    if (!state._cuesheetCustomPicking) return false;

    if (!state.cityId) return false;

    try {
        const nodeInfo = await apiGetClosestNode(state.cityId, lngLat.lat, lngLat.lng);
        const dist = calculateDistanceMeters(lngLat.lat, lngLat.lng, nodeInfo.lat, nodeInfo.lng);

        if (dist > 500) {
            showMessage('No intersection found nearby. Try closer to a street.', 'error');
            return true;
        }

        if (state._cuesheetCustomPicking === 'start') {
            if (state._cuesheetMarkers) {
                state._cuesheetMarkers.forEach(m => m.remove());
            }
            const marker = new mapboxgl.Marker({ color: '#00ff88' })
                .setLngLat([nodeInfo.lng, nodeInfo.lat])
                .addTo(state.map);
            state._cuesheetMarkers = [marker];

            state._cuesheetCustomStart = nodeInfo;
            state._cuesheetCustomPicking = 'end';

            const fromEl = document.getElementById('cuesheet-from');
            const toEl = document.getElementById('cuesheet-to');
            if (fromEl) fromEl.textContent = nodeInfo.streets.slice(0, 2).join(' & ') || 'Start';
            if (toEl) toEl.textContent = 'Click map to set end';

            return true;
        }

        if (state._cuesheetCustomPicking === 'end') {
            if (nodeInfo.node_id === state._cuesheetCustomStart.node_id) {
                showMessage('End must be different from start.', 'error');
                return true;
            }

            // Exit picking mode
            state._cuesheetCustomPicking = null;
            if (state.map) state.map.getCanvas().style.cursor = '';

            if (state._cuesheetMarkers) {
                state._cuesheetMarkers.forEach(m => m.remove());
                state._cuesheetMarkers = null;
            }

            const customBtn = document.getElementById('cuesheet-custom-btn');
            if (customBtn) customBtn.textContent = 'Custom';

            const cuesheetInput = document.querySelector('.cuesheet-input');
            if (cuesheetInput) cuesheetInput.style.display = '';

            // Generate challenge via backend with specific start/end nodes
            setLoadingState(true, 'Setting up custom route...');
            try {
                const customChallengeData = await apiGenerateChallenge(
                    state.cityId,
                    state.intersectionDifficulty,
                    state._cuesheetCustomStart.node_id,
                    nodeInfo.node_id
                );
                await _pickAndDisplayChallenge(customChallengeData);
            } catch (error) {
                console.error('Error setting up custom route:', error);
                showMessage('Error setting up custom route. Try again.', 'error');
            } finally {
                setLoadingState(false);
            }

            return true;
        }
    } catch (error) {
        console.error('Error during custom route click:', error);
        showMessage('Error finding intersection.', 'error');
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

    const cuesheetInput = document.querySelector('.cuesheet-input');
    if (cuesheetInput) cuesheetInput.style.display = '';

    generateCuesheetChallenge();
}

export async function getHint() {
    if (!state.cuesheetChallenge || state.cuesheetResults || !state._cuesheetRouteId) return;

    if (state._cuesheetReachedEnd) {
        showMessage('Route already reaches the destination — submit it!', 'success');
        return;
    }

    try {
        const result = await apiGetHint(state._cuesheetRouteId);

        if (result.message) {
            showMessage(result.message, 'info');
            return;
        }

        if (result.valid && result.cue) {
            // Add pre-turn name changes
            if (result.pre_turn_name_changes) {
                for (const nc of result.pre_turn_name_changes) {
                    state.cuesheetCues.push({
                        direction: 'S',
                        streetName: nc.street_name,
                        implicit: true,
                    });
                }
            }

            // Add the hint cue
            state.cuesheetCues.push({
                direction: result.cue.direction,
                streetName: result.cue.street_name,
            });

            // Add post-turn name changes
            if (result.post_turn_name_changes) {
                for (const nc of result.post_turn_name_changes) {
                    state.cuesheetCues.push({
                        direction: 'S',
                        streetName: nc.street_name,
                        implicit: true,
                    });
                }
            }

            // Update route rendering state
            _updateRouteFromResponse(result);

            drawLiveRoute();
            renderCueList();
            resetCueInput();

            if (result.reached_end) {
                showMessage('Route reaches the destination!', 'success');
            }
        }
    } catch (error) {
        console.error('Error getting hint:', error);
        showMessage('Error getting hint', 'error');
    }
}

// --- STREET AUTOCOMPLETE ---

let _activeIndex = -1;

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

    // Use street names from backend (stored in state)
    const allNames = state.streetNames || [];
    const normalizedQuery = normalizeStreetName(query);
    const matches = allNames.filter(name =>
        name.toLowerCase().includes(query) ||
        normalizeStreetName(name) === normalizedQuery
    ).slice(0, 8);

    if (matches.length === 0) {
        dropdown.style.display = 'none';
        _activeIndex = -1;
        return;
    }

    _activeIndex = -1;
    dropdown.innerHTML = '';
    matches.forEach((name) => {
        const div = document.createElement('div');
        div.className = 'cuesheet-suggestion';
        div.textContent = name;
        div.addEventListener('mousedown', (e) => {
            e.preventDefault();
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
