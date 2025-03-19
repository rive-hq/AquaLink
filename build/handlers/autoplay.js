const https = require('https');
const crypto = require('crypto');

function quickFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, options, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(quickFetch(res.headers.location, options));
            }
            if (res.statusCode !== 200) {
                res.resume(); 
                return reject(new Error(`Request failed. Status code: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

async function soundAutoPlay(baseUrl) {
    try {
        const html = await quickFetch(`${baseUrl}/recommended`);
        const regex = /<a\s+itemprop="url"\s+href="(\/[^"]+)"/g;
        const links = new Set();
        let match;
        while ((match = regex.exec(html)) !== null) {
            links.add(`https://soundcloud.com${match[1]}`);
        }
        if (!links.size) {
            throw new Error("No recommended tracks found on SoundCloud.");
        }
        const urls = Array.from(links);
        for (let i = urls.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [urls[i], urls[j]] = [urls[j], urls[i]];
        }
        return urls;
    } catch (err) {
        console.error("Error in SoundCloud autoplay:", err);
        return [];
    }
}

function gerenateToKen() {
    const totpSecret = Buffer.from(new Uint8Array([
        53, 53, 48, 55, 49, 52, 53, 56, 53, 51, 52, 56, 55, 52, 57, 57,
        53, 57, 50, 50, 52, 56, 54, 51, 48, 51, 50, 57, 51, 52, 55
    ]));

    // Note for  me: Can also be used from Buffer.from("5507145853487499592248630329347", 'utf8');

    const timeStep = Math.floor(Date.now() / 30000);
    const counter = Buffer.alloc(8);
    counter.writeBigInt64BE(BigInt(timeStep));

    const hmac = crypto.createHmac('sha1', totpSecret);
    hmac.update(counter);
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0x0f;
    const binCode =
        ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);
    const token = (binCode % 1000000).toString().padStart(6, '0');
    return [token, timeStep * 30000];
}

async function spotifyAutoPlay(seedTrackId) {
    const [totp, ts] = gerenateToKen();
    const params = new URLSearchParams({
        reason: "transport",
        productType: "embed",
        totp,
        totpVer: "5",
        ts: ts.toString()
    });
    const tokenUrl = `https://open.spotify.com/get_access_token?${params.toString()}`;
    const tokenData = await quickFetch(tokenUrl);

    let accessToken;
    try {
        accessToken = JSON.parse(tokenData).accessToken;
    } catch {
        throw new Error("Failed to retrieve Spotify access token.");
    }

    const recUrl = `https://api.spotify.com/v1/recommendations?limit=10&seed_tracks=${seedTrackId}`;
    const recData = await quickFetch(recUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });

    let tracks;
    try {
        tracks = JSON.parse(recData).tracks;
    } catch {
        throw new Error("Failed to parse Spotify recommendations.");
    }
    return tracks[Math.floor(Math.random() * tracks.length)].id;
}

module.exports = {
    scAutoPlay: soundAutoPlay,
    spAutoPlay: spotifyAutoPlay
};
