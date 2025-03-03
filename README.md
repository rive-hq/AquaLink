# AquaLink
An Stable, performant, Recourse friendly and fast lavalink wrapper

This code is based in riffy, but its an 100% Rewrite made from scratch...

# Why use AquaLink
- Uses my modified fork of @performanc/pwsl-mini, for an way faster WebSocket
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
  
# Tralalero Tralala 1.9.0 Released  
**Whoa, lots of stuff to write here 😭**

---

### **Small changes on the `fetchImage` Handler**
- Improves the overall speed, less memory overhead.

---

### **Remade some stuff on `AQUA` module**
- This fixes some bugs related to destroying players.
- Faster node connection speeds.
- Uses an Array for getting the region instead (testing).
- Small change on the Voice Handler.
- Improved Error handling.
- Use `node.destroy()` method directly.

---

### **Remade `Connection` module**
- Removed lots of useless code.
- Improved joining voice channel speed.
- Improved configuration set/get speed.
- Improved overall checking.
- Improved debug messages.

---

### **Remade `Node` module (this one is good)**
- 1.9.1-beta1: Fixed the auto reconnect system
- Fixed the `autoResume` system (now will actually work, for 60 seconds).
- New WebSocket System.
- Improved the events handling speed.
- Now does recalculation of the backoff time (for more efficiency on reconnect).
- Now avoids reconnecting if the WebSocket is already open (sorry, I forgot to add this before).
- Better cleaning system (improved, now removes listeners instead of setting to `null`).
- Avoids re-binding the functions every time `connect` is called (yay).
- This update also improves long-process running.

---

### **Remade the `Player` module (also a good one)**
- Remade every method.
- Fixed destroy system.
- Better event handling, I think.
- Made the events async.
- Removed `trackChange` (does not exist in Lavalink API, use `trackStart` instead).
- Uses a new listener system (way more efficient for creating/destroying players).
- Faster shuffle in V8 Engine (Math stuff).
- Improved overall configs (more precise).
- Use `pop()` instead of disabling the track 50 on the length.
- Improved overall speed on the check-ins and some stuff I forgot.

---

### **Remade the `Rest` module**
- Better speed (removed useless `buildEndpoint`).
- More compact code.
- Removed `stats/all` in the stats (correct by using the Lavalink API).
- Better `makeRequest`.

---

### **Small changes in `Track` module**
- More efficient final result (`author` + `track`).

---

That’s all for **1.9.0** atm. I’m a lazy dev. 😴

# Docs (Wiki)
- https://github.com/ToddyTheNoobDud/AquaLink/wiki

- Example bot: https://github.com/ToddyTheNoobDud/Thorium-Music

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
