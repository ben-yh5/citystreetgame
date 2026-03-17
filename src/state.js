
export const state = {
    // Mapbox
    map: null,

    // Game Data
    cityBoundaries: null,
    streetData: null,
    streetSegmentsData: null,
    foundStreets: new Set(),
    foundIntersections: new Set(),
    totalLength: 0,

    // Game Config
    GAME_CENTER: [-122.3321, 47.6062], // Seattle [lng, lat]
    isSettingCenter: false,
    isPreviewMode: false,
    previewCity: null,
    gameMode: 'streets', // 'streets' or 'intersections'
    intersectionDifficulty: 'major-major', // 'major-major', 'major-all', 'all-all'

    // Intersection Mode State
    currentIntersection: null,
    intersectionScore: 0,
    intersectionAccuracy: [],
    userGuessMarker: null,
    hasPlacedGuess: false,
    validIntersectionLocations: [],

    // UI State
    highlightedStreet: null,
    streetTooltip: null,

    // Undo/Redo
    undoHistory: [],
    redoHistory: [],
    maxHistorySize: 50,

    // Cuesheet Mode State
    streetGraph: null,
    cuesheetChallenge: null,
    cuesheetCues: [],
    cuesheetResults: null,
    _cuesheetCustomPicking: null, // null | 'start' | 'end'

    // OSM Data
    roundaboutCoords: null, // Set<coordKey> from unnamed roundabout ways
};
