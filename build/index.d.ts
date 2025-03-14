import { EventEmitter } from "events";

declare module "aqualink" {
    export class Aqua extends EventEmitter {
        constructor(client: any, nodes: NodeOptions[], options?: AquaOptions);
        client: any;
        nodes: NodeOptions[];
        nodeMap: Map<string, Node>;
        players: Map<string, Player>;
        clientId: string | null;
        initiated: boolean;
        shouldDeleteMessage: boolean;
        defaultSearchPlatform: string;
        leaveOnEnd: boolean;
        restVersion: string;
        plugins: Plugin[];
        version: string;
        send: (payload: any) => void;
        autoResume: boolean;
        infiniteReconnects: boolean;
        options: AquaOptions;
        _leastUsedCache: { nodes: Node[], timestamp: number };

        defaultSendFunction(payload: any): void;
        get leastUsedNodes(): Node[];
        init(clientId: string): Promise<Aqua>;
        createNode(options: NodeOptions): Promise<Node>;
        destroyNode(identifier: string): void;
        updateVoiceState({ d, t }: { d: any, t: string }): void;
        fetchRegion(region: string): Node[];
        calculateLoad(node: Node): number;
        createConnection(options: ConnectionOptions): Player;
        createPlayer(node: Node, options: PlayerOptions): Player;
        destroyPlayer(guildId: string): Promise<void>;
        resolve({ query, source, requester, nodes }: ResolveOptions): Promise<ResolveResponse>;
        getRequestNode(nodes: string | Node): Node;
        ensureInitialized(): void;
        formatQuery(query: string, source: string): string;
        handleNoMatches(rest: Rest, query: string): Promise<any>;
        constructResponse(response: any, requester: any, requestNode: Node): ResolveResponse;
        get(guildId: string): Player;
        search(query: string, requester: any, source?: string): Promise<Track[] | null>;
        cleanupPlayer(player: Player): Promise<void>;
    }

    export class Node {
        constructor(aqua: Aqua, connOptions: NodeOptions, options?: NodeAdditionalOptions);
        aqua: Aqua;
        host: string;
        name: string;
        port: number;
        password: string;
        secure: boolean;
        sessionId: string | null;
        regions: string[];
        wsUrl: string;
        rest: Rest;
        resumeTimeout: number;
        autoResume: boolean;
        reconnectTimeout: number;
        reconnectTries: number;
        infiniteReconnects: boolean;
        connected: boolean;
        info: any;
        ws: WebSocket | null;
        reconnectAttempted: number;
        reconnectTimeoutId: NodeJS.Timeout | null;
        stats: NodeStats;

        initializeStats(): void;
        connect(): Promise<void>;
        destroy(clean?: boolean): void;
        getStats(): Promise<NodeStats>;
    }

    export class Player extends EventEmitter {
        constructor(aqua: Aqua, nodes: Node, options: PlayerOptions);
        aqua: Aqua;
        nodes: Node;
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        connection: Connection;
        filters: Filters;
        volume: number;
        loop: string;
        queue: Queue;
        previousTracks: Track[];
        previousTracksIndex: number;
        previousTracksCount: number;
        shouldDeleteMessage: boolean;
        leaveOnEnd: boolean;
        playing: boolean;
        paused: boolean;
        connected: boolean;
        current: Track | null;
        position: number;
        timestamp: number;
        ping: number;
        nowPlayingMessage: any;
        isAutoplayEnabled: boolean;
        isAutoplay: boolean;

        play(): Promise<void>;
        connect(options: ConnectionOptions): Player;
        destroy(): Player;
        pause(paused: boolean): Player;
        seek(position: number): Player;
        stop(): Player;
        setVolume(volume: number): Player;
        setLoop(mode: string): Player;
        setTextChannel(channel: string): Player;
        setVoiceChannel(channel: string): Player;
        disconnect(): Player;
        shuffle(): Player;
        getQueue(): Queue;
        replay(): Player;
        skip(): Player;
        searchLyrics(query: string): Promise<any>;
        lyrics(): Promise<any>;
        updatePlayer(data: any): Promise<void>;
    }

    export class Track {
        constructor(data: any, requester: any, nodes: Node);
        info: TrackInfo;
        track: string | null;
        playlist: any;
        requester: any;
        nodes: Node;

        resolveThumbnail(thumbnail: string): string | null;
        resolve(aqua: Aqua): Promise<Track | null>;
    }

    export class Rest {
        constructor(aqua: Aqua, options: RestOptions);
        aqua: Aqua;
        sessionId: string;
        version: string;
        baseUrl: string;
        headers: any;
        secure: boolean;
        timeout: number;
        client: any;

        setSessionId(sessionId: string): void;
        makeRequest(method: string, endpoint: string, body?: any): Promise<any>;
        updatePlayer(options: { guildId: string, data: any }): Promise<any>;
        getPlayers(): Promise<any>;
        destroyPlayer(guildId: string): Promise<any>;
        getTracks(identifier: string): Promise<any>;
        decodeTrack(track: string): Promise<any>;
        decodeTracks(tracks: string[]): Promise<any>;
        getStats(): Promise<any>;
        getInfo(): Promise<any>;
        getRoutePlannerStatus(): Promise<any>;
        getRoutePlannerAddress(address: string): Promise<any>;
        getLyrics(options: { track: Track }): Promise<any>;
    }

