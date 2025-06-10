const https = require('https');
const crypto = require('crypto');

const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    maxFreeSockets: 2,
    timeout: 8000,
    freeSocketTimeout: 4000
});

const TOTP_SECRET = Buffer.from("5507145853487499592248630329347", 'utf8');

const SOUNDCLOUD_REGEX = /<a\s+itemprop="url"\s+href="(\/[^"]+)"/g;

const shuffleArray = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.random() * (i + 1) | 0;
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
};

const fastFetch = (url, options = {}) => {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { ...options, agent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return fastFetch(new URL(res.headers.location, url).href, options)
                    .then(resolve, reject);
            }

            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });

        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('Timeout')));
    });
};

const soundAutoPlay = async (baseUrl) => {
    try {
        const html = await fastFetch(`${baseUrl}/recommended`);
        
        const links = [];
        let match;
        while ((match = SOUNDCLOUD_REGEX.exec(html)) && links.length < 50) {
            links.push(`https://soundcloud.com${match[1]}`);
        }

        if (!links.length) throw new Error("No tracks found");

        return shuffleArray(links);
    } catch (err) {
        console.error("SoundCloud error:", err.message);
        return [];
    }
};

const generateToken = () => {
    const timeStep = (Date.now() / 30000) | 0;
    const counter = Buffer.allocUnsafe(8);
    counter.writeBigUInt64BE(BigInt(timeStep), 0);

    const hash = crypto.createHmac('sha1', TOTP_SECRET).update(counter).digest();
    const offset = hash[19] & 0x0f;
    
    const binCode = (
        (hash[offset] & 0x7f) << 24 |
        hash[offset + 1] << 16 |
        hash[offset + 2] << 8 |
        hash[offset + 3]
    );

    return [
        (binCode % 1000000).toString().padStart(6, '0'),
        timeStep * 30000
    ];
};

const spotifyAutoPlay = async (seedTrackId) => {
    const [totp, ts] = generateToken();
    
    try {
        const tokenUrl = `https://open.spotify.com/api/token?reason=init&productType=embed&totp=${totp}&totpVer=5&ts=${ts}`;
        const tokenResponse = await fastFetch(tokenUrl);
        const { accessToken } = JSON.parse(tokenResponse);
        
        if (!accessToken) throw new Error("No access token");

        const recUrl = `https://api.spotify.com/v1/recommendations?limit=10&seed_tracks=${seedTrackId}`;
        const recResponse = await fastFetch(recUrl, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const { tracks } = JSON.parse(recResponse);
        if (!tracks?.length) throw new Error("No tracks");

        return tracks[Math.random() * tracks.length | 0].id;
    } catch (err) {
        console.error("Spotify error:", err.message);
        throw err;
    }
};

module.exports = {
    scAutoPlay: soundAutoPlay,
    spAutoPlay: spotifyAutoPlay
};
