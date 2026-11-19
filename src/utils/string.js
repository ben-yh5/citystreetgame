
export function normalizeStreetName(name) {
    if (!name) return '';
    const originalLower = name.toLowerCase();
    
    // Remove directional prefixes/suffixes and common road types to find the "core" name
    const directionals = /\b(north|south|east|west|northeast|northwest|southeast|southwest|n|s|e|w|ne|nw|se|sw)\b/g;
    const allSuffixes = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|place|pl|court|ct|way|square|sq|circle|cir|trail|tr|parkway|pkwy|bridge)\b/g;
    const genericSuffixesOnly = /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd)\b/g;
    
    // First pass: remove directionals and all suffixes
    let normalized = originalLower.replace(directionals, '').replace(allSuffixes, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // If we stripped everything away (e.g. "North Street"), try being less aggressive with suffixes
    if (normalized === '') {
        normalized = originalLower.replace(directionals, '').replace(genericSuffixesOnly, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    
    // If still empty (e.g. just "North"), return original trimmed
    return normalized || originalLower.trim();
}

// Parses highway names like "I-5", "i5", "Interstate 5", "SR 520", "WA-520", "Highway 99",
// "US 2" or a bare "520" into { system, number }. system is 'i', 'us', 'state', or null
// when the input doesn't say (bare number, "highway", "route"), which matches any system.
export function parseHighwayName(name) {
    const lower = name.trim().toLowerCase();
    const bare = lower.match(/^(\d+[a-z]?)$/);
    if (bare) return { system: null, number: bare[1] };

    const match = lower.match(/^(interstate|state route|state highway|us route|us highway|highway|hwy|route|[a-z]{1,3})[\s-]*(\d+[a-z]?)$/);
    if (!match) return null;
    const prefix = match[1];
    let system = 'state'; // "SR", "WA", other state codes, "state route"
    if (prefix === 'i' || prefix === 'interstate') system = 'i';
    else if (prefix === 'us' || prefix.startsWith('us ')) system = 'us';
    else if (['highway', 'hwy', 'route'].includes(prefix)) system = null;
    return { system, number: match[2] };
}
