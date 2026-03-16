import { state } from '../state.js';

export function showMessage(text, type) {
    const messageDiv = document.getElementById('message');
    if (!messageDiv) return;
    
    messageDiv.textContent = text;
    messageDiv.className = `message ${type} show`;
    setTimeout(() => messageDiv.classList.remove('show'), 3000);
}

function setUnfoundStreets(on) {
    const toggle = document.getElementById('show-unfound-toggle');
    if (toggle) toggle.checked = on;
    if (state.map && state.map.getLayer('streets-unfound')) {
        state.map.setPaintProperty('streets-unfound', 'line-opacity', on ? 0.2 : 0);
    }
}

export function setLoadingState(isLoading, text = '') {
    const screen = document.getElementById('loading-screen');
    const textEl = document.getElementById('loading-text');
    const inputs = ['street-input', 'reset-btn', 'load-area-btn', 'set-center-btn', 'autofill-btn'];
    
    if (screen) {
        if (isLoading) {
            screen.classList.remove('hidden');
        } else {
            screen.classList.add('hidden');
        }
    }
    
    if (textEl && isLoading) {
        textEl.textContent = text;
    }
    
    inputs.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = isLoading;
    });
}

export function updateStats() {
    if (!state.streetData) return;
    
    const scoreElement = document.getElementById('score');
    
    if (state.gameMode === 'streets') {
        const foundLength = state.streetData.features.filter(f => state.foundStreets.has(f.properties.name.toLowerCase())).reduce((sum, f) => sum + f.properties.length, 0);
        const distancePercentage = state.totalLength > 0 ? (foundLength / state.totalLength * 100).toFixed(2) : '0.00';
        const countPercentage = state.streetData.features.length > 0 ? (state.foundStreets.size / state.streetData.features.length * 100).toFixed(2) : '0.00';
        
        if (scoreElement) scoreElement.textContent = `${distancePercentage}%`;
        
        const foundCountEl = document.getElementById('found-count');
        const totalCountEl = document.getElementById('total-count');
        if (foundCountEl) foundCountEl.textContent = state.foundStreets.size;
        if (totalCountEl) totalCountEl.textContent = state.streetData.features.length;
        
        const countPercentageEl = document.getElementById('count-percentage');
        if (countPercentageEl) {
            countPercentageEl.textContent = `${countPercentage}%`;
        }
        
        const totalDistanceEl = document.getElementById('total-distance');
        if (totalDistanceEl) {
            totalDistanceEl.textContent = state.totalLength.toFixed(1);
        }
    } else if (state.gameMode === 'intersections') {
        const avgAccuracy = state.intersectionAccuracy.length > 0 ? 
            state.intersectionAccuracy.reduce((sum, acc) => sum + acc, 0) / state.intersectionAccuracy.length : 0;
        
        // Only show the main score - average accuracy in meters
        if (scoreElement) scoreElement.textContent = `${Math.round(avgAccuracy)}m`;
    }
}

