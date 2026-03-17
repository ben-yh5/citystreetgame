import { state } from '../state.js';
import { 
    calculateDistance, 
    calculateDistanceMeters, 
    getDistanceToLineString, 
    getClosestPointsBetweenSegments,
    getLineSegmentIntersection 
} from '../utils/geo.js';
import { normalizeStreetName } from '../utils/string.js';

// --- INTERSECTION GENERATION (Improved with Location-Specific Classification) ---
export function getStreetTypeCategory(streetType) {
    const major = ['major', 'primary', 'secondary', 'tertiary'];
    return major.includes(streetType) ? 'major' : 'local';
}

export function getStreetTypeAtLocation(streetName, lat, lng) {
    if (!state.streetSegmentsData || !state.streetSegmentsData.has(streetName)) {
        return 'residential'; // Default fallback
    }
    
    const segments = state.streetSegmentsData.get(streetName);
    let closestSegment = null;
    let closestDistance = Infinity;
    
    // Find the closest segment to the given location
    segments.forEach(segment => {
        const segmentDistance = getDistanceToLineString(lat, lng, segment.coordinates);
        if (segmentDistance < closestDistance) {
            closestDistance = segmentDistance;
            closestSegment = segment;
        }
    });
    
    return closestSegment ? closestSegment.type : 'residential';
}

export function getHighestStreetType(streetName, lat = null, lng = null) {
    // If location is provided, get the type at that specific location
    if (lat !== null && lng !== null) {
        return getStreetTypeAtLocation(streetName, lat, lng);
    }
    
    // Fallback to overall street type
    const streetFeature = state.streetData.features.find(f => f.properties.name === streetName);
    return streetFeature ? streetFeature.properties.type : 'residential';
}

export function findIntersectingStreets(targetStreet) {
    const maxDistance = 5; // Maximum 5 meters apart to be considered intersecting
    const intersectingStreets = [];
    
    // Get normalized name of target street to avoid same-street intersections
    const targetNormalized = normalizeStreetName(targetStreet.properties.name);
    
    // Only check a subset of streets to improve performance
    const maxStreetsToCheck = Math.min(state.streetData.features.length, 200);
    const streetsToCheck = state.streetData.features
        .filter(s => {
            // Filter out exact name matches
            if (s.properties.name === targetStreet.properties.name) return false;
            
            // Filter out streets that have the same normalized name (e.g., "E Broadway" vs "Broadway")
            const otherNormalized = normalizeStreetName(s.properties.name);
            return otherNormalized !== targetNormalized;
        })
        .sort(() => Math.random() - 0.5)
        .slice(0, maxStreetsToCheck);
    
    let checkedCount = 0;
    let foundCount = 0;
    
    streetsToCheck.forEach(otherStreet => {
        checkedCount++;
        
        // Check if already found this intersection pair (avoid duplicates)
        const key1 = `${targetStreet.properties.name}|${otherStreet.properties.name}`;
        const key2 = `${otherStreet.properties.name}|${targetStreet.properties.name}`;
        if (state.foundIntersections.has(key1) || state.foundIntersections.has(key2)) return;
        
        const intersections = findAllIntersectionsBetweenStreets(targetStreet.geometry, otherStreet.geometry);
        
        if (intersections.length > 0) {
            // Filter intersections by distance and validate road types at each location
            const validIntersections = intersections.filter(intersection => {
                if (intersection.distance > maxDistance) return false;
                
                // NEW: Check road types at the specific intersection location
                const type1AtLocation = getStreetTypeAtLocation(targetStreet.properties.name, intersection.lat, intersection.lng);
                const type2AtLocation = getStreetTypeAtLocation(otherStreet.properties.name, intersection.lat, intersection.lng);
                
                const category1 = getStreetTypeCategory(type1AtLocation);
                const category2 = getStreetTypeCategory(type2AtLocation);
                
                // Validate against difficulty criteria using location-specific types
                switch (state.intersectionDifficulty) {
                    case 'major-major':
                        return category1 === 'major' && category2 === 'major';
                    case 'major-all':
                        return category1 === 'major' || category2 === 'major';
                    case 'all-all':
                        return true;
                    default:
                        return false;
                }
            });
            
            if (validIntersections.length > 0) {
                intersectingStreets.push({
                    street: otherStreet,
                    intersections: validIntersections
                });
                foundCount++;
            }
        }
    });
    
    console.log(`  - Checked ${checkedCount} streets, found ${foundCount} valid intersections with location-specific classification`);
    return intersectingStreets;
}

