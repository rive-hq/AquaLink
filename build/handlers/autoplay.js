const https = require('https');
const crypto = require('crypto');

const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    maxFreeSockets: 2,
    timeout: 8000,
    freeSocketTimeout: 4000
});


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

const spotifyAutoPlay = async (seed, player, requester, excludedIdentifiers = []) => {
  try {
    const { trackId, artistIds } = seed
    if (!trackId) return null

    const prevIdentifier = player.current?.identifier
    let seedQuery = `seed_tracks=${trackId}`
    if (artistIds) seedQuery += `&seed_artists=${artistIds}`
    console.log('Seed query:', seedQuery)

    const response = await player.aqua.resolve({
      query: seedQuery,
      source: 'spsearch',
      requester
    })
    const candidates = response?.tracks || []

    const seenIds = new Set(excludedIdentifiers)
    if (prevIdentifier) seenIds.add(prevIdentifier)

    const result = []
    for (const track of candidates) {
      const { identifier } = track
      if (seenIds.has(identifier)) continue
      seenIds.add(identifier)
      track.pluginInfo = {
        ...(track.pluginInfo || {}),
        clientData: { fromAutoplay: true }
      }
      result.push(track)
      if (result.length === 5) break
    }

    return result

  } catch (err) {
    console.error('Spotify autoplay error:', err)
    return null
  }
}


module.exports = {
    scAutoPlay: soundAutoPlay,
    spAutoPlay: spotifyAutoPlay
};
