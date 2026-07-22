import { state } from '../state.js';
import {
    updateModeUI,
    updateStats,
    showMessage,
    setLoadingState,
    updateLocationLabel,
} from './ui.js';
import {
    setupCityMapLayers,
    setupCityPreview,
    clearHighlight,
    updateFoundStreetsLayer,
} from '../map/mapbox.js';
import {
    fetchStreetsFromOSM,
    getCityBoundaries,
    searchCities,
    FALLBACK_SEATTLE,
} from '../api/osm.js';
import {
    calculateBoundariesCenter,
    getLargestPolygon,
} from '../utils/geo.js';
import { saveGameState } from '../cache.js';
import { nextIntersection } from './intersectionMode.js';
import { addStreetToList, setSaveState } from './streets.js';
import { generateCuesheetChallenge, cleanupCuesheetMapLayers } from './cuesheet.js';

// --- GAME LOGIC ---

export function switchGameMode(newMode) {
    state.gameMode = newMode;
    updateModeUI();

    if (state.streetData) {
        resetGame(false);
    }
    saveGameState();
}

export function resetGame(fullReload = true) {
    if (!state.streetData) return;
    state.foundStreets.clear();
    state.foundIntersections.clear();
    state.intersectionScore = 0;
    state.intersectionAccuracy = [];
    state.hasPlacedGuess = false;
    state.validIntersectionLocations = [];

    // Clean up intersection mode elements
    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
        state.userGuessMarker = null;
    }

    if (state.map.getSource('guess-line')) {
        state.map.removeLayer('guess-line');
        state.map.removeSource('guess-line');
    }

    // Clean up cuesheet mode elements
    cleanupCuesheetMapLayers();
    state.cuesheetCues = [];
    state.cuesheetResults = null;
    state.cuesheetChallenge = null;
    state._cuesheetRoute = null;
    const cuesheetList = document.getElementById('cuesheet-list');
    if (cuesheetList) cuesheetList.innerHTML = '';

    // Only clear the found items list if we're in streets mode
    if (state.gameMode === 'streets') {
        const foundItemsList = document.getElementById('found-items-list');
        const itemSearch = document.getElementById('item-search');

        if (foundItemsList) foundItemsList.innerHTML = '';
        if (itemSearch) itemSearch.value = '';
    }

    state.undoHistory = [];
    state.redoHistory = [];
    updateUndoRedoButtons();

    if (state.map.getLayer('streets-found')) {
        state.map.setFilter('streets-found', ['in', ['get', 'name'], ['literal', []]]);
    }

    clearHighlight();

    if (state.gameMode === 'intersections') {
        nextIntersection();
    } else if (state.gameMode === 'cuesheet') {
        generateCuesheetChallenge();
    }

    updateStats();
    saveGameState();
    if (fullReload) {
        if (state.cityBoundaries) {
            const center = calculateBoundariesCenter(state.cityBoundaries);
            loadStreetsForCity(state.cityBoundaries, center[1], center[0]);
        }
    } else {
        if (state.currentCenter) {
            state.map.flyTo({ center: state.currentCenter, zoom: 10, duration: 1000 });
        }
    }
    const messageElement = document.getElementById('message');
    if (messageElement) messageElement.classList.remove('show');
}

export function confirmAndLoadCity() {
    if (!state.previewCity) return;

    state.cityBoundaries = state.previewCity.boundaries;
    state.selectedCityOsmId = state.previewCity.osmId ?? null;
    state.selectedCityOsmType = state.previewCity.osmType ?? null;
    state.currentCityName = state.previewCity.name ?? null;
    updateLocationLabel();
    const center = calculateBoundariesCenter(state.cityBoundaries);

    state.isPreviewMode = false;
    state.previousGameConfig = null;
    state.previewCity = null;

    clearCityPreviewUI();

    loadStreetsForCity(state.cityBoundaries, center[1], center[0]);
}

