
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

    // Backend
    cityId: null, // backend session identifier for loaded city
    streetNames: [], // sorted list of all street names (from backend)

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
    cuesheetChallenge: null,
    cuesheetCues: [],
    cuesheetResults: null,
    _cuesheetCustomPicking: null, // null | 'start' | 'end'
    _cuesheetRouteId: null, // backend route ID
    _cuesheetRouteCoords: [], // coordinates for drawing the route
    _cuesheetConfirmedCoords: [], // confirmed portion coordinates
    _cuesheetContinuationCoords: [], // dashed preview coordinates
    _cuesheetEndCoords: [], // end segment coordinates
    _cuesheetReachedEnd: false,
    _cuesheetConfirmedEdgeCount: 0,
    _cuesheetCurrentStreet: null,
};
