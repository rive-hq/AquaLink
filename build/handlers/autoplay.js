const https = require('https');

function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetch(res.headers.location, options).then(resolve).catch(reject);
            }
            
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Request failed. Status code: ${res.statusCode}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        req.on('error', err => {
            reject(err);
        });
        
        req.end();
    });
}

async function scAutoPlay(url) {
    try {
        const html = await fetch(`${url}/recommended`);
        
        const regex = /<a itemprop="url" href="(\/.*?)"/g;
        const hrefs = new Set();
        let match;
        
        while ((match = regex.exec(html)) !== null) {
            hrefs.add(`https://soundcloud.com${match[1]}`);
        }
        
        if (hrefs.size === 0) {
            throw new Error("No recommended tracks found on SoundCloud.");
        }
        
        const shuffledHrefs = Array.from(hrefs);
        for (let i = shuffledHrefs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledHrefs[i], shuffledHrefs[j]] = [shuffledHrefs[j], shuffledHrefs[i]];
        }
        
        return shuffledHrefs;
    } catch (error) {
        console.error("Error fetching SoundCloud recommendations:", error);
        return [];
    }
}

async function spAutoPlay(track_id) {
    try {
        const tokenResponse = await fetch("https://open.spotify.com/get_access_token?reason=transport&productType=embed");
        const tokenData = JSON.parse(tokenResponse);
        const accessToken = tokenData?.accessToken;
        
        if (!accessToken) throw new Error("Failed to retrieve Spotify access token");
        
        const recommendationsResponse = await fetch(
            `https://api.spotify.com/v1/recommendations?limit=5&seed_tracks=${track_id}&fields=tracks.id`, 
            {
                headers: { 
                    Authorization: `Bearer ${accessToken}`, 
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const data = JSON.parse(recommendationsResponse);
        const tracks = data?.tracks || [];
        
        if (tracks.length === 0) {
            throw new Error("No recommended tracks found on Spotify.");
        }
        
        return tracks[Math.floor(Math.random() * tracks.length)].id;
    } catch (error) {
        console.error("Error fetching Spotify recommendations:", error);
        return null;
    }
}

module.exports = { scAutoPlay, spAutoPlay };