export async function loadStreetsForCity(boundaries, lat, lng) {
    state.currentCenter = [lng, lat];

    const mainBoundary = getLargestPolygon(boundaries);
    const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
    let areaDescription = 'selected area';

    if (coords.length > 0) {
        const lats = coords.map(c => c[1]);
        const lngs = coords.map(c => c[0]);
        const latSpan = Math.max(...lats) - Math.min(...lats);
        const lonSpan = Math.max(...lngs) - Math.min(...lngs);
        const roughKm = Math.max(latSpan, lonSpan) * 111;

        if (roughKm < 5) {
            areaDescription = 'neighbourhood';
        } else if (roughKm < 15) {
            areaDescription = 'district';
        } else if (roughKm < 40) {
            areaDescription = 'city area';
        } else {
            areaDescription = 'large area';
        }
    }

    setLoadingState(true, `Fetching streets for ${areaDescription}...`);

    try {
        state.streetData = await fetchStreetsFromOSM(boundaries, {
            osmId: state.selectedCityOsmId,
            osmType: state.selectedCityOsmType,
        });
        state.streetGraph = null;
        state.totalLength = state.streetData.features.reduce((sum, f) => sum + f.properties.length, 0);

        setupCityMapLayers(boundaries, lat, lng);

        resetGame(false);

        const streetInput = document.getElementById('street-input');
        const resetBtn = document.getElementById('reset-btn');
        if (streetInput) {
            streetInput.disabled = false;
            streetInput.placeholder = 'ENTER A STREET';
        }
        if (resetBtn) resetBtn.disabled = false;
        saveGameState();

    } catch (error) {
        console.error('Error loading streets:', error);
        showMessage('Error loading street data. Please try again.', 'error');
    } finally {
        setTimeout(() => setLoadingState(false), 500);
    }
}

export async function loadDefaultCity() {
    setLoadingState(true, `Fetching boundaries for ${FALLBACK_SEATTLE.name}...`);
    try {
        const boundaries = await getCityBoundaries(FALLBACK_SEATTLE.osmType, FALLBACK_SEATTLE.osmId, FALLBACK_SEATTLE);
        if (!boundaries) {
            setLoadingState(false);
            return;
        }

        state.cityBoundaries = getLargestPolygon(boundaries);
        state.selectedCityOsmId = FALLBACK_SEATTLE.osmId;
        state.selectedCityOsmType = FALLBACK_SEATTLE.osmType;
        state.currentCityName = FALLBACK_SEATTLE.name;
        updateLocationLabel();

        const center = calculateBoundariesCenter(state.cityBoundaries);
        await loadStreetsForCity(state.cityBoundaries, center[1], center[0]);
    } catch (error) {
        console.error('Error loading default city:', error);
        setLoadingState(false);
    }
}

// Resets the location UI back to its idle state (no pending preview).
// Shared by committing a preview (confirmAndLoadCity) and canceling one (cancelCityPreview).
function clearCityPreviewUI() {
    const previewInfo = document.getElementById('preview-info');
    const loadAreaGroup = document.getElementById('load-area-group');
    const cityInput = document.getElementById('city-input');
    const citySuggestions = document.getElementById('city-suggestions');

    if (previewInfo) previewInfo.style.display = 'none';
    if (loadAreaGroup) loadAreaGroup.style.display = 'none';
    if (cityInput) cityInput.value = '';
    if (citySuggestions) citySuggestions.style.display = 'none';

    if (!state.streetData) {
        ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
            if (state.map.getLayer(id)) state.map.removeLayer(id);
        });
        if (state.map.getSource('city-boundary')) state.map.removeSource('city-boundary');
    }
}

// Reverts an in-progress city preview (from picking a search suggestion) without loading it.
export function cancelCityPreview() {
    if (state.isPreviewMode && state.previousGameConfig) {
        state.cityBoundaries = state.previousGameConfig.boundaries;
        state.GAME_CENTER = [...state.previousGameConfig.center];

        if (state.streetData && state.cityBoundaries) {
            const center = calculateBoundariesCenter(state.cityBoundaries);
            setupCityMapLayers(state.cityBoundaries, center[1], center[0]);
        }
    }

    state.isPreviewMode = false;
    state.previewCity = null;
    state.previousGameConfig = null;

    clearCityPreviewUI();
}

// --- UNDO/REDO ---
export function saveState() {
    const historyState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };

    state.undoHistory.push(historyState);
    if (state.undoHistory.length > state.maxHistorySize) {
        state.undoHistory.shift();
    }

    state.redoHistory = [];
    updateUndoRedoButtons();
}

