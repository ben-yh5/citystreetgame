import { state } from '../state.js';
import {
    updateModeUI,
    updateStats,
    showMessage,
    setLoadingState,
    updateDifficultyVisibility,
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
    const center = calculateBoundariesCenter(state.cityBoundaries);

    const previewInfo = document.getElementById('preview-info');
    const loadAreaGroup = document.getElementById('load-area-group');
    if (previewInfo) previewInfo.style.display = 'none';
    if (loadAreaGroup) loadAreaGroup.style.display = 'none';

    state.isPreviewMode = false;
    state.previousGameConfig = null;
    state.previewCity = null;

    toggleCityConfigMode(false);

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
        state.streetData = await fetchStreetsFromOSM(boundaries);
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

export function toggleCityConfigMode(forceState = null) {
    state.isSettingCenter = forceState ?? !state.isSettingCenter;
    const btn = document.getElementById('set-center-btn');

    if (!state.isSettingCenter) {
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
        btn.textContent = 'Configure';
        btn.classList.remove('active', 'preview');

        const previewInfo = document.getElementById('preview-info');
        const cityInputGroup = document.getElementById('city-input-group');
        const loadAreaGroup = document.getElementById('load-area-group');
        const cityInput = document.getElementById('city-input');
        const citySuggestions = document.getElementById('city-suggestions');

        if (previewInfo) previewInfo.style.display = 'none';
        if (cityInputGroup) {
            cityInputGroup.style.display = 'none';
        }
        if (loadAreaGroup) loadAreaGroup.style.display = 'none';

        if (cityInput) cityInput.value = '';
        if (citySuggestions) citySuggestions.style.display = 'none';

        if (!state.streetData) {
            ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
                if (state.map.getLayer(id)) state.map.removeLayer(id);
            });
            if (state.map.getSource('city-boundary')) state.map.removeSource('city-boundary');
        }
    } else {
        btn.textContent = 'Cancel';
        btn.classList.add('active');

        const cityInputGroup = document.getElementById('city-input-group');

        if (cityInputGroup) {
            cityInputGroup.style.display = 'block';

            setTimeout(() => {
                const cityInput = document.getElementById('city-input');
                if (cityInput) {
                    cityInput.focus();
                }
            }, 100);
        } else {
            console.error('cityInputGroup element not found!');
        }
    }

    updateDifficultyVisibility();
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
                        const btn = document.getElementById('set-center-btn');
                        btn.textContent = 'Cancel';
                        btn.classList.add('preview');

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

export function restoreGame(data) {
    state.gameMode = data.gameMode || 'streets';
    state.intersectionDifficulty = data.intersectionDifficulty || 'major-major';
    state.cityBoundaries = data.cityBoundaries;
    state.currentCenter = data.currentCenter;
    state.streetData = data.streetData || null;
    state.totalLength = data.totalLength || 0;
    state.foundStreets = new Set(data.foundStreets || []);
    state.foundIntersections = new Set(data.foundIntersections || []);
    state.intersectionScore = data.intersectionScore || 0;
    state.intersectionAccuracy = data.intersectionAccuracy || [];
    if (state.streetData) {
        rebuildStreetSegmentsData();
    }

    const gameModeSelect = document.getElementById('game-mode-select');
    if (gameModeSelect) gameModeSelect.value = state.gameMode;
    const difficultySelect = document.getElementById('difficulty-select');
    if (difficultySelect) difficultySelect.value = state.intersectionDifficulty;

    const restoreLayers = () => {
        if (!state.cityBoundaries || !state.streetData) return;

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
    };

    if (state.map.loaded()) {
        restoreLayers();
    } else {
        state.map.on('load', restoreLayers);
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
