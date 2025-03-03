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
        https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.thumbnail_url || null);
                } catch (error) {
                    console.error(`Error parsing JSON from ${url}:`, error);
                    reject(null);
                }
            });
        }).on('error', (error) => {
            console.error(`Error fetching thumbnail from ${url}:`, error);
            reject(null);
        });
    });
}

async function fetchYouTubeThumbnail(identifier) {
    return Promise.race(
        YOUTUBE_QUALITIES.map(urlFunc => fetchThumbnail(urlFunc(identifier)))
    ).catch(() => {
        console.error('No valid YouTube thumbnail found.');
        return null;
    });
}

module.exports = { getImageUrl };
