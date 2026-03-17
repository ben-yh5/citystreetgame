import { state } from './state.js';

const CACHE_KEY = 'citystreetgame_save';

export function saveGameState() {
    try {
        if (!state.streetData) return;

        const data = {
            v: 3,
            cityId: state.cityId,
            cityBoundaries: state.cityBoundaries,
            currentCenter: state.currentCenter,
            totalLength: state.totalLength,
            gameMode: state.gameMode,
            intersectionDifficulty: state.intersectionDifficulty,
            foundStreets: Array.from(state.foundStreets),
            foundIntersections: Array.from(state.foundIntersections),
            intersectionScore: state.intersectionScore,
            intersectionAccuracy: state.intersectionAccuracy,
        };

        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('Failed to save game state:', e.message);
    }
}

export function loadGameState() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;

        const data = JSON.parse(raw);
        if (!data || ![1, 2, 3].includes(data.v)) return null;

        return data;
    } catch (e) {
        console.warn('Failed to load game state:', e.message);
        return null;
    }
}

export function clearGameState() {
    localStorage.removeItem(CACHE_KEY);
}
