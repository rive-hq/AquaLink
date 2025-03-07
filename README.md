# AquaLink
An Stable, performant, Recourse friendly and fast lavalink wrapper

This code is based in riffy, but its an 100% Rewrite made from scratch...

# Why use AquaLink
- Only uses 1 dependecy (ws for websocket, atm)
- HTTP1.1 / HTTP2 Support
- Very Low memory comsuption
- Built in Queue manager
- Lots of features to use
- Lowest CPU Usage
- Very fast (mine take less than 1 second to load an song!)
- 1 Player created = ~1 - 0,5 mb per player
- Auto clean Up memory when song finishes / bot leave the vc (Now Options supported!)
- Plugin system
- Lavalink v4.0.8 | v4.1.0 Support (Nodelink works, but only with play etc, more support soon)
- Youtube and Spotify support (Soundcloud, deezer, vimeo, etc also works...)
- Minimal Requests to the lavalink server (helps the lavalink recourses!)
- Playlist support (My mix playlists, youtube playlists, spotify playlists, etc)
- Lyrics Support by Lavalink
  - https://github.com/topi314/LavaLyrics (RECOMMENDED)
  - https://github.com/DRSchlaubi/lyrics.kt (?)
  - https://github.com/DuncteBot/java-timed-lyrics (RECOMMENDED)
  
# Tralalero Tralala 2.1.0 Released
---
- Improved the `AQUA` module
  - Faster nodes loading
  - Faster plugin loading
  - Better listeners for player
  - Faster resolving system for playlists

- Remade the `Connection` system
  - Less overheard now.
  - Faster connections
  - Improved the checkings
  - Improved error handling
  - Fixed creating useless Objects and arrays

- Fully rewrite the `Node` system
  - Way faster connections
  - More stable (i think so)
  - Faster events / messages / payloads handling
  - Better stats handling (reusing, creating, destroyin)
  - Some more bug fixes and stuff i forgot.

- Remade the `Player` module
  - Now support Lazy Loading by default
  - Better State Updates
  - Improved Garbage Collection
  - Rewrite to use direct comparasions

- Improved the `Rest` module
  - Lazy loading of http2
  - Faster request chunks
  - Some overall upgrades

- Improved `Track` module
  - Faster track looking
  - More micro optimizations (use Boolean instead of !!)

- Remade the INDEX.D.TS File: Added more 1000 lines of code. Added autocomplete, options, and documented everything.

# Docs (Wiki)
- https://github.com/ToddyTheNoobDud/AquaLink/wiki

- Example bot: https://github.com/ToddyTheNoobDud/Thorium-Music

- Support Server: https://discord.gg/K4CVv84VBC

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

const aqua = Aqua(client, nodes, {
  defaultSearchPlatform: "ytsearch",
  restVersion: "v4",
  autoResume: false,
  infiniteReconnects: true,
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
