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
- Playlist support (My mix playlists, youtube playlists)

# Docs (Wiki)
- https://github.com/ToddyTheNoobDud/AquaLink/wiki

- Example bot: https://github.com/ToddyTheNoobDud/Thorium-Music

# Yay, Version 1.3.0 is released ! aqualink so cool

+ Updated NODE with more methods (lavalinkLoadPercentage, freePercentage, usedPercentage) + Optimizations
+ Rewrited Aqua.js fully (rewrite events, options, and resolve)
+ Rewrite FetchImage (way more faster, less recourse intensive, better looking)
+ Convert REST to Convert to undici request (experimental, around 221.29 % faster, 12436.39 by difference (requests per min))
^^ Also is faster and more memory efficient...
+ Updated Player with one more method (added player.skip())
+ Remade all the cache system (players joined to vc shall don't use ram, improved cache saving and speed almost)
+ Remade the TRACK handler (improves track handling, speed, recourses usage and cleaning)

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
