const { request } = require("undici");
const YOUTUBE_URLS = Object.freeze([
    (id) => `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/default.jpg`,
]);

async function getImageUrl(info) {
    if (!info || !info.sourceName || !info.uri) return null;
    switch (info.sourceName.toLowerCase()) {
        case "spotify":
            return await fetchThumbnail(`https://open.spotify.com/oembed?url=${info.uri}`);
        case "youtube":
            return await fetchYouTubeThumbnail(info.identifier);
        default:
            return null;
    }
}

async function fetchThumbnail(url) {
    try {
        const { body } = await request(url, { method: "GET" });
        const json = await body.json(); 
        return json.thumbnail_url || null;
    } catch (error) {
        console.error(`Error fetching thumbnail from ${url}:`, error);
        return null;
    }
}

async function fetchYouTubeThumbnail(identifier) {
    const fetchPromises = YOUTUBE_URLS.map(urlFunc => fetchThumbnail(urlFunc(identifier)));
    
    try {
        const results = await Promise.all(fetchPromises);
        return results.find(result => result !== null) || null;
    } catch (error) {
        console.error('Error fetching thumbnails:', error);
        return null;
    }

    // Batch processing can fix promise.any issue, but it's not necessary atm, so I'll leave it commented out
    // Why Added? Because promise.any can cause an memory leak if used as a lot of requests.
    // Batching fixes it, but it gets uper memory usage. Or i don't just know on how to code it properly.
}
module.exports = { getImageUrl };
