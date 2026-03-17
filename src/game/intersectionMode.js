import { state } from '../state.js';
import { updateStats, showAccuracyFeedback } from './ui.js';
import { calculateDistanceMeters } from '../utils/geo.js';
import { saveGameState } from '../cache.js';
import { generateIntersectionChallenge } from '../api/backend.js';

export async function nextIntersection() {
    state.hasPlacedGuess = false;

    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
        state.userGuessMarker = null;
    }

    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');
    const targetIntersection = document.getElementById('target-intersection');

    if (!state.streetData || state.streetData.features.length === 0 || !state.cityId) {
        state.currentIntersection = null;
        if (targetIntersection) {
            targetIntersection.textContent = 'Click "Configure" to load a city first';
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            instructions.textContent = 'Load an area to start finding intersections';
        }
        return;
    }

    try {
        const result = await generateIntersectionChallenge(
            state.cityId, state.intersectionDifficulty
        );

        state.currentIntersection = {
            street1: result.street1,
            street2: result.street2,
            type1: result.type1,
            type2: result.type2,
            lat: result.locations[0].lat,
            lng: result.locations[0].lng,
            multipleLocations: result.multiple_locations,
            locationCount: result.location_count,
        };

        state.validIntersectionLocations = result.locations;

        if (targetIntersection) {
            let displayText = `${result.street1} & ${result.street2}`;
            if (result.multiple_locations) {
                displayText += ` (${result.location_count} locations)`;
            }
            targetIntersection.textContent = displayText;
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            const instructionText = result.multiple_locations
                ? 'Click near any intersection of these streets'
                : 'Click on the map to place your guess';
            instructions.textContent = instructionText;
        }
    } catch (error) {
        console.error('Error generating intersection challenge:', error);
        state.currentIntersection = null;
        if (targetIntersection) {
            targetIntersection.textContent = 'No more intersections available!';
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            instructions.textContent = 'Try changing difficulty or loading a different area';
        }
    }
}

export function handleMapClick(e) {
    if (state.gameMode !== 'intersections' || !state.currentIntersection) return;

    const clickLat = e.lngLat.lat;
    const clickLng = e.lngLat.lng;

    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
    }

    state.userGuessMarker = new mapboxgl.Marker({ color: '#ff6464' })
        .setLngLat([clickLng, clickLat])
        .addTo(state.map);

    state.hasPlacedGuess = true;

    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');

    if (submitBtn) submitBtn.style.display = 'inline-block';
    if (instructions) instructions.textContent = 'Click Submit Guess or press Enter to confirm';
}

export function submitGuess() {
    if (!state.currentIntersection || !state.hasPlacedGuess || !state.userGuessMarker) return;

    const guessLngLat = state.userGuessMarker.getLngLat();
    const clickLat = guessLngLat.lat;
    const clickLng = guessLngLat.lng;

    let closestDistance = Infinity;
    let bestLocation = state.validIntersectionLocations[0];

    state.validIntersectionLocations.forEach(location => {
        const distance = calculateDistanceMeters(clickLat, clickLng, location.lat, location.lng);
        if (distance < closestDistance) {
            closestDistance = distance;
            bestLocation = location;
        }
    });

    const accuracy = Math.max(0, 1000 - closestDistance);
    const points = Math.floor(accuracy);

    const actualMarkers = [];
    state.validIntersectionLocations.forEach((location, index) => {
        const color = index === state.validIntersectionLocations.indexOf(bestLocation) ? '#00c8ff' : '#00ff88';
        const marker = new mapboxgl.Marker({ color: color })
            .setLngLat([location.lng, location.lat])
            .addTo(state.map);
        actualMarkers.push(marker);
    });

    const lineData = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [[clickLng, clickLat], [bestLocation.lng, bestLocation.lat]]
            }
        }]
    };

    if (state.map.getSource('guess-line')) {
        state.map.removeLayer('guess-line');
        state.map.removeSource('guess-line');
    }

    state.map.addSource('guess-line', {
        type: 'geojson',
        data: lineData
    });

    state.map.addLayer({
        id: 'guess-line',
        type: 'line',
        source: 'guess-line',
        paint: {
            'line-color': '#ffff00',
            'line-width': 3,
            'line-dasharray': [2, 2]
        }
    });

    const key = `${state.currentIntersection.street1}|${state.currentIntersection.street2}`;
    state.foundIntersections.add(key);
    state.intersectionScore += points;
    state.intersectionAccuracy.push(closestDistance);

    showAccuracyFeedback(closestDistance, points);
    updateStats();
    saveGameState();

    setTimeout(() => {
        if (state.userGuessMarker) {
            state.userGuessMarker.remove();
            state.userGuessMarker = null;
        }

        actualMarkers.forEach(m => m.remove());

        if (state.map.getSource('guess-line')) {
            state.map.removeLayer('guess-line');
            state.map.removeSource('guess-line');
        }

        nextIntersection();
    }, 2500);
}
