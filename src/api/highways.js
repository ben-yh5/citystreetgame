// Gives freeways a playable name and folds their ramps into them.
//
// Freeway mainlines are usually tagged only with a route `ref` ("I 5") and ramps with
// nothing at all, so neither survives the app's "named ways only" rule on its own.
// Each motorway becomes a street named after its route ("I-5"), and each unnamed ramp
// takes the name of one highway, found by following the ramp network:
//   - an exit ramp belongs to the highway it leaves (also for highway-to-highway ramps,
//     matching how exits are numbered along the highway you're on)
//   - an entrance ramp from a local street belongs to the highway it joins

const ANCHOR_HIGHWAY = /^(motorway|trunk)$/;
const LINK_HIGHWAY = /^(motorway|trunk)_link$/;

// "I 5" -> "I-5", "I 5 Express" -> "I-5", "SR 167 South" -> "SR 167", "SR 304;SR 519" -> "SR 304"
export function formatHighwayRef(ref) {
    const first = ref.split(';')[0].trim();
    const match = first.match(/^([A-Za-z]{1,3})\s*-?\s*(\d+[A-Za-z]?)\b/);
    if (!match) return null;
    const system = match[1].toUpperCase();
    return system === 'I' ? `I-${match[2]}` : `${system} ${match[2]}`;
}

function anchorName(tags) {
    const ref = tags.ref ? formatHighwayRef(tags.ref) : null;
    // Freeways go by their route ("I-5"), not by bridge or viaduct names along them.
    // Surface highways (trunk) keep their street name, e.g. Aurora Avenue North for SR 99.
    if (tags.highway === 'motorway' && ref) return ref;
    // A name that only spells out the route ("State Route 518") should merge with the ref'd parts
    if (ref && tags.name && /^(state route|interstate|us route|us highway|highway)\s*\d+/i.test(tags.name)) return ref;
    return tags.name || ref;
}

// Ramps that carry a real street name keep it ("Bridge Way North"); placeholder names don't.
function keepsOwnName(tags) {
    return !!tags.name && !/ramp/i.test(tags.name) && !formatHighwayRef(tags.name);
}

const pointKey = p => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

// Returns Map<way element, street name> for motorway/trunk ways and their ramps.
export function resolveHighwayNames(elements) {
    const names = new Map();
    const anchorsAt = new Map(); // point key -> highway names touching it
    const links = [];

    elements.forEach(el => {
        if (el.type !== 'way' || !el.geometry || !el.tags) return;
        const highway = el.tags.highway;
        if (ANCHOR_HIGHWAY.test(highway)) {
            const name = anchorName(el.tags);
            if (!name) return;
            names.set(el, name);
            el.geometry.forEach(p => {
                const key = pointKey(p);
                if (!anchorsAt.has(key)) anchorsAt.set(key, new Set());
                anchorsAt.get(key).add(name);
            });
        } else if (LINK_HIGHWAY.test(highway)) {
            if (keepsOwnName(el.tags)) {
                names.set(el, el.tags.name);
                return;
            }
            const keys = el.geometry.map(pointKey);
            if (el.tags.oneway === '-1') keys.reverse();
            links.push({ el, keys, twoWay: el.tags.oneway === 'no' });
        }
    });

    const linksAt = new Map(); // point key -> indices of ramps passing through it
    links.forEach((link, i) => {
        new Set(link.keys).forEach(key => {
            if (!linksAt.has(key)) linksAt.set(key, []);
            linksAt.get(key).push(i);
        });
    });

    // Nearest highway reached by following ramps from link i, forward (toward where
    // traffic goes) or backward (toward where it comes from). Stops at the first highway.
    function nearestHighway(start, forward) {
        const seen = new Set([start]);
        let frontier = [start];
        while (frontier.length > 0) {
            const next = [];
            for (const i of frontier) {
                const link = links[i];
                const ends = link.twoWay
                    ? [link.keys[0], link.keys[link.keys.length - 1]]
                    : [forward ? link.keys[link.keys.length - 1] : link.keys[0]];
                for (const end of ends) {
                    const hit = anchorsAt.get(end);
                    if (hit) return [...hit][0];
                    for (const j of linksAt.get(end) || []) {
                        if (seen.has(j)) continue;
                        const other = links[j];
                        // Only continue into ramps that carry traffic on from this point
                        const continues = other.twoWay
                            || (forward ? other.keys[other.keys.length - 1] !== end : other.keys[0] !== end);
                        if (!continues) continue;
                        seen.add(j);
                        next.push(j);
                    }
                }
            }
            frontier = next;
        }
        return null;
    }

    links.forEach((link, i) => {
        const name = nearestHighway(i, false) || nearestHighway(i, true) || link.el.tags.name;
        if (name) names.set(link.el, name);
    });

    return names;
}