// Wire up saveState for streets module
setSaveState(saveState);

export function undo() {
    if (state.undoHistory.length === 0) return;

    const currentState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };
    state.redoHistory.push(currentState);

    const prevState = state.undoHistory.pop();
    state.foundStreets = new Set(prevState.foundStreets);
    state.foundIntersections = new Set(prevState.foundIntersections);

    rebuildFoundItemsList();
    if (state.gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
    saveGameState();
}

export function redo() {
    if (state.redoHistory.length === 0) return;

    const currentState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };
    state.undoHistory.push(currentState);

    const nextState = state.redoHistory.pop();
    state.foundStreets = new Set(nextState.foundStreets);
    state.foundIntersections = new Set(nextState.foundIntersections);

    rebuildFoundItemsList();
    if (state.gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
    saveGameState();
}

function updateUndoRedoButtons() {
}

function rebuildFoundItemsList() {
    const list = document.getElementById('found-items-list');
    if (!list) return;

    list.innerHTML = '';

    if (state.gameMode === 'streets') {
        const foundStreetNames = Array.from(state.foundStreets).map(key =>
            state.streetData.features.find(f => f.properties.name.toLowerCase() === key)?.properties.name
        ).filter(Boolean);

        foundStreetNames.forEach(streetName => {
            addStreetToList(streetName, false);
        });
    }
}

// --- CITY SEARCH ---
export async function handleCitySearch(query) {
    const suggestionsDiv = document.getElementById('city-suggestions');
    if (!suggestionsDiv) return;

    if (!query || query.length < 2) {
        suggestionsDiv.style.display = 'none';
        return;
    }

    suggestionsDiv.innerHTML = '<div class="city-suggestion">Searching...</div>';
    suggestionsDiv.style.display = 'block';

    try {
        const cities = await searchCities(query);
        showCitySuggestions(cities);
    } catch (error) {
        console.error('Error searching cities:', error);
        suggestionsDiv.innerHTML = '<div class="city-suggestion">Error searching. Try again.</div>';
    }
}

function showCitySuggestions(cities) {
    const suggestionsDiv = document.getElementById('city-suggestions');
    if (!suggestionsDiv) return;

    if (cities.length === 0) {
        suggestionsDiv.innerHTML = '<div class="city-suggestion">No results found. Try a different search term.</div>';
        return;
    }

    suggestionsDiv.innerHTML = '';

    cities.forEach(city => {
        const suggestion = document.createElement('div');
        suggestion.className = 'city-suggestion';

        const placeTypeDisplay = city.placeType ?
            city.placeType.charAt(0).toUpperCase() + city.placeType.slice(1) : 'Place';

        suggestion.innerHTML = `
            <div class="city-suggestion-name">${city.name}</div>
            <div class="city-suggestion-details">${placeTypeDisplay} • ${city.fullName}</div>
        `;

        suggestion.addEventListener('click', async () => {
            const cityInput = document.getElementById('city-input');
            if (cityInput) cityInput.value = city.name;
            suggestionsDiv.style.display = 'none';

             try {
                setLoadingState(true, `Fetching boundaries for ${city.name}...`);
                const boundaries = await getCityBoundaries(city.osmType, city.osmId, city);

                if (boundaries) {
                    setupCityPreview(boundaries);

                    if (!state.isPreviewMode) {
                        state.previousGameConfig = {
                            boundaries: state.cityBoundaries,
                            center: [...state.GAME_CENTER]
                        };

                        state.isPreviewMode = true;

                        const previewInfo = document.getElementById('preview-info');
                        if (previewInfo) {
                            previewInfo.style.display = 'block';
                             const locationType = city.placeType ?
                                city.placeType.charAt(0).toUpperCase() + city.placeType.slice(1) : 'Area';
                            const mainBoundary = getLargestPolygon(boundaries);
                            const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
                            const boundaryInfo = 'official';

                            previewInfo.textContent = `${locationType} boundary (${boundaryInfo}) preview shown. Click "Load New Area" to start the game.`;
                        }

                        document.getElementById('load-area-group').style.display = 'block';

                        state.previewCity = {
                            ...city,
                            boundaries: getLargestPolygon(boundaries)
                        };
                    } else {
                         state.previewCity = {
                            ...city,
                            boundaries: getLargestPolygon(boundaries)
                        };
                    }

                } else {
                    showMessage('Could not create boundaries for this location. Try a different place.', 'error');
                }
            } catch (error) {
                console.error('Error fetching city boundaries:', error);
                showMessage('Error fetching location data. Try again.', 'error');
            } finally {
                setLoadingState(false);
            }
        });

        suggestionsDiv.appendChild(suggestion);
    });

    suggestionsDiv.style.display = 'block';
}

