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

# Omg version 1.6.0 || 1.6.1  woah aqualink

Version 1.6.1:

- Many fixes related to caching and mapping.
- Rewrited `AQUA` again, Should fix a lot of stuff related to speed, async memory leaks, remade some methods, and others stuff;
- Rewrited `CONNECTION` manager again, should be an better cleanup system less memory leaks, correct updating.
- Fixed various stuff + Various speed improvements, and way less recourses used on `NODE` manager.
- Updated `REST` Manager to use better checkings, speed, and dumping system.
- Rewrote the `TRACK` System, fixed small memory leaks, improved speed by wayyy more
- Some misc changes on player, small optimziations, use Fisher-Yates algorithm, and remove useless asyncs.
- Improved the internal code Garbage collection.
- Use more WeakSet and WeakMaps for memory friendly
- Extra: Also fixed requesting every 1 sec, reducing the requests system and memory usage by a lot i think;
-- Im working on new features, ex: autoplay, lyrics system, and more to come... its hard to me as an solo dev


Version 1.6.0:

- Reworked the `TRACK` Manager (This improves the speed by wayyy more, also uses objects, removed useless code)
- Improved the `REST` Manager (This improves the garbage collector, an faster code, and more optimized)
- Added enqueue to `QUEUE` (this gets the previous, made for dev), removed addMultiple (useless)
- Fully Rewrite the `PLAYER` Manager (Way faster resolving, way less recourse intensive, more responsive, better error handling)

^^ Now uses the WeakMap and WeakSet for an garbage collector, making it with an better memory management.

- Rewrite the `NODE` Manager (reconnect speeds improved, various methods improved, Rewrite the cache and status handler, improve the performance) - Also fixed player resuming.
- Remade some stuff in `CONNECTION` (this improves error handling, cleaning up, and speed)
- Rewrite `AQUA` Manager (remade every single method, improved the resolve, made the code dynamic, fixed lots of bugs, uses weakMap too.) - Added autoResume option (true false)

- There are way more stuff that i forgot to add on changelog. pls report bugs on my github !
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
