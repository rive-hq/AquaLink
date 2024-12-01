const undici = require("undici");

async function getImageUrl(info) {
    if (!info || !info.sourceName || !info.uri) return null;

    switch (info.sourceName.toLowerCase()) {
        case "spotify":
            return (await fetchFromUrl(`https://open.spotify.com/oembed?url=${info.uri}`))?.json().then(json => json.thumbnail_url || null);

        case "soundcloud":
            return (await fetchFromUrl(`https://soundcloud.com/oembed?format=json&url=${info.uri}`))?.json().then(json => json.thumbnail_url || null);

        case "youtube":
            const urls = [
                `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/mqdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/default.jpg`,
            ];

            const firstValidUrl = await Promise.any(urls.map(url => fetchFromUrl(url)));
            return firstValidUrl ? firstValidUrl.url : null;

        default:
            return null;
    }
}

async function fetchFromUrl(url) {
    try {
        const response = await undici.fetch(url, { cache: "force-cache" });
        return response.ok ? response : null;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        return null;
    }
}

module.exports = { getImageUrl };
