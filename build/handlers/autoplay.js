const https = require('https')

const AGENT_CONFIG = {
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 2,
  timeout: 8000,
  freeSocketTimeout: 4000
}

const agent = new https.Agent(AGENT_CONFIG)

const SC_LINK_RE = /<a\s+itemprop="url"\s+href="(\/[^"]+)"/g
const MAX_REDIRECTS = 3
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_SC_LINKS = 50
const MAX_SP_RESULTS = 10
const DEFAULT_TIMEOUT_MS = 8000

const fastFetch = (url, depth = 0) => new Promise((resolve, reject) => {
  if (depth > MAX_REDIRECTS) return reject(new Error('Too many redirects'))

  const req = https.get(url, { agent, timeout: DEFAULT_TIMEOUT_MS }, res => {
    const { statusCode, headers } = res

    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      res.resume()
      return fastFetch(new URL(headers.location, url).href, depth + 1).then(resolve, reject)
    }

    if (statusCode !== 200) {
      res.resume()
      return reject(new Error(`HTTP ${statusCode}`))
    }

    const chunks = []
    let received = 0

    res.on('data', chunk => {
      received += chunk.length
      if (received > MAX_RESPONSE_BYTES) {
        req.destroy(new Error('Response too large'))
        return
      }
      chunks.push(chunk)
    })

    res.on('end', () => {
      try {
        const buf = Buffer.concat(chunks)
        resolve(buf.toString())
      } catch (err) {
        reject(err)
      }
    })
  })

  req.on('error', reject)
  req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new Error('Timeout')))
})

const shuffleInPlace = arr => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

const scAutoPlay = async baseUrl => {
  try {
    const html = await fastFetch(`${baseUrl}/recommended`)
    const links = []
    for (const m of html.matchAll(SC_LINK_RE)) {
      if (!m[1]) continue
      links.push(`https://soundcloud.com${m[1]}`)
      if (links.length >= MAX_SC_LINKS) break
    }
    return links.length ? shuffleInPlace(links) : []
  } catch (err) {
    console.error('scAutoPlay error:', err?.message || err)
    return []
  }
}

const spAutoPlay = async (seed, player, requester, excludedIds = []) => {
  try {
    if (!seed?.trackId && !seed?.artistIds) return null

    const seen = new Set(excludedIds)
    const prevId = player.current?.identifier
    if (prevId) seen.add(prevId)

    const allCandidates = []
    const queries = []

    if (seed.trackId) {
      queries.push(`mix:track:${seed.trackId}`)
    }

    if (seed.artistIds) {
      const artistId = seed.artistIds.split(',')[0].trim()
      queries.push(`mix:artist:${artistId}`)
    }

    for (const query of queries) {
      try {
        let res
        try {

          res = await player.aqua.resolve({ query, source: 'sprec', requester })
        } catch (aquaErr) {
          console.log('Aqua resolve failed, trying Lavalink fallback:', aquaErr.message)

          if (player.nodes?.rest) {
            const lavalinkRes = await player.nodes.rest.get(`/v4/loadtracks?identifier=${encodeURIComponent(query)}`)
            res = { tracks: lavalinkRes.tracks || [] }
          } else {
            throw aquaErr
          }
        }

        const candidates = res?.tracks || []

        let prioritizedCandidates = candidates
        if (seed.artistIds && candidates.length > 0) {
          const seedArtists = seed.artistIds.split(',').map(a => a.trim().toLowerCase())
          const artistTracks = candidates.filter(t =>
            t.info?.author && seedArtists.some(seedArtist =>
              t.info.author.toLowerCase().includes(seedArtist) ||
              seedArtist.includes(t.info.author.toLowerCase())
            )
          )
          const otherTracks = candidates.filter(t => !artistTracks.includes(t))
          prioritizedCandidates = [...artistTracks, ...otherTracks]
        }

        for (const t of prioritizedCandidates) {
          if (!seen.has(t.identifier)) {
            seen.add(t.identifier)
            t.pluginInfo = { ...(t.pluginInfo || {}), clientData: { fromAutoplay: true } }
            allCandidates.push(t)
          }
        }
      } catch (queryErr) {
        console.error(`Query ${query} failed:`, queryErr.message)
      }
    }

    if (!allCandidates.length) return null

    const shuffled = shuffleInPlace([...allCandidates])
    const out = shuffled.slice(0, MAX_SP_RESULTS)

    console.log(`Returning ${out.length} autoplay tracks`)
    return out
  } catch (err) {
    console.error('spAutoPlay error:', err)
    return null
  }
}

module.exports = {
  scAutoPlay,
  spAutoPlay
}
