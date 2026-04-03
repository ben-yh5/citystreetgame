import { getLargestPolygon, pointInPolygon, calculateLineStringLength } from '../utils/geo.js';
import { state } from '../state.js';

export const FALLBACK_SEATTLE = {
    name: 'Seattle',
    fullName: 'Seattle, King County, Washington, United States',
    lat: 47.6062,
    lon: -122.3321,
    osmId: 237662,
    osmType: 'relation'
};

export async function searchCities(query) {
    if (!query || query.length < 2) return [];
    
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=8`);
        const results = await response.json();
        
        return results.filter(result => {
            return result.osm_type && result.osm_id && 
                   (result.class === 'place' || 
                    result.class === 'boundary' ||
                    result.class === 'admin' ||
                    ['city', 'town', 'village', 'municipality', 'neighbourhood', 
                     'suburb', 'quarter', 'district', 'borough', 'ward', 'subdivision', 
                     'hamlet', 'locality', 'county', 'state_district'].includes(result.type));
        }).map(result => ({
            name: result.display_name.split(',')[0],
            fullName: result.display_name,
            lat: parseFloat(result.lat),
            lon: parseFloat(result.lon),
            osmId: result.osm_id,
            osmType: result.osm_type,
            placeType: result.type,
            placeClass: result.class,
            importance: result.importance || 0
        }))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0));
    } catch (error) {
        console.error('Error searching cities:', error);
        return [];
    }
}

export async function getCityBoundaries(osmType, osmId, cityData = null) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/lookup?format=json&osm_ids=${osmType[0].toUpperCase()}${osmId}&polygon_geojson=1`);
        const results = await response.json();
        
        if (results.length > 0 && results[0].geojson) {
            const geojson = results[0].geojson;
            
            if (isValidBoundary(geojson)) {
                console.log('Found valid official boundaries for', cityData?.name || 'location');
                return geojson;
            } else {
                console.log('API returned boundaries but they are invalid/empty for', cityData?.name || 'location');
            }
        } else {
            console.log('No boundary data returned from API for', cityData?.name || 'location');
        }
        
        if (cityData) {
            return createFallbackBoundary(cityData);
        }
        
        return null;
    } catch (error) {
        console.error('Error fetching city boundaries:', error);
        if (cityData) {
            console.log('Creating fallback boundary due to API error');
            return createFallbackBoundary(cityData);
        }
        return null;
    }
}

export function isValidBoundary(geojson) {
    if (!geojson || !geojson.type) return false;
    
    try {
        let coordinates;
        
        if (geojson.type === 'Polygon') {
            coordinates = geojson.coordinates;
        } else if (geojson.type === 'MultiPolygon') {
            coordinates = geojson.coordinates;
        } else {
            console.log('Boundary type not supported:', geojson.type);
            return false;
        }
        
        if (!coordinates || coordinates.length === 0) {
            console.log('No coordinates in boundary data');
            return false;
        }
        
        let ring;
        if (geojson.type === 'Polygon') {
            ring = coordinates[0];
        } else if (geojson.type === 'MultiPolygon') {
            ring = coordinates[0] && coordinates[0][0];
        }
        
        if (!ring || ring.length < 4) {
            console.log('Boundary ring has insufficient points:', ring?.length || 0);
            return false;
        }
        
        const hasValidCoords = ring.some(coord => 
            Array.isArray(coord) && 
            coord.length >= 2 && 
            Math.abs(coord[0]) > 0.001 && 
            Math.abs(coord[1]) > 0.001
        );
        
        if (!hasValidCoords) {
            console.log('Boundary coordinates appear to be invalid or all zeros');
            return false;
        }
        
        console.log('Boundary validation passed - found valid boundary with', ring.length, 'points');
        return true;
        
    } catch (error) {
        console.error('Error validating boundary:', error);
        return false;
    }
}

