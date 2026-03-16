import { state } from './src/state.js';
import { initMap, hideStreetTooltip } from './src/map/mapbox.js';
import {
    switchGameMode,
    confirmAndLoadCity,
    toggleCityConfigMode,
    resetGame,
    handleCitySearch,
    undo,
    redo,
    restoreGame
} from './src/game/core.js';
import { handleStreetInput, filterFoundItems, autofillNumberedStreets } from './src/game/streets.js';
import { handleMapClick, submitGuess, nextIntersection } from './src/game/intersectionMode.js';
import { addCue, selectDirection, submitCuesheet, skipChallenge, getHint, generateCuesheetChallenge, handleStreetAutocomplete, handleSuggestionKeydown, hideSuggestions, startCustomRoute, cancelCustomRoute, handleCustomRouteClick } from './src/game/cuesheet.js';
import { setLoadingState } from './src/game/ui.js';
import { loadGameState, saveGameState } from './src/cache.js';

// --- EVENT LISTENERS ---
document.addEventListener('DOMContentLoaded', function() {
    if (typeof mapboxgl === 'undefined') {
        const loadingText = document.getElementById('loading-text');
        if (loadingText) loadingText.textContent = 'Error: Mapbox GL JS failed to load.';
        return;
    }

    setLoadingState(false);
    initMap();

    if (state.map) {
         state.map.on('click', (e) => {
             if (state.gameMode === 'cuesheet' && state._cuesheetCustomPicking) {
                 handleCustomRouteClick(e.lngLat);
                 return;
             }
             handleMapClick(e);
         });
    }

    // Mode selector
    const gameModeSelect = document.getElementById('game-mode-select');
    if (gameModeSelect) {
        gameModeSelect.addEventListener('change', (e) => {
            switchGameMode(e.target.value);
        });
    }

    // Difficulty selector
    const difficultySelect = document.getElementById('difficulty-select');
    if (difficultySelect) {
        difficultySelect.addEventListener('change', (e) => {
            state.intersectionDifficulty = e.target.value;
            if (state.streetData && state.gameMode === 'intersections') {
                nextIntersection();
            } else if (state.streetData && state.gameMode === 'cuesheet') {
                generateCuesheetChallenge();
            }
            saveGameState();
        });
    }

    // Intersection mode submit button
    const submitGuessBtn = document.getElementById('submit-guess-btn');
    if (submitGuessBtn) {
        submitGuessBtn.addEventListener('click', submitGuess);
    }

    const streetInput = document.getElementById('street-input');
    if (streetInput) {
        streetInput.addEventListener('keypress', e => { if (e.key === 'Enter') handleStreetInput(); });
    }

    const loadAreaBtn = document.getElementById('load-area-btn');
    if (loadAreaBtn) {
        loadAreaBtn.addEventListener('click', () => confirmAndLoadCity());
    }

    const setCenterBtn = document.getElementById('set-center-btn');
    if (setCenterBtn) {
        setCenterBtn.addEventListener('click', () => {
            toggleCityConfigMode();
        });
    }

    const showUnfoundToggle = document.getElementById('show-unfound-toggle');
    if (showUnfoundToggle) {
        showUnfoundToggle.addEventListener('change', (e) => {
            if(state.map && state.map.getLayer('streets-unfound')) {
                state.map.setPaintProperty('streets-unfound', 'line-opacity', e.target.checked ? 0.2 : 0);
            }
        });
    }

    const showStreetNamesToggle = document.getElementById('show-street-names-toggle');
    if (showStreetNamesToggle) {
        showStreetNamesToggle.addEventListener('change', (e) => {
            if (!e.target.checked) {
                hideStreetTooltip();
            }
        });
    }

    const autofillBtn = document.getElementById('autofill-btn');
    if (autofillBtn) {
        autofillBtn.addEventListener('click', autofillNumberedStreets);
    }

    const cityInput = document.getElementById('city-input');
    if (cityInput) {
        cityInput.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.trim();
                if (query) {
                    await handleCitySearch(query);
                }
            }
        });
    }

    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => resetGame());
    }

    document.addEventListener('click', (e) => {
        const cityInputGroup = document.getElementById('city-input-group');
        const citySuggestions = document.getElementById('city-suggestions');
        if (cityInputGroup && citySuggestions && !cityInputGroup.contains(e.target)) {
            citySuggestions.style.display = 'none';
        }
    });

    const itemSearch = document.getElementById('item-search');
    if (itemSearch) {
        itemSearch.addEventListener('input', (e) => {
            filterFoundItems(e.target.value);
        });
    }

    // --- CUESHEET MODE EVENT LISTENERS ---
    const cuesheetDirBtns = document.getElementById('cuesheet-dir-btns');
    if (cuesheetDirBtns) {
        cuesheetDirBtns.addEventListener('click', (e) => {
            const btn = e.target.closest('.dir-btn');
            if (btn) {
                selectDirection(btn.dataset.dir);
            }
        });
    }

    const cuesheetStreetInput = document.getElementById('cuesheet-street-input');
    if (cuesheetStreetInput) {
        // Handle l:/r: shortcut and autocomplete
        cuesheetStreetInput.addEventListener('input', () => {
            const val = cuesheetStreetInput.value;
            const match = val.match(/:([lrs])/i) || val.match(/([lrs]):/i);
            if (match) {
                const dir = match[1].toUpperCase();
                selectDirection(dir);
                cuesheetStreetInput.value = val.slice(0, match.index) + val.slice(match.index + match[0].length);
            }
            handleStreetAutocomplete();
        });

        cuesheetStreetInput.addEventListener('keydown', (e) => {
            handleSuggestionKeydown(e);
        });

        cuesheetStreetInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addCue();
            }
        });

        cuesheetStreetInput.addEventListener('blur', () => {
            // Delay to allow mousedown on suggestion to fire first
            setTimeout(hideSuggestions, 150);
        });
    }

    const cuesheetAddBtn = document.getElementById('cuesheet-add-btn');
    if (cuesheetAddBtn) {
        cuesheetAddBtn.addEventListener('click', () => addCue());
    }

    const cuesheetSubmitBtn = document.getElementById('cuesheet-submit-btn');
    if (cuesheetSubmitBtn) {
        cuesheetSubmitBtn.addEventListener('click', () => submitCuesheet());
    }

    const cuesheetHintBtn = document.getElementById('cuesheet-hint-btn');
    if (cuesheetHintBtn) {
        cuesheetHintBtn.addEventListener('click', () => getHint());
    }

    const cuesheetSkipBtn = document.getElementById('cuesheet-skip-btn');
    if (cuesheetSkipBtn) {
        cuesheetSkipBtn.addEventListener('click', () => skipChallenge());
    }

    const cuesheetCustomBtn = document.getElementById('cuesheet-custom-btn');
    if (cuesheetCustomBtn) {
        cuesheetCustomBtn.addEventListener('click', () => {
            if (state._cuesheetCustomPicking) {
                cancelCustomRoute();
            } else {
                startCustomRoute();
            }
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.gameMode === 'intersections' && state.hasPlacedGuess) {
            submitGuess();
            return;
        }

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

        if (ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        } else if (ctrlKey && e.key.toLowerCase() === 'z' && e.shiftKey) {
            e.preventDefault();
            redo();
        }
    });

    // Restore from cache or initialize fresh
    const savedData = loadGameState();
    if (savedData && savedData.streetData) {
        restoreGame(savedData);
    } else {
        switchGameMode(state.gameMode);
    }
});