// --- CACHE RESTORE ---

export async function restoreGame(data) {
    state.gameMode = data.gameMode || 'streets';
    state.intersectionDifficulty = data.intersectionDifficulty || 'major-major';
    state.cityBoundaries = data.cityBoundaries;
    state.currentCenter = data.currentCenter;
    state.selectedCityOsmId = data.selectedCityOsmId ?? null;
    state.selectedCityOsmType = data.selectedCityOsmType ?? null;
    state.currentCityName = data.currentCityName ?? null;
    updateLocationLabel();
    state.foundStreets = new Set(data.foundStreets || []);
    state.foundIntersections = new Set(data.foundIntersections || []);
    state.intersectionScore = data.intersectionScore || 0;
    state.intersectionAccuracy = data.intersectionAccuracy || [];

    updateModeUI();
    const difficultySelect = document.getElementById('difficulty-select');
    if (difficultySelect) difficultySelect.value = state.intersectionDifficulty;

    if (!state.cityBoundaries) return;

    // Street geometry itself isn't persisted (too large for localStorage) —
    // refetch it for the saved area/city and rehydrate found streets/intersections on top.
    setLoadingState(true, 'Restoring your last session...');
    try {
        state.streetData = await fetchStreetsFromOSM(state.cityBoundaries, {
            osmId: state.selectedCityOsmId,
            osmType: state.selectedCityOsmType,
        });
        state.totalLength = state.streetData.features.reduce((sum, f) => sum + f.properties.length, 0);
        rebuildStreetSegmentsData();

        const finishRestore = () => {
            setupCityMapLayers(state.cityBoundaries, state.currentCenter[1], state.currentCenter[0]);

            if (state.foundStreets.size > 0) {
                updateFoundStreetsLayer();
            }
            rebuildFoundItemsList();

            const streetInput = document.getElementById('street-input');
            const resetBtn = document.getElementById('reset-btn');
            if (streetInput) { streetInput.disabled = false; streetInput.placeholder = 'ENTER A STREET'; }
            if (resetBtn) resetBtn.disabled = false;

            if (state.gameMode === 'intersections') {
                nextIntersection();
            } else if (state.gameMode === 'cuesheet') {
                generateCuesheetChallenge();
            }

            updateModeUI();
            updateStats();
            saveGameState();
        };

        if (state.map.loaded()) {
            finishRestore();
        } else {
            state.map.on('load', finishRestore);
        }
    } catch (error) {
        console.error('Error restoring last session:', error);
        showMessage('Could not restore your last session. Try loading an area again.', 'error');
    } finally {
        setTimeout(() => setLoadingState(false), 500);
    }
}

function rebuildStreetSegmentsData() {
    state.streetSegmentsData = new Map();
    if (!state.streetData) return;

    state.streetData.features.forEach(feature => {
        const name = feature.properties.name;
        const type = feature.properties.type;
        const highway = feature.properties.highway;
        const segments = [];

        if (feature.geometry.type === 'LineString') {
            segments.push({
                coordinates: feature.geometry.coordinates,
                type,
                highway,
                length: feature.properties.length
            });
        } else if (feature.geometry.type === 'MultiLineString') {
            const segCount = feature.geometry.coordinates.length;
            feature.geometry.coordinates.forEach(coords => {
                segments.push({
                    coordinates: coords,
                    type,
                    highway,
                    length: feature.properties.length / segCount
                });
            });
        }

        state.streetSegmentsData.set(name, segments);
    });
}
