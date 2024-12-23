const { request } = require("undici");

// Memoize YouTube URLs to avoid recreating functions
const YOUTUBE_URLS = Object.freeze([
    'maxresdefault.jpg',
    'hqdefault.jpg',
    'mqdefault.jpg',
    'default.jpg'
].map(quality => (id) => `https://img.youtube.com/vi/${id}/${quality}`));

async function getImageUrl(info) {
    if (!info?.sourceName?.toLowerCase() || !info.uri) return null;
    switch (info.sourceName.toLowerCase()) {
        case "spotify":
            return fetchThumbnail(`https://open.spotify.com/oembed?url=${encodeURIComponent(info.uri)}`);
        case "youtube":
            return fetchYouTubeThumbnail(info.identifier);
        default:
            return null;
    }
}

async function fetchThumbnail(url) {
    try {
        const { body } = await request(url, {
            method: "GET",
            headers: { 'Accept': 'application/json' }
        });
        
        const json = await body.json();
        await body.dump();
        
        return json?.thumbnail_url || null;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        return null;
    }
}

async function fetchYouTubeThumbnail(identifier) {
    if (!identifier) return null;

    try {
        const fetchPromises = YOUTUBE_URLS.map(urlFunc => 
            fetchThumbnail(urlFunc(identifier))
        );
        const result = await Promise.race([
            ...fetchPromises,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 5000)
            )
        ]);
        
        return result || null;
    } catch {
        return fetchThumbnail(YOUTUBE_URLS[0](identifier));
    }
}

module.exports = { getImageUrl };
