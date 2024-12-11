const { request } = require("undici");

const YOUTUBE_URLS = [
    (id) => `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/default.jpg`,
];

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
        const response = await request(url, { method: "GET" });
        if (response.ok) {
            const json = await response.json();
            return json.thumbnail_url || null;
        }
        return null;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        return null;
    }
}

async function fetchYouTubeThumbnail(identifier) {
    const fetchPromises = YOUTUBE_URLS.map(urlFunc => fetchThumbnail(urlFunc(identifier)));
    const results = await Promise.allSettled(fetchPromises);

    for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
            return result.value; 
        }
    }
    return null;
}

module.exports = { getImageUrl };