// New function to find ALL intersections between two streets
export function findAllIntersectionsBetweenStreets(geom1, geom2) {
    const maxDistance = 50; // Maximum 50 meters apart to be considered intersecting (broader for initial detection)
    const intersections = [];
    
    // Get all line segments from both geometries
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            // Check every segment against every other segment
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1Start = line1[i];
                    const seg1End = line1[i + 1];
                    const seg2Start = line2[j];
                    const seg2End = line2[j + 1];
                    
                    const closestPoints = getClosestPointsBetweenSegments(
                        seg1Start, seg1End, seg2Start, seg2End
                    );
                    
                    const distance = calculateDistanceMeters(
                        closestPoints.point1[1], closestPoints.point1[0],
                        closestPoints.point2[1], closestPoints.point2[0]
                    );
                    
                    if (distance <= maxDistance) {
                        // Use midpoint between the two closest points
                        const intersection = {
                            lat: (closestPoints.point1[1] + closestPoints.point2[1]) / 2,
                            lng: (closestPoints.point1[0] + closestPoints.point2[0]) / 2,
                            distance: distance
                        };
                        
                        // Check if this intersection is too close to an existing one (avoid duplicates)
                        const isDuplicate = intersections.some(existing => 
                            calculateDistanceMeters(existing.lat, existing.lng, intersection.lat, intersection.lng) < 20
                        );
                        
                        if (!isDuplicate) {
                            intersections.push(intersection);
                        }
                    }
                }
            }
        });
    });
    
    return intersections;
}

export function generateRandomIntersection() {
    if (!state.streetData || state.streetData.features.length === 0) {
        return null;
    }
    
    console.log(`Generating intersection using street-first approach (difficulty: ${state.intersectionDifficulty})...`);
    
    // Step 1: Filter streets by difficulty to pick the first street
    let primaryStreets = [];
    
    switch (state.intersectionDifficulty) {
        case 'major-major':
        case 'major-all':
            // Start with streets that have at least some major segments
            primaryStreets = state.streetData.features.filter(street => {
                // Check if this street has any major-type segments
                if (!state.streetSegmentsData.has(street.properties.name)) return false;
                const segments = state.streetSegmentsData.get(street.properties.name);
                return segments.some(segment => getStreetTypeCategory(segment.type) === 'major');
            });
            console.log(`Found ${primaryStreets.length} streets with major segments to start with`);
            break;
        case 'all-all':
            // Can start with any street
            primaryStreets = [...state.streetData.features];
            console.log(`Using all ${primaryStreets.length} streets as potential starting points`);
            break;
    }
    
    if (primaryStreets.length === 0) {
        console.log('No suitable primary streets found for difficulty:', state.intersectionDifficulty);
        return null;
    }
    
    // Step 2: Try multiple primary streets until we find a valid intersection
    const shuffledPrimary = [...primaryStreets].sort(() => Math.random() - 0.5);
    
    for (let i = 0; i < Math.min(50, shuffledPrimary.length); i++) {
        const primaryStreet = shuffledPrimary[i];
        console.log(`Trying primary street: ${primaryStreet.properties.name} (overall: ${primaryStreet.properties.type})`);
        
        const intersectingStreets = findIntersectingStreets(primaryStreet);
        
        if (intersectingStreets.length === 0) {
            console.log(`  - No valid intersecting streets found`);
            continue;
        }
        
        // Step 3: Pick a random valid intersection (filtering is done in findIntersectingStreets)
        const randomIntersection = intersectingStreets[Math.floor(Math.random() * intersectingStreets.length)];
        
        // Handle multiple intersection locations for the same street pair
        const intersectionLocations = randomIntersection.intersections;
        
        if (intersectionLocations.length > 1) {
            console.log(`✓ Found ${intersectionLocations.length} locations for intersection: ${primaryStreet.properties.name} & ${randomIntersection.street.properties.name}`);
            
            // Store all valid locations and pick the most central one as the primary
            state.validIntersectionLocations = intersectionLocations.map(loc => ({
                lat: loc.lat,
                lng: loc.lng,
                distance: loc.distance
            }));
            
            // Use the intersection with the smallest distance (most precise)
            const primaryLocation = intersectionLocations.reduce((best, current) => 
                current.distance < best.distance ? current : best
            );
            
            // Get road types at the actual intersection location
            const type1AtLocation = getStreetTypeAtLocation(primaryStreet.properties.name, primaryLocation.lat, primaryLocation.lng);
            const type2AtLocation = getStreetTypeAtLocation(randomIntersection.street.properties.name, primaryLocation.lat, primaryLocation.lng);
            
            return {
                street1: primaryStreet.properties.name,
                street2: randomIntersection.street.properties.name,
                lat: primaryLocation.lat,
                lng: primaryLocation.lng,
                type1: type1AtLocation,
                type2: type2AtLocation,
                multipleLocations: true,
                locationCount: intersectionLocations.length
            };
        } else {
            const location = intersectionLocations[0];
            console.log(`✓ Selected intersection: ${primaryStreet.properties.name} & ${randomIntersection.street.properties.name} (${Math.round(location.distance)}m apart)`);
            
            state.validIntersectionLocations = [{
                lat: location.lat,
                lng: location.lng,
                distance: location.distance
            }];
            
            // Get road types at the actual intersection location
            const type1AtLocation = getStreetTypeAtLocation(primaryStreet.properties.name, location.lat, location.lng);
            const type2AtLocation = getStreetTypeAtLocation(randomIntersection.street.properties.name, location.lat, location.lng);
            
            return {
                street1: primaryStreet.properties.name,
                street2: randomIntersection.street.properties.name,
                lat: location.lat,
                lng: location.lng,
                type1: type1AtLocation,
                type2: type2AtLocation,
                multipleLocations: false,
                locationCount: 1
            };
        }
    }
    
    console.log('Could not find valid intersection after trying 20 primary streets');
    return null;
}