    export class Queue extends Array<any> {
        constructor(...elements: any[]);
        size: number;
        first: any;
        last: any;

        add(track: any): Queue;
        remove(track: any): void;
        clear(): void;
        shuffle(): void;
        peek(): any;
        toArray(): any[];
        at(index: number): any;
        dequeue(): any;
        isEmpty(): boolean;
        enqueue(track: any): Queue;
    }

    export class Plugin {
        constructor(name: string);
        name: string;

        load(aqua: Aqua): void;
        unload(aqua: Aqua): void;
    }

    export class Filters {
        constructor(player: Player, options?: FilterOptions);
        player: Player;
        volume: number;
        equalizer: any[];
        karaoke: any | null;
        timescale: any | null;
        tremolo: any | null;
        vibrato: any | null;
        rotation: any | null;
        distortion: any | null;
        channelMix: any | null;
        lowPass: any | null;
        bassboost: any | null;
        slowmode: any | null;
        nightcore: any | null;
        vaporwave: any | null;
        _8d: any | null;

        setEqualizer(bands: any[]): Filters;
        setKaraoke(enabled: boolean, options?: any): Filters;
        setTimescale(enabled: boolean, options?: any): Filters;
        setTremolo(enabled: boolean, options?: any): Filters;
        setVibrato(enabled: boolean, options?: any): Filters;
        setRotation(enabled: boolean, options?: any): Filters;
        setDistortion(enabled: boolean, options?: any): Filters;
        setChannelMix(enabled: boolean, options?: any): Filters;
        setLowPass(enabled: boolean, options?: any): Filters;
        setBassboost(enabled: boolean, options?: any): Filters;
        setSlowmode(enabled: boolean, options?: any): Filters;
        setNightcore(enabled: boolean, options?: any): Filters;
        setVaporwave(enabled: boolean, options?: any): Filters;
        set8D(enabled: boolean, options?: any): Filters;
        clearFilters(): Promise<Filters>;
        updateFilters(): Promise<Filters>;
    }

    export class Connection {
        constructor(player: Player);
        playerRef: WeakRef<Player>;
        sessionId: string | null;
        endpoint: string | null;
        token: string | null;
        region: string | null;
        selfDeaf: boolean;
        selfMute: boolean;
        voiceChannel: string;
        guildId: string;
        aqua: Aqua;
        nodes: Node;

        setServerUpdate(data: any): void;
        setStateUpdate(data: any): void;
    }

    interface AquaOptions {
        shouldDeleteMessage?: boolean;
        defaultSearchPlatform?: string;
        leaveOnEnd?: boolean;
        restVersion?: string;
        plugins?: Plugin[];
        send?: (payload: any) => void;
        autoResume?: boolean;
        infiniteReconnects?: boolean;
    }

    interface NodeOptions {
        host: string;
        name?: string;
        port?: number;
        password?: string;
        secure?: boolean;
        sessionId?: string;
        regions?: string[];
    }

    interface NodeAdditionalOptions {
        resumeTimeout?: number;
        autoResume?: boolean;
        reconnectTimeout?: number;
        reconnectTries?: number;
        infiniteReconnects?: boolean;
    }

    interface PlayerOptions {
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        defaultVolume?: number;
        loop?: string;
        shouldDeleteMessage?: boolean;
        leaveOnEnd?: boolean;
    }

    interface ConnectionOptions {
        guildId: string;
        voiceChannel: string;
        deaf?: boolean;
        mute?: boolean;
    }

    interface ResolveOptions {
        query: string;
        source?: string;
        requester: any;
        nodes?: string | Node;
    }

    interface ResolveResponse {
        loadType: string;
        exception: any | null;
        playlistInfo: any | null;
        pluginInfo: any;
        tracks: Track[];
    }

    interface RestOptions {
        secure: boolean;
        host: string;
        port: number;
        sessionId: string;
        password: string;
        timeout?: number;
    }

    interface NodeStats {
        players: number;
        playingPlayers: number;
        uptime: number;
        memory: {
            free: number;
            used: number;
            allocated: number;
            reservable: number;
            freePercentage: number;
            usedPercentage: number;
        };
        cpu: {
            cores: number;
            systemLoad: number;
            lavalinkLoad: number;
            lavalinkLoadPercentage: number;
        };
        frameStats: {
            sent: number;
            nulled: number;
            deficit: number;
        };
        ping: number;
    }

    interface TrackInfo {
        identifier: string;
        isSeekable: boolean;
        author: string;
        length: number;
        isStream: boolean;
        title: string;
        uri: string;
        sourceName: string;
        artworkUrl: string;
    }

    interface FilterOptions {
        volume?: number;
        equalizer?: any[];
        karaoke?: any;
        timescale?: any;
        tremolo?: any;
        vibrato?: any;
        rotation?: any;
        distortion?: any;
        channelMix?: any;
        lowPass?: any;
        bassboost?: any;
        slowmode?: any;
        nightcore?: any;
        vaporwave?: any;
        _8d?: any;
    }
}