export function createFallbackBoundary(cityData) {
    const lat = cityData.lat;
    const lon = cityData.lon;
    let latOffset, lonOffset;
    
    switch (cityData.placeType) {
        case 'city':
        case 'town':
            latOffset = 0.12;
            lonOffset = 0.15;
            break;
        case 'village':
        case 'municipality':
            latOffset = 0.08;
            lonOffset = 0.10;
            break;
        case 'neighbourhood':
        case 'suburb':
            latOffset = 0.02;
            lonOffset = 0.02;
            break;
        case 'quarter':
        case 'district':
            latOffset = 0.03;
            lonOffset = 0.04;
            break;
        case 'borough':
        case 'ward':
            latOffset = 0.05;
            lonOffset = 0.06;
            break;
        case 'county':
        case 'state_district':
            latOffset = 0.20;
            lonOffset = 0.25;
            break;
        default:
            latOffset = 0.04;
            lonOffset = 0.04;
    }
    
    console.log(`Creating ${cityData.placeType} boundary for ${cityData.name} with size ${latOffset}°×${lonOffset}°`);
    
    return {
        type: 'Polygon',
        coordinates: [[
            [lon - lonOffset, lat - latOffset],
            [lon + lonOffset, lat - latOffset],
            [lon + lonOffset, lat + latOffset],
            [lon - lonOffset, lat + latOffset],
            [lon - lonOffset, lat - latOffset]
        ]]
    };
}

