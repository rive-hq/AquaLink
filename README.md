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
- 1 Player created = ~1 - 0,8 mb per player
- Auto clean Up memory when song finishes / bot leave the vc
- Plugin system
- Lavalink v4 support (din't test v3)
- Youtube and Spotify support
- Minimal Requests to the lavalink server (helps the lavalink recourses!)

# How to install

`npm install aqualink`

`pnpm install aqualink`

# Basic usage

```javascript
const { Aqua } = require('aqualink')
const { Client, GatewayDispatchEvents, EmbedBuilder } = require("discord.js");

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
        password: "anpasswordthatiforgotforever",
        port: 9350,
        secure: false,
        name: "toddys"
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

process.on("unhandledRejection", (error) => {
    console.error(error);
})

process.on("uncaughtException", (error) => {
    console.error(error);
})
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

    const player = client.aqua.players.get(message.guild.id) ?? client.aqua.createConnection({
        guildId: message.guild.id,
        voiceChannel: message.member.voice.channel.id,
        textChannel: message.channel.id,
        deaf: true,
    });

    const resolve = await client.aqua.resolve({ query, requester: message.member });

    if (resolve.loadType === 'playlist') {
        await message.channel.send(`Added ${resolve.tracks.length} songs from ${resolve.playlistInfo.name} playlist.`);
        player.queue.add(resolve.tracks);

    } else if (resolve.loadType === 'search' || resolve.loadType === 'track') {
        const track = resolve.tracks.shift();
        track.info.requester = message.member;
        player.queue.add(track);

        await message.channel.send(`Added **${track.info.title}** to the queue.`);

    } else {
        return message.channel.send(`There were no results found for your query.`);
    }

    if (!player.playing && !player.paused && player.queue.size > 0) return player.play();
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (!message.content.startsWith("!queue")) return;

    const player = client.aqua.players.get(message.guild.id);

    if (!player) return message.channel.send({ content: "There is no player in this guild." });
    if (player.queue.size === 0) return message.channel.send({ content: "There are no songs in the queue." });

    const tracks = player.queue.map((track) => `${track.info.title} - ${track.info.author}`);

    const queue = new EmbedBuilder()
        .setTitle("Queue")
        .setDescription(tracks.join("\n"))
        .setFooter({ text: `Total tracks: ${player.queue.size}` });

    await message.channel.send({ embeds: [queue] });

});

client.aqua.on("nodeConnect", (node) => {
    console.log(`Node connected: ${node.name}`);
});
client.aqua.on("nodeError", (node, error) => {
    console.log(`Node "${node.name}" encountered an error: ${error.message}.`);
});

client.login("Yourtokenhere");
```
