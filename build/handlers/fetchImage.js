const http2 = require('http2');
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
        const client = http2.connect(url);
        
        const req = client.request({ ':path': '/' });
        
        let data = '';
        
        req.on('response', (headers, flags) => {
            if (headers[':status'] !== 200) {
                return reject(`Failed to fetch: ${headers[':status']}`);
            }
        });
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            try {
                const json = JSON.parse(data);
                resolve(json.thumbnail_url || null);
            } catch (error) {
                reject(`JSON parse error: ${error.message}`);
            } finally {
                client.close();
            }
        });
        req.on('error', (error) => {
            reject(`Request error: ${error.message}`);
            client.close();
        });
        req.end();
    });
}
async function fetchYouTubeThumbnail(identifier) {
    const promises = YOUTUBE_QUALITIES.map(urlFunc => fetchThumbnail(urlFunc(identifier)));
    const results = await Promise.race(promises);
    return results || null;
}
module.exports = { getImageUrl };
