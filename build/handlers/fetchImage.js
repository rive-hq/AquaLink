const { request } = require("undici");

// YouTube URL templates for different qualities.
const YOUTUBE_URLS = Object.freeze([
    (id) => `https://img.youtube.com/vi/${id}/maxresdefault.jpg`, // Highest quality
    (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
    (id) => `https://img.youtube.com/vi/${id}/default.jpg`, // Lowest quality
]);

/**
 * Main function to get the image URL (for Spotify/YouTube sources).
 * @param {*} info - Object containing information about the source.
 * @returns {Promise<string|null>} The image URL or null if unavailable.
 */
async function getImageUrl(info) {
    // Validate input
    if (!info || !info.sourceName || !info.uri) return null;

    switch (info.sourceName.toLowerCase()) {
        case "spotify":
            return await getSpotifyThumbnail(info.uri);
        case "youtube":
            return await getYouTubeThumbnail(info.identifier);
        default:
            return null;
    }
}

/**
 * Fetches the thumbnail URL from Spotify's oEmbed endpoint.
 * @param {string} spotifyUri - The Spotify URI.
 * @returns {Promise<string|null>} The Spotify thumbnail URL or null if unavailable.
 */
async function getSpotifyThumbnail(spotifyUri) {
    const url = `https://open.spotify.com/oembed?url=${spotifyUri}`;
    try {
        const response = await request(url, { method: "GET" });
        const data = await response.body.json(); // Properly consume body to avoid leaks
        return data.thumbnail_url || null;
    } catch (error) {
        console.error(`Error fetching Spotify thumbnail for URI ${spotifyUri}:`, error);
        return null;
    }
}

/**
 * Fetches the highest quality available thumbnail from YouTube.
 * Images are tried sequentially to minimize resource consumption.
 * @param {string} videoId - The YouTube video identifier.
 * @returns {Promise<string|null>} The available thumbnail URL or null if unavailable.
 */
async function getYouTubeThumbnail(videoId) {
    for (const urlFunc of YOUTUBE_URLS) {
        const url = urlFunc(videoId);
        if (await isUrlAccessible(url)) {
            return url; // Return the first accessible URL
        }
    }
    return null; // No valid thumbnail found
}

/**
 * Checks if a URL is accessible (status 200).
 * @param {string} url - The URL to check.
 * @returns {Promise<boolean>} True if the URL is accessible, false otherwise.
 */
async function isUrlAccessible(url) {
    try {
        const response = await request(url, { method: "HEAD" }); // Use HEAD for lightweight requests
        response.body.destroy(); // Prevent memory leaks by explicitly closing the body
        return response.statusCode === 200; // True if URL is valid
    } catch {
        return false; // Treat fetch errors as inaccessible
    }
}

// TODO: Fix batch processing

module.exports = { getImageUrl };
