const https = require('https');

function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Request failed. Status code: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
    });
}

async function scAutoPlay(url) {
    try {
        const html = await fetch(`${url}/recommended`);
        
        const matches = [...html.matchAll(/<a itemprop="url" href="(\/.*?)"/g)];
        
        const hrefs = [...new Set(matches.map(match => `https://soundcloud.com${match[1]}`))];
        
        if (hrefs.length === 0) {
            throw new Error("No recommended tracks found on SoundCloud.");
        }
        
        const shuffledHrefs = hrefs.sort(() => Math.random() - 0.5);
        
        return shuffledHrefs;
    } catch (error) {
        console.error("Error fetching SoundCloud recommendations:", error);
        return [];
    }
}

async function spAutoPlay(track_id) {
    try {
        const tokenResponse = await fetch("https://open.spotify.com/get_access_token?reason=transport&productType=embed");
        const { accessToken } = JSON.parse(tokenResponse);
        
        if (!accessToken) throw new Error("Failed to retrieve Spotify access token");
        
        const recommendationsResponse = await fetch(`https://api.spotify.com/v1/recommendations?limit=10&seed_tracks=${track_id}`, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
        
        const { tracks } = JSON.parse(recommendationsResponse);
        
        if (!tracks || tracks.length === 0) {
            throw new Error("No recommended tracks found on Spotify.");
        }
        
        // Return a random track ID
        return tracks[Math.floor(Math.random() * tracks.length)].id;
    } catch (error) {
        console.error("Error fetching Spotify recommendations:", error);
        return null;
    }
}

module.exports = { scAutoPlay, spAutoPlay };