export async function fetchStreetsFromOSM(boundaries) {
    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return { type: 'FeatureCollection', features: [] };
    
    const coords = mainBoundary.coordinates[0];
    if (coords.length === 0) return { type: 'FeatureCollection', features: [] };
    
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    const bbox = {
        south: Math.min(...lats),
        west: Math.min(...lngs),
        north: Math.max(...lats),
        east: Math.max(...lngs)
    };
    
    const expansion = 0.02;
    bbox.south -= expansion;
    bbox.north += expansion;
    bbox.west -= expansion;
    bbox.east += expansion;
    
    const overpassQuery = `[out:json][timeout:60];(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified)$"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["junction"="roundabout"]["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
    
    try {
        console.log('Making Overpass API request...');
        const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: overpassQuery });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const osmData = await response.json();
        
        console.log('Overpass API returned', osmData.elements?.length || 0, 'street elements');
        
        return processOSMData(osmData, mainBoundary);
    } catch (error) { 
        console.error('Error fetching OSM data:', error); 
        throw error; 
    }
}

function processOSMData(osmData, boundaries = null) {
    const features = []; 
    const streetGroups = new Map();
    state.streetSegmentsData = new Map(); // Initialize detailed segment data in state
    let totalStreets = 0;
    let filteredStreets = 0;
    let boundaryRejected = 0;
    
    if (!osmData.elements) {
        return { type: 'FeatureCollection', features: [] };
    }
    
    osmData.elements.forEach(element => {
        if (element.type === 'way' && element.tags?.name && element.geometry) {
            totalStreets++;
            const streetName = element.tags.name;
            const coordinates = element.geometry.map(node => [node.lon, node.lat]).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
            if (coordinates.length < 2) return;
            
            if (boundaries) {
                const checkPoints = [];
                
                for (let i = 0; i < coordinates.length; i += Math.max(1, Math.floor(coordinates.length / 5))) {
                    checkPoints.push(coordinates[i]);
                }
                checkPoints.push(coordinates[coordinates.length - 1]);
                
                let pointsInBoundary = 0;
                for (const point of checkPoints) {
                    if (pointInPolygon(point, boundaries)) {
                        pointsInBoundary++;
                    }
                }
                
                if (pointsInBoundary === 0) {
                    boundaryRejected++;
                    return;
                }
            }
            
            filteredStreets++;
            const length = calculateLineStringLength(coordinates);
            if (isNaN(length) || length <= 0) return;
            
            const segmentType = getStreetType(element.tags.highway);
            const segment = { 
                coordinates, 
                length, 
                type: segmentType, 
                highway: element.tags.highway 
            };
            
            // Store in both the grouped data (for features) and detailed segment data
            if (!streetGroups.has(streetName)) streetGroups.set(streetName, []);
            streetGroups.get(streetName).push(segment);
            
            // Store detailed segment data for location-specific classification
            if (!state.streetSegmentsData.has(streetName)) state.streetSegmentsData.set(streetName, []);
            const oneway = element.tags.oneway === 'yes' || element.tags.oneway === '1'
                || element.tags.highway === 'motorway' || element.tags.highway === 'motorway_link';
            const reverseOneway = element.tags.oneway === '-1';
            state.streetSegmentsData.get(streetName).push({
                coordinates: reverseOneway ? [...coordinates].reverse() : coordinates,
                type: segmentType,
                highway: element.tags.highway,
                length: length,
                oneway: oneway || reverseOneway,
            });
        }
    });

    // Collect unnamed roundabout ways — full geometry + coordinate keys
    const roundaboutCoordKey = (coord) => `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
    const roundaboutCoords = new Set();
    const roundaboutWays = []; // full way geometry for rendering
    osmData.elements.forEach(element => {
        if (element.type === 'way' && element.tags?.junction === 'roundabout' &&
            !element.tags?.name && element.geometry) {
            const wayCoords = element.geometry
                .filter(node => !isNaN(node.lon) && !isNaN(node.lat))
                .map(node => [node.lon, node.lat]);
            if (wayCoords.length >= 2) {
                roundaboutWays.push({
                    coordinates: wayCoords,
                    highway: element.tags?.highway || 'residential',
                });
            }
            element.geometry.forEach(node => {
                if (!isNaN(node.lon) && !isNaN(node.lat)) {
                    roundaboutCoords.add(roundaboutCoordKey([node.lon, node.lat]));
                }
            });
        }
    });
    state.roundaboutCoords = roundaboutCoords.size > 0 ? roundaboutCoords : null;
    if (roundaboutCoords.size > 0) {
        console.log('Collected', roundaboutCoords.size, 'roundabout coordinates for graph connectivity');
    }

    // Attach roundabout geometry to connecting named streets for rendering
    if (roundaboutWays.length > 0) {
        // Build coord → street names from segment endpoints
        const endpointStreets = new Map();
        state.streetSegmentsData.forEach((segments, streetName) => {
            segments.forEach(seg => {
                for (const coord of [seg.coordinates[0], seg.coordinates[seg.coordinates.length - 1]]) {
                    const key = roundaboutCoordKey(coord);
                    if (!endpointStreets.has(key)) endpointStreets.set(key, new Set());
                    endpointStreets.get(key).add(streetName);
                }
            });
        });

        let attachedCount = 0;
        roundaboutWays.forEach(rWay => {
            const connecting = new Set();
            rWay.coordinates.forEach(coord => {
                const key = roundaboutCoordKey(coord);
                if (endpointStreets.has(key)) {
                    endpointStreets.get(key).forEach(name => connecting.add(name));
                }
            });
            if (connecting.size < 2) return;

            const length = calculateLineStringLength(rWay.coordinates);
            const segmentType = getStreetType(rWay.highway);

            connecting.forEach(streetName => {
                const seg = {
                    coordinates: rWay.coordinates,
                    length,
                    type: segmentType,
                    highway: rWay.highway,
                };
                if (!streetGroups.has(streetName)) streetGroups.set(streetName, []);
                streetGroups.get(streetName).push(seg);
                if (!state.streetSegmentsData.has(streetName)) state.streetSegmentsData.set(streetName, []);
                state.streetSegmentsData.get(streetName).push({
                    coordinates: rWay.coordinates,
                    type: segmentType,
                    highway: rWay.highway,
                    length,
                    oneway: true,
                });
            });
            attachedCount++;
        });
        if (attachedCount > 0) {
            console.log('Attached', attachedCount, 'roundabout(s) to connecting streets');
        }
    }

    streetGroups.forEach((segments, streetName) => {
        const totalLength = segments.reduce((sum, seg) => sum + seg.length, 0);
        
        // Get the highest classification among all segments of this street
        const streetTypes = segments.map(seg => seg.type);
        const typeHierarchy = ['major', 'primary', 'secondary', 'tertiary', 'residential'];
        let highestType = 'residential';
        
        streetTypes.forEach(type => {
            const currentIndex = typeHierarchy.indexOf(type);
            const highestIndex = typeHierarchy.indexOf(highestType);
            if (currentIndex < highestIndex) { // Lower index = higher priority
                highestType = type;
            }
        });
        
        const properties = { 
            name: streetName, 
            type: highestType,  // Use the highest classification for overall feature
            length: totalLength, 
            highway: segments[0].highway,
            segments: segments.length  // Track how many segments this street has
        };
        
        const geometry = segments.length === 1 ? 
            { type: 'LineString', coordinates: segments[0].coordinates } : 
            { type: 'MultiLineString', coordinates: segments.map(s => s.coordinates) };
            
        features.push({ type: 'Feature', properties, geometry });
    });
    
    // Log some stats about street classifications
    const typeStats = {};
    features.forEach(f => {
        const type = f.properties.type;
        typeStats[type] = (typeStats[type] || 0) + 1;
    });
    console.log('Street type distribution:', typeStats);
    console.log('Detailed segment data stored for', state.streetSegmentsData.size, 'streets');
    
    return { type: 'FeatureCollection', features };
}

export function getStreetType(highway) {
    if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(highway)) return 'major';
    if (['secondary', 'secondary_link'].includes(highway)) return 'primary';
    if (['tertiary', 'tertiary_link'].includes(highway)) return 'secondary';
    return 'residential';
}
