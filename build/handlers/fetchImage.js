const { request } = require("undici");
const sourceHandlers = new Map([
    ['spotify', uri => fetchThumbnail(`https://open.spotify.com/oembed?url=${uri}`)],
    ['youtube', identifier => fetchYouTubeThumbnail(identifier)]
]);
const YOUTUBE_URL_TEMPLATE = quality => id => `https://img.youtube.com/vi/${id}/${quality}.jpg`;
const YOUTUBE_QUALITIES = ['maxresdefault', 'hqdefault', 'mqdefault', 'default'].map(YOUTUBE_URL_TEMPLATE);

async function getImageUrl(info) {
    if (!info?.sourceName || !info?.uri) return null;
    const handler = sourceHandlers.get(info.sourceName.toLowerCase());
    if (!handler) return null;
    try {
        return await handler(info.uri);
    } catch (error) {
        console.error('Error fetching image URL:', error);
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
        return json.thumbnail_url || null;
    } catch (error) {
        console.error(`Error fetching thumbnail from ${url}:`, error);
        return null;
    }
}

async function fetchYouTubeThumbnail(identifier) {
    const fetchPromises = YOUTUBE_QUALITIES.map(urlFunc => fetchThumbnail(urlFunc(identifier)));
    const results = await Promise.allSettled(fetchPromises);

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            return result.value;
        }
    }
    
    console.error('No valid YouTube thumbnail found.');
    return null;
}

module.exports = { getImageUrl };
