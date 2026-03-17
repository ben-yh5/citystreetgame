import { state } from '../state.js';
import { loadCity as backendLoadCity } from './backend.js';

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

/**
 * Fetch streets from the Python backend using OSMnx.
 * Replaces the old Overpass API call.
 */
export async function fetchStreetsFromOSM(boundaries) {
    console.log('Loading city via OSMnx backend...');
    const result = await backendLoadCity(boundaries);

    // Store backend data in state
    state.cityId = result.city_id;
    state.streetNames = result.street_names;
    state.streetSegmentsData = rebuildSegmentsFromGeoJSON(result.street_data);

    console.log(`OSMnx loaded: ${result.graph_stats.nodes} nodes, ${result.graph_stats.edges} edges, ${result.street_names.length} streets`);

    return result.street_data;
}

/**
 * Rebuild streetSegmentsData Map from the GeoJSON FeatureCollection.
 * This is needed by intersections mode and streets mode for local lookups.
 */
function rebuildSegmentsFromGeoJSON(streetData) {
    const segmentsData = new Map();
    if (!streetData || !streetData.features) return segmentsData;

    streetData.features.forEach(feature => {
        const name = feature.properties.name;
        const type = feature.properties.type;
        const highway = feature.properties.highway;
        const segments = [];

        if (feature.geometry.type === 'LineString') {
            segments.push({
                coordinates: feature.geometry.coordinates,
                type,
                highway,
                length: feature.properties.length,
            });
        } else if (feature.geometry.type === 'MultiLineString') {
            const segCount = feature.geometry.coordinates.length;
            feature.geometry.coordinates.forEach(coords => {
                segments.push({
                    coordinates: coords,
                    type,
                    highway,
                    length: feature.properties.length / segCount,
                });
            });
        }

        segmentsData.set(name, segments);
    });

    return segmentsData;
}

export function getStreetType(highway) {
    if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(highway)) return 'major';
    if (['secondary', 'secondary_link'].includes(highway)) return 'primary';
    if (['tertiary', 'tertiary_link'].includes(highway)) return 'secondary';
    return 'residential';
}
