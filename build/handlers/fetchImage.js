const https = require('https');
const sourceHandlers = new Map([
    ['spotify', uri => fetchThumbnail(`https://open.spotify.com/oembed?url=${uri}`)],
    ['youtube', identifier => fetchYouTubeThumbnail(identifier)]
]);
const YOUTUBE_URL_TEMPLATE = (quality) => (id) => `https://img.youtube.com/vi/${id}/${quality}.jpg`;
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

function fetchThumbnail(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(`Failed to fetch: ${res.statusCode}`);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.thumbnail_url || null);
                } catch (error) {
                    reject(`JSON parse error: ${error.message}`);
                }
            });
        }).on('error', (error) => {
            reject(`Request error: ${error.message}`);
        });
    });
}

async function fetchYouTubeThumbnail(identifier) {
    const promises = YOUTUBE_QUALITIES.map(urlFunc => fetchThumbnail(urlFunc(identifier)));
    const firstResult = await Promise.race(promises);
    return firstResult || null;
}

module.exports = { getImageUrl };
