const https = require('https');
const crypto = require('crypto');

const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const TOTP_SECRET = Buffer.from("5507145853487499592248630329347", 'utf8');

async function quickFetch(url, options = {}, redirectCount = 0) {
    const maxRedirects = 5;
    
    try {
        return await new Promise((resolve, reject) => {
            const req = https.get(url, { ...options, agent }, async (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirectCount >= maxRedirects) {
                        return reject(new Error('Too many redirects'));
                    }
                    
                    res.resume();
                    try {
                        const resolved = await quickFetch(
                            new URL(res.headers.location, url).toString(),
                            options,
                            redirectCount + 1
                        );
                        resolve(resolved);
                    } catch (err) {
                        reject(err);
                    }
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Request failed. Status code: ${res.statusCode}`));
                }

                const chunks = [];
                let length = 0;
                
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                    length += chunk.length;
                });

                res.on('end', () => {
                    resolve(Buffer.concat(chunks, length).toString());
                });
            });

            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy(new Error('Request timeout'));
            });
        });
    } catch (err) {
        throw err;
    }
}

async function soundAutoPlay(baseUrl) {
    try {
        const html = await quickFetch(`${baseUrl}/recommended`);
        const links = new Set();
        const regex = /<a\s+itemprop="url"\s+href="(\/[^"]+)"/g;
        
        let match;
        while ((match = regex.exec(html)) !== null) {
            links.add(`https://soundcloud.com${match[1]}`);
        }

        if (!links.size) {
            throw new Error("No recommended tracks found on SoundCloud.");
        }

        const urls = Array.from(links);
        for (let i = urls.length - 1; i > 0; i--) {
            const j = Math.random() * (i + 1) | 0;
            [urls[i], urls[j]] = [urls[j], urls[i]];
        }

        return urls;
    } catch (err) {
        console.error("Error in SoundCloud autoplay:", err);
        return [];
    }
}

function generateToken() {
    const timeStep = Math.floor(Date.now() / 30000);
    const counter = Buffer.alloc(8);
    counter.writeBigInt64BE(BigInt(timeStep));

    const hmac = crypto.createHmac('sha1', TOTP_SECRET);
    hmac.update(counter);
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0x0f;
    
    const binCode = (
        (hash[offset] << 24) |
        (hash[offset + 1] << 16) |
        (hash[offset + 2] << 8) |
        hash[offset + 3]
    ) & 0x7fffffff;

    const token = (binCode % 1000000).toString().padStart(6, '0');
    return [token, timeStep * 30000];
}

async function spotifyAutoPlay(seedTrackId) {
    const [totp, ts] = generateToken();
    const params = new URLSearchParams({
        reason: "init",
        productType: "embed",
        totp,
        totpVer: "5",
        ts: ts.toString()
    });

    try {
        const tokenData = await quickFetch(`https://open.spotify.com/api/token?${params}`);
        const { accessToken } = JSON.parse(tokenData);
        
        if (!accessToken) throw new Error("Invalid access token");

        const recData = await quickFetch(
            `https://api.spotify.com/v1/recommendations?limit=10&seed_tracks=${seedTrackId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const { tracks } = JSON.parse(recData);
        if (!tracks?.length) throw new Error("No tracks found");

        return tracks[Math.random() * tracks.length | 0].id;
    } catch (err) {
        console.error("Spotify autoplay error:", err);
        throw err;
    }
}

module.exports = {
    scAutoPlay: soundAutoPlay,
    spAutoPlay: spotifyAutoPlay
};
