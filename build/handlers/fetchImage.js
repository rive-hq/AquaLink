const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 10000;

function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, options, async (res) => {
            try {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const resolvedUrl = new URL(res.headers.location, url).href;
                    const result = await fetch(resolvedUrl, options);
                    return resolve(result);
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    return reject(new Error(`Request failed. Status code: ${res.statusCode}`));
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                
                res.on('end', () => resolve(Buffer.concat(chunks).toString()));
            } catch (error) {
                reject(error);
            }
        });

        req.setTimeout(DEFAULT_TIMEOUT, () => {
            req.destroy(new Error(`Request timeout after ${DEFAULT_TIMEOUT}ms`));
        });

        req.on('error', reject);
        req.end();
    });
}

async function scAutoPlay(url) {
    try {
        const targetUrl = new URL('/recommended', url).href;
        const html = await fetch(targetUrl);

        const hrefs = new Set();
        const regex = /<a\s+itemprop="url"\s+href="([^"]*)"/gi;
        const matches = html.matchAll(regex);

        for (const match of matches) {
            const path = match[1];
            if (path.startsWith('/')) {
                hrefs.add(new URL(path, 'https://soundcloud.com').href);
            }
        }

        if (hrefs.size === 0) {
            throw new Error("No recommended tracks found on SoundCloud.");
        }

        return shuffleArray([...hrefs]);
    } catch (error) {
        console.error("Error fetching SoundCloud recommendations:", error);
        return [];
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function spAutoPlay(track_id, requester, aqua) {
    try {
        const res = await aqua.resolve({
            query: `seed_tracks=${track_id}`,
            requester: requester,
            source: "spsearch"
        }) || {};

        const tracks = res.tracks || [];
        if (tracks.length === 0) {
            throw new Error("No recommended tracks found");
        }

        return tracks[Math.floor(Math.random() * tracks.length)].info?.identifier;
    } catch (error) {
        console.error("Spotify AutoPlay Error:", error);
        return null;
    }
}

module.exports = { scAutoPlay, spAutoPlay, fetch };