export function findStreetsClosestApproach(geom1, geom2) {
    const maxDistance = 50; // Maximum 50 meters apart to be considered intersecting
    let closestDistance = Infinity;
    let closestPoint = null;
    
    // Get all line segments from both geometries
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            // Check every segment against every other segment
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1Start = line1[i];
                    const seg1End = line1[i + 1];
                    const seg2Start = line2[j];
                    const seg2End = line2[j + 1];
                    
                    const closestPoints = getClosestPointsBetweenSegments(
                        seg1Start, seg1End, seg2Start, seg2End
                    );
                    
                    const distance = calculateDistanceMeters(
                        closestPoints.point1[1], closestPoints.point1[0],
                        closestPoints.point2[1], closestPoints.point2[0]
                    );
                    
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        // Use midpoint between the two closest points
                        closestPoint = {
                            lat: (closestPoints.point1[1] + closestPoints.point2[1]) / 2,
                            lng: (closestPoints.point1[0] + closestPoints.point2[0]) / 2,
                            distance: distance
                        };
                    }
                }
            }
        });
    });
    
    // Only return if streets are close enough to be considered intersecting
    if (closestDistance <= maxDistance) {
        return closestPoint;
    }
    
    return null;
}

export function findLineIntersections(geom1, geom2, tolerance) {
    const intersections = [];
    
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1 = [line1[i], line1[i + 1]];
                    const seg2 = [line2[j], line2[j + 1]];
                    
                    const intersection = getLineSegmentIntersection(seg1, seg2);
                    if (intersection) {
                        // Check if intersection is close to an endpoint (likely a real intersection)
                        const isNearEndpoint = [seg1[0], seg1[1], seg2[0], seg2[1]].some(point => {
                            const dist = calculateDistanceMeters(intersection.lat, intersection.lng, point[1], point[0]);
                            return dist < tolerance * 111000; // Convert to meters
                        });
                        
                        if (isNearEndpoint) {
                            intersections.push(intersection);
                        }
                    }
                }
            }
        });
    });
    
    return intersections;
}
