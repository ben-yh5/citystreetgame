
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
