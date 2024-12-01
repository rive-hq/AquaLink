const undici = require("undici");

async function fetchFromUrl(url) {
    try {
        const response = await undici.fetch(url, { cache: "force-cache" });
        return response.ok ? response : null;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        return null;
    }
}

async function getImageUrl(info) {
    if (!info || !info.sourceName || !info.uri) return null;

    let response;
    switch (info.sourceName.toLowerCase()) {
        case "spotify":
            response = await fetchFromUrl(`https://open.spotify.com/oembed?url=${info.uri}`);
            if (response) {
                const json = await response.json();
                return json.thumbnail_url || null;
            }
            break;

        case "soundcloud":
            response = await fetchFromUrl(`https://soundcloud.com/oembed?format=json&url=${info.uri}`);
            if (response) {
                const json = await response.json();
                return json.thumbnail_url || null;
            }
            break;

        case "youtube":
            const urls = [
                `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/mqdefault.jpg`,
                `https://img.youtube.com/vi/${info.identifier}/default.jpg`,
            ];

            const validUrl = await findValidUrl(urls);
            return validUrl;

        default:
            return null;
    }
}

async function findValidUrl(urls) {
    const promises = urls.map(url => fetchFromUrl(url));
    const responses = await Promise.all(promises);
    const validResponses = responses.filter(response => response !== null);

    if (validResponses.length > 0) {
        const validUrl = validResponses[0].url; 
        return validUrl;
    }

    return null;
}

module.exports = { getImageUrl };