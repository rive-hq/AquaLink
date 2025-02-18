# AquaLink
An Stable, performant, Recourse friendly and fast lavalink wrapper

This code is based in riffy, but its an 100% Rewrite made from scratch...

# Why use AquaLink
- Works with [Lavalink](https://github.com/lavalink-devs/Lavalink) and [NodeLink](https://github.com/PerformanC/NodeLink)
- Very Low memory comsuption
- Built in Queue manager
- Lots of features to use
- Lowest CPU Usage
- Very fast (mine take less than 1 second to load an song!)
- 1 Player created = ~1 - 0,5 mb per player
- Auto clean Up memory when song finishes / bot leave the vc (Now Options supported!)
- Plugin system
- Lavalink v4 support (din't test v3)
- Youtube and Spotify support (Soundcloud, deezer, vimeo, etc also works...)
- Minimal Requests to the lavalink server (helps the lavalink recourses!)
- Easy player, node, aqua manager 
- Fast responses from rest and node
- Playlist support (My mix playlists, youtube playlists, spotify playlists, etc)
- Lyrics Support by Lavalink
  - https://github.com/topi314/LavaLyrics (RECOMMENDED)
  - https://github.com/DRSchlaubi/lyrics.kt (?)
  - https://github.com/DuncteBot/java-timed-lyrics (RECOMMENDED)

# Docs (Wiki)
- https://github.com/ToddyTheNoobDud/AquaLink/wiki

- Example bot: https://github.com/ToddyTheNoobDud/Thorium-Music

# Brick by brick, 1.8.0 Update (yay)

- Misc changes on FetchImage (improves the overall checking and speed)

- Rewrite `AQUA` module
  - Remade the resolve logic (improves the speed by a lot)
  - Fixes many memory usages related to nodes
  - send is no longer required to be Applied (Applied by default now.)
  - Remade some stuff with discord VoiceGateway

- Remade `CONNECTION` module
  - Way faster connections (Joining, reconnecting, connected, disconnect)
  - Reduced memory overload by removing useless code
  - Improved early Returns

- Remade `NODE` module
  - MANY fixes for the connection logic (fixes reconnection, etc)
  - Fixed memory leaks in heartbeat system (hopefully, reduced memory by a lot.)
  - Faster connection speed and checkings
  - Remade the Options system, improve JSON parsing

- Rewrite `PLAYER` module
  - Many memory related fixes
  - Improved the overall code speed by a lot
  - Rewrote setLoop, play, shuffle, replay methods (fixes + performance)
  - Added 2 new options: 

      leaveOnEnd: false, // Optional
      
      shouldDeleteMessage: true // Optional
    
  - Uses array for better performance and less memory allocation
  - Rewrite the Events handling (speed and recourses fixes)

- Updated `TRACK` module
  - Better object handling for internal code.
  - Removed an useless method

Thats all for now, im lazy, help me fix code and improve this on github... i can't test properly 😭😭😭

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