export function updateModeUI() {
    const streetInputContainer = document.getElementById('street-input-container');
    const intersectionDisplayContainer = document.getElementById('intersection-display-container');
    const autofillSection = document.getElementById('autofill-section');
    const foundItemsSection = document.getElementById('found-items-section');
    const foundListTitle = document.getElementById('found-list-title');
    const itemSearch = document.getElementById('item-search');
    const scoreLabel = document.getElementById('score-label');
    
    // Stats elements with null checks
    const foundStat = document.getElementById('found-stat');
    const percentageStat = document.getElementById('percentage-stat');
    const totalStat = document.getElementById('total-stat');
    const distanceStat = document.getElementById('distance-stat');
    
    // Restore sections that may have been hidden by other modes
    const statsSection = document.getElementById('stats-section');
    const foundItemsSec = document.getElementById('found-items-section');
    const mapToolsSection = document.getElementById('map-tools-section');
    if (statsSection) statsSection.style.display = '';
    if (foundItemsSec) foundItemsSec.style.display = '';
    if (mapToolsSection) mapToolsSection.style.display = '';

    if (state.gameMode === 'streets') {
        if (streetInputContainer) streetInputContainer.style.display = 'block';
        if (intersectionDisplayContainer) intersectionDisplayContainer.style.display = 'none';
        if (autofillSection) autofillSection.style.display = 'block';
        if (foundItemsSection) foundItemsSection.style.display = 'flex';
        if (foundListTitle) foundListTitle.textContent = 'Found Streets';
        if (itemSearch) itemSearch.placeholder = 'Search found streets...';
        if (scoreLabel) scoreLabel.textContent = 'of street distance';

        // Show all stats for street mode
        if (foundStat) foundStat.style.display = 'block';
        if (percentageStat) percentageStat.style.display = 'block';
        if (totalStat) totalStat.style.display = 'block';
        if (distanceStat) distanceStat.style.display = 'block';

        setUnfoundStreets(false);

    } else if (state.gameMode === 'intersections') {
        if (streetInputContainer) streetInputContainer.style.display = 'none';
        if (intersectionDisplayContainer) intersectionDisplayContainer.style.display = 'block';
        if (autofillSection) autofillSection.style.display = 'none';
        if (foundItemsSection) foundItemsSection.style.display = 'none';
        if (scoreLabel) scoreLabel.textContent = 'average accuracy';

        if (foundStat) foundStat.style.display = 'none';
        if (percentageStat) percentageStat.style.display = 'none';
        if (totalStat) totalStat.style.display = 'none';
        if (distanceStat) distanceStat.style.display = 'none';

        setUnfoundStreets(true);

        if (state.currentIntersection) {
            const targetIntersection = document.getElementById('target-intersection');
            if (targetIntersection) {
                const instructions = document.querySelector('.intersection-instructions');
                let displayText = `${state.currentIntersection.street1} & ${state.currentIntersection.street2}`;
                if (state.currentIntersection.multipleLocations) {
                    displayText += ` (${state.currentIntersection.locationCount} locations)`;
                }
                targetIntersection.textContent = displayText;

                if (instructions) {
                   const instructionText = state.currentIntersection.multipleLocations
                       ? 'Click near any intersection of these streets'
                       : 'Click on the map to place your guess';
                   instructions.textContent = instructionText;
                }
            }
        }
    } else if (state.gameMode === 'cuesheet') {
        if (streetInputContainer) streetInputContainer.style.display = 'none';
        if (intersectionDisplayContainer) intersectionDisplayContainer.style.display = 'none';
        if (autofillSection) autofillSection.style.display = 'none';

        // Hide sidebar sections not relevant to cuesheet mode
        if (statsSection) statsSection.style.display = 'none';
        if (foundItemsSec) foundItemsSec.style.display = 'none';

        setUnfoundStreets(true);

        const cuesheetContainer = document.getElementById('cuesheet-display-container');
        if (cuesheetContainer) cuesheetContainer.style.display = 'block';
    }

    // Hide cuesheet container when not in cuesheet mode
    if (state.gameMode !== 'cuesheet') {
        const cuesheetContainer = document.getElementById('cuesheet-display-container');
        if (cuesheetContainer) cuesheetContainer.style.display = 'none';
    }

    updateDifficultyVisibility();
}

export function updateDifficultyVisibility() {
    const difficultyGroup = document.getElementById('difficulty-group');
    if (difficultyGroup) {
        const shouldShow = (state.gameMode === 'intersections' || state.gameMode === 'cuesheet') && state.isSettingCenter;
        difficultyGroup.style.display = shouldShow ? 'block' : 'none';
    }
}

export function showAccuracyFeedback(distanceMeters, points) {
    const display = document.getElementById('accuracy-display');
    const metersEl = document.getElementById('accuracy-meters');
    const pointsEl = document.getElementById('accuracy-points');
    
    if (display && metersEl && pointsEl) {
        metersEl.textContent = Math.round(distanceMeters);
        pointsEl.textContent = points;
        
        display.style.display = 'block';
        display.classList.remove('fade-out');
        
        setTimeout(() => {
            display.classList.add('fade-out');
            setTimeout(() => {
                display.style.display = 'none';
            }, 500);
        }, 2000);
    }
}
