
export function abbreviateStreetName(name) {
    if (!name) return '';
    let s = name.toLowerCase().trim();
    const replacements = [
        [/\bnortheast\b/g, 'ne'], [/\bnorthwest\b/g, 'nw'],
        [/\bsoutheast\b/g, 'se'], [/\bsouthwest\b/g, 'sw'],
        [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'],
        [/\beast\b/g, 'e'], [/\bwest\b/g, 'w'],
        [/\bavenue\b/g, 'ave'], [/\bstreet\b/g, 'st'],
        [/\bboulevard\b/g, 'blvd'], [/\bdrive\b/g, 'dr'],
        [/\broad\b/g, 'rd'], [/\blane\b/g, 'ln'],
        [/\bcourt\b/g, 'ct'], [/\bplace\b/g, 'pl'],
        [/\bterrace\b/g, 'ter'], [/\bcircle\b/g, 'cir'],
        [/\bhighway\b/g, 'hwy'], [/\bparkway\b/g, 'pkwy'],
        [/\btrail\b/g, 'tr'], [/\bsquare\b/g, 'sq'],
        [/\bbridge\b/g, 'br'],
    ];
    for (const [pattern, abbr] of replacements) {
        s = s.replace(pattern, abbr);
    }
    return s.replace(/[.,']/g, '').replace(/\s+/g, ' ').trim();
}

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
