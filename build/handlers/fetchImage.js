const { request } = require('undici');

// Constants for different thumbnail qualities
const YOUTUBE_THUMBNAIL_URLS = Object.freeze([
    'maxresdefault.jpg',
    'hqdefault.jpg',
    'mqdefault.jpg',
    'default.jpg'
].map(quality => (id) => `https://img.youtube.com/vi/${id}/${quality}`));

/**
 * Get image URL based on source information
 * @param {Object} info - Source information object
 * @param {string} info.sourceName - Name of the source (spotify/youtube)
 * @param {string} info.uri - URI of the content
 * @param {string} info.identifier - Identifier for YouTube videos
 * @returns {Promise<string|null>} The thumbnail URL or null
 */
async function getImageUrl(info) {
    if (!isValidInfo(info)) return null;

    try {
        return await fetchSourceThumbnail(info);
    } catch (error) {
        console.error(`Error in getImageUrl for ${info.sourceName}:`, error);
        return null;
    }
}

/**
 * Validate input information
 * @param {Object} info - Source information object
 * @returns {boolean} Whether the info is valid
 */
function isValidInfo(info) {
    return info && 
           info.sourceName && 
           (info.uri || (info.sourceName.toLowerCase() === 'youtube' && info.identifier));
}

/**
 * Fetch thumbnail based on source type
 * @param {Object} info - Source information
 * @returns {Promise<string|null>} Thumbnail URL
 */
async function fetchSourceThumbnail(info) {
    const source = info.sourceName.toLowerCase();
    
    switch (source) {
        case 'spotify':
            return await fetchWithTimeout(
                `https://open.spotify.com/oembed?url=${encodeURIComponent(info.uri)}`
            );
        case 'youtube':
            return await fetchYouTubeThumbnail(info.identifier);
        default:
            return null;
    }
}

/**
 * Fetch thumbnail URL with timeout
 * @param {string} url - URL to fetch
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} Thumbnail URL
 */
async function fetchWithTimeout(url, timeout = 5000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await request(url, {
            method: 'GET',
            signal: controller.signal
        });

        const json = await response.body.json();
        await response.body.dump();
        clearTimeout(timeoutId);

        return json.thumbnail_url || null;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Request timeout for ${url}`);
        } else {
            console.error(`Error fetching ${url}:`, error);
        }
        return null;
    }
}

/**
 * Fetch YouTube thumbnail trying different qualities
 * @param {string} identifier - YouTube video identifier
 * @returns {Promise<string|null>} Thumbnail URL
 */
async function fetchYouTubeThumbnail(identifier) {
    // Try to fetch thumbnails in parallel
    const results = await Promise.allSettled(
        YOUTUBE_THUMBNAIL_URLS.map(urlFunc => 
            fetchWithTimeout(urlFunc(identifier))
        )
    );

    // Return the first successful thumbnail
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            return result.value;
        }
    }
    
    return null;
}

module.exports = { getImageUrl };
