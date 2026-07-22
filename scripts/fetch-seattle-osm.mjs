// Refreshes the static Seattle OSM cache used by src/api/osm.js as a
// fallback for the live Overpass call. Run manually with `node
// scripts/fetch-seattle-osm.mjs`, or on a schedule via
// .github/workflows/fetch-seattle-osm.yml.
//
// The query is intentionally broader than what this app's own
// processOSMData() needs (it drops the name requirement and includes
// living_street/service ways) because this file is also published as a
// shared raw-data source for other projects — see CLAUDE.md's "Seattle OSM
// Data Cache" section. citystreetgame's own client-side filtering already
// discards unnamed ways, so the extra breadth is harmless here.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getLargestPolygon } from '../src/utils/geo.js';

const SEATTLE = {
    name: 'Seattle',
    osmId: 237385,
    osmType: 'relation',
};

const OUT_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'public', 'data', 'osm'
);

async function fetchBoundary() {
    const url = `https://nominatim.openstreetmap.org/lookup?format=json&osm_ids=${SEATTLE.osmType[0].toUpperCase()}${SEATTLE.osmId}&polygon_geojson=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'citystreetgame-cache-refresh' } });
    if (!response.ok) throw new Error(`Nominatim lookup failed: HTTP ${response.status}`);
    const results = await response.json();

    const geojson = results[0]?.geojson;
    if (!geojson) throw new Error('Nominatim returned no boundary geometry for Seattle');
    return geojson;
}

const HIGHWAY_FILTER = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service)$';

function buildOverpassQuery(bbox) {
    return `[out:json][timeout:120];(way["highway"~"${HIGHWAY_FILTER}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["junction"="roundabout"]["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
}

function computeExpandedBbox(boundaries) {
    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) throw new Error('Boundary GeoJSON has no usable polygon');

    const coords = mainBoundary.coordinates[0];
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    const expansion = 0.02;

    return {
        south: Math.min(...lats) - expansion,
        west: Math.min(...lngs) - expansion,
        north: Math.max(...lats) + expansion,
        east: Math.max(...lngs) + expansion,
    };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWays(bbox, attempts = 3) {
    const query = buildOverpassQuery(bbox);

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {
                'User-Agent': 'citystreetgame-cache-refresh',
                'Content-Type': 'text/plain',
            },
            body: query,
        });

        if (response.ok) return response.json();

        const retryable = response.status === 504 || response.status === 429;
        if (!retryable || attempt === attempts) {
            throw new Error(`Overpass request failed: HTTP ${response.status}`);
        }

        console.log(`Overpass returned HTTP ${response.status} (attempt ${attempt}/${attempts}), retrying...`);
        await sleep(attempt * 5000);
    }
}

async function main() {
    console.log('Fetching Seattle boundary from Nominatim...');
    const boundary = await fetchBoundary();

    console.log('Fetching Seattle street ways from Overpass...');
    const bbox = computeExpandedBbox(boundary);
    const osmData = await fetchWays(bbox);

    const wayCount = osmData.elements?.length ?? 0;
    if (wayCount < 1000) {
        throw new Error(`Overpass returned only ${wayCount} elements — refusing to overwrite cache with a suspiciously small result`);
    }
    console.log(`Overpass returned ${wayCount} elements.`);

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, 'seattle-ways.json'), JSON.stringify(osmData));

    console.log(`Wrote cache file to ${OUT_DIR}`);
}

main().catch(err => {
    console.error('Failed to refresh Seattle OSM cache:', err);
    process.exit(1);
});
