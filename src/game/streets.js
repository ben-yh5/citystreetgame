import { state } from '../state.js';
import { showMessage, updateStats } from './ui.js';
import { updateFoundStreetsLayer, highlightStreet, clearHighlight } from '../map/mapbox.js';
import { normalizeStreetName, abbreviateStreetName } from '../utils/string.js';
import { saveGameState } from '../cache.js';

// Forward reference - set by core.js to avoid circular dependency
let _saveState = null;
export function setSaveState(fn) { _saveState = fn; }

export function handleStreetInput() {
    if (!state.streetData) return;

    const inputField = document.getElementById('street-input');
    const inputValue = inputField.value.trim();

    if (!inputValue) return;

    const values = inputValue.split(',').map(v => v.trim()).filter(v => v.length > 0);
    let anyFound = false;

    values.forEach(value => {
        if (checkStreet(value)) {
            anyFound = true;
        }
    });

    inputField.value = '';
}

function checkStreet(value) {
    if (!state.streetData || !value) return false;

    const matchedStreets = findAllMatchingStreets(value);
    let newStreetsFound = false;
    let streetsToAdd = [];

    if (matchedStreets.length > 0) {
        for (const street of matchedStreets) {
            const streetKey = street.properties.name.toLowerCase();
            if (!state.foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                newStreetsFound = true;
            }
        }

        if (newStreetsFound) {
            if (_saveState) _saveState();

            streetsToAdd.forEach(streetName => {
                state.foundStreets.add(streetName.toLowerCase());
                addStreetToList(streetName, false);
            });

            updateFoundStreetsLayer();
            updateStats();
            saveGameState();
            showMessage(`Found ${matchedStreets.length} street(s) for "${value}"!`, 'success');
        } else {
            showMessage(`You already found all streets for "${value}"!`, 'error');
        }
    } else {
        showMessage('Street not found. Try a different name or spelling.', 'error');
    }

    return newStreetsFound;
}

export function findAllMatchingStreets(inputName) {
    if (!state.streetData || !inputName) return [];

    const inputLower = inputName.toLowerCase();
    const exactMatches = state.streetData.features.filter(f => f.properties.name.toLowerCase() === inputLower);

    if (exactMatches.length > 0) {
        return exactMatches;
    }

    // Abbreviation match: "Main Ave" matches "Main Avenue" but NOT "Main Place"
    const inputAbbr = abbreviateStreetName(inputName);
    const abbrMatches = state.streetData.features.filter(f => abbreviateStreetName(f.properties.name) === inputAbbr);

    if (abbrMatches.length > 0) {
        return abbrMatches;
    }

    // Aggressive match: strip all suffixes (e.g. "Main" matches "Main Street")
    const inputNormalized = normalizeStreetName(inputName);
    return state.streetData.features.filter(f => normalizeStreetName(f.properties.name) === inputNormalized);
}

export function addStreetToList(streetName, saveToHistory = true) {
    const list = document.getElementById('found-items-list');
    if (!list) return;

    const item = document.createElement('div');
    item.className = 'found-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = streetName;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-item-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete street';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteStreet(streetName);
    });

    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);

    item.addEventListener('mousedown', (e) => {
        if (e.target === deleteBtn) return;
        item.classList.add('holding');
        highlightStreet(streetName);

        state.holdTimeout = setTimeout(() => {
        }, 1000);
    });

    item.addEventListener('mouseup', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (state.holdTimeout) {
            clearTimeout(state.holdTimeout);
            state.holdTimeout = null;
        }
    });

    item.addEventListener('mouseleave', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (state.holdTimeout) {
            clearTimeout(state.holdTimeout);
            state.holdTimeout = null;
        }
    });

    nameSpan.addEventListener('dblclick', () => {
        const streetFeatures = state.streetData.features.filter(f => f.properties.name === streetName);
        if (streetFeatures.length > 0) {
             const bounds = new mapboxgl.LngLatBounds();
             streetFeatures.forEach(feature => {
                 if (feature.geometry.type === 'LineString') {
                     feature.geometry.coordinates.forEach(c => bounds.extend(c));
                 } else if (feature.geometry.type === 'MultiLineString') {
                     feature.geometry.coordinates.forEach(bg => bg.forEach(c => bounds.extend(c)));
                 }
             });
             state.map.fitBounds(bounds, {
                padding: 50,
                maxZoom: 16,
                duration: 1000
            });
        }
    });

    list.prepend(item);
}

export function deleteStreet(streetName) {
    const streetKey = streetName.toLowerCase();
    if (state.foundStreets.has(streetKey)) {
        if (_saveState) _saveState();
        state.foundStreets.delete(streetKey);

        const items = document.querySelectorAll('.found-item');
        items.forEach(item => {
            if (item.querySelector('.item-name').textContent === streetName) {
                item.remove();
            }
        });

        updateFoundStreetsLayer();
        updateStats();
        saveGameState();
        showMessage(`Removed "${streetName}"`, 'success');
    }
}

export function autofillNumberedStreets() {
    const from = parseInt(document.getElementById('autofill-from').value);
    const to = parseInt(document.getElementById('autofill-to').value);
    if (isNaN(from) || isNaN(to) || from > to) {
        showMessage('Invalid number range for autofill.', 'error');
        return;
    }

    let foundAny = false;
    let streetsToAdd = [];

    for (let i = from; i <= to; i++) {
        const streetName = i + getOrdinalSuffix(i);
        const matchedStreets = findAllMatchingStreets(streetName);
        for (const street of matchedStreets) {
            const streetKey = street.properties.name.toLowerCase();
            if (!state.foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                foundAny = true;
            }
        }
    }

    if (foundAny) {
        if (_saveState) _saveState();

        streetsToAdd.forEach(streetName => {
            state.foundStreets.add(streetName.toLowerCase());
            addStreetToList(streetName, false);
        });

        updateFoundStreetsLayer();
        updateStats();
        saveGameState();
        showMessage(`Found ${streetsToAdd.length} numbered streets in range ${from}-${to}.`, 'success');
    } else {
        showMessage(`No new numbered streets found in range ${from}-${to}.`, 'error');
    }
}

function getOrdinalSuffix(i) {
    const j = i % 10, k = i % 100;
    if (j == 1 && k != 11) return "st";
    if (j == 2 && k != 12) return "nd";
    if (j == 3 && k != 13) return "rd";
    return "th";
}

export function filterFoundItems(searchTerm) {
    const items = document.querySelectorAll('.found-item');
    const term = searchTerm.toLowerCase();

    items.forEach(item => {
        const itemNameElement = item.querySelector('.item-name');
        const itemName = itemNameElement ? itemNameElement.textContent.toLowerCase() : '';
        if (itemName.includes(term)) {
            item.classList.remove('hidden');
        } else {
            item.classList.add('hidden');
        }
    });
}
