# AquaLink
An Stable, performant, Recourse friendly and fast lavalink wrapper

This code is based in riffy, but its an 100% Rewrite made from scratch...

# Why use AquaLink
- In dev
- Very Low memory comsuption
- Built in Queue manager
- Lots of features to use
- Lowest CPU Usage
- Very fast (mine take less than 1 second to load an song!)
- 1 Player created = ~1 - 0,5 mb per player
- Auto clean Up memory when song finishes / bot leave the vc
- Plugin system
- Lavalink v4 support (din't test v3)
- Youtube and Spotify support
- Minimal Requests to the lavalink server (helps the lavalink recourses!)
- Easy player, node, aqua managing
- Fast responses from rest and node
- Playlist support (My mix playlists, youtube playlists, spotify playlists)

# Docs (Wiki)
- https://github.com/ToddyTheNoobDud/AquaLink/wiki

- Example bot: https://github.com/ToddyTheNoobDud/Thorium-Music

# Real changelog for 1.7.0-beta1
Note: Not features are widely tested / Not fully Complete

- Reformated the `PLAYER` System (removed Documentation for now)
  - Notable Changes:
  - New WeakMap System (Properly handling, deleting, setting)
  - Around 2x faster (by my tests, taked 0ms to resolve an song)
  - Uses less recourses (reduced by around ~0,5mb, also less cpu instensive)

- Fix Some errors in `REST`, Now destroyPlayer, etc, should work as expected.
- Rewrited out the `TRACK` System
  - Reduced object creation
  - Use direct acess
  - use direct destroy() instead of Object.assing()
  - Separate _findMatchingTrack()
  - Rewrite the search system, Removed useless caching, Improved speed, use traditional for ... of instead of find() - Experimental

- Rewrited out the `NODE` System
  - Implement the InfiniteReconnects Option (this will make the code try to connect to an node non-stop.)
  - WeakMap has been replaced with statsCache (experimental)
  - Optimized by using free, used and allocated direct.
  - Backoff in reconnect logic (by using Math)
  - Clear reconnectTimeoutId (prevent memory leaks)
  - Improve the overall speed by a bit

- Rewrited the `CONNECTION` System
  - Improved the Connecting, Resolving, Reconnecting Speed (around 1,5x faster now)
  - Improved checking
  - Cached frequently used Code
  - Object.assign Implemented for Batch updates
  - Still in testing, pls report bugs

- Some Additions for `AQUA`
  - Implement the InfiniteReconnects Options
  - Re-added our DOCS (Now autocomplete works again!)
  - Add platforms + search system on DefaultPlatform

  - Rewrited the updateVoiceState System
  - Misc changes to createConnection
  - Document + fix destroyPlayer

- Remade some stuff in `FetchImage`
  - Use promise.race since only first sucess is required. (will be tested, may revert to promise.any)
  - Use map cuz its faster and more efficient than Objects.

# How to install

`npm install aqualink`

`pnpm install aqualink`

# Basic usage

```javascript
// If you're using Module, use this:
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);

//const { Aqua } = require('aqualink');



const { Aqua } = require("aqualink");
const { Client, Collection, GatewayDispatchEvents } = require("discord.js");

const client = new Client({
    intents: [
        "Guilds",
        "GuildMembers",
        "GuildMessages",
        "MessageContent",
        "GuildVoiceStates"
    ]
});

const nodes = [
    {
        host: "127.0.0.1",
        password: "yourpass",
        port: 233,
        secure: false,
        name: "localhost"
    }
];

const aqua = new Aqua(client, nodes, {
    send: (payload) => {
        const guild = client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    },
    defaultSearchPlatform: "ytsearch",
    restVersion: "v4"
});


client.aqua = aqua;


client.once("ready", () => {
    client.aqua.init(client.user.id);
    console.log("Ready!");
});


client.on("raw", (d) => {
    if (![GatewayDispatchEvents.VoiceStateUpdate, GatewayDispatchEvents.VoiceServerUpdate,].includes(d.t)) return;
    client.aqua.updateVoiceState(d);
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (!message.content.startsWith("!play")) return;

    const query = message.content.slice(6);

    const player = client.aqua.createConnection({
        guildId: message.guild.id,
        voiceChannel: message.member.voice.channel.id,
        textChannel: message.channel.id,
        deaf: true,
    });

    const resolve = await client.aqua.resolve({ query, requester: message.member });

    if (resolve.loadType === 'playlist') {
        await message.channel.send(`Added ${resolve.tracks.length} songs from ${resolve.playlistInfo.name} playlist.`);
        player.queue.add(resolve.tracks);
        if (!player.playing && !player.paused) return player.play();

    } else if (resolve.loadType === 'search' || resolve.loadType === 'track') {
        const track = resolve.tracks.shift();
        track.info.requester = message.member;

        player.queue.add(track);

        await message.channel.send(`Added **${track.info.title}** to the queue.`);

        if (!player.playing && !player.paused) return player.play();

    } else {
        return message.channel.send(`There were no results found for your query.`);
    }
});

client.aqua.on("nodeConnect", (node) => {
    console.log(`Node connected: ${node.name}`);
});
client.aqua.on("nodeError", (node, error) => {
    console.log(`Node "${node.name}" encountered an error: ${error.message}.`);
});

client.login("Yourtokenhere");
```
