declare module "aqualink" {
    import { EventEmitter } from "events";

    export class Aqua extends EventEmitter {
        constructor(client: any, nodes: Array<NodeConfig>, options?: AquaOptions);
        init(clientId: string): this;
        createNode(options: NodeConfig): Node;
        createPlayer(node: Node, options: PlayerOptions): Player;
        destroyPlayer(guildId: string): Promise<void>;
        resolve(options: ResolveOptions): Promise<ResolveResponse>;
        updateVoiceState(data: VoiceStateUpdate): void;
        getOption<T>(options: Record<string, any>, key: string, defaultValue: T): T;
        defaultSendFunction(payload: any): void;
        validateInputs(client: any, nodes: Array<NodeConfig>): void;
        get leastUsedNodes(): Node[];
        fetchRegion(region: string): Node[];
        calculateLoad(node: Node): number;
        createConnection(options: PlayerOptions): Player;
        getRequestNode(nodes?: string | Node): Node;
        ensureInitialized(): void;
        formatQuery(query: string, source: string): string;
        handleNoMatches(rest: Rest, query: string): Promise<ResolveResponse>;
        constructorResponse(response: any, requester: any, requestNode: Node): ResolveResponse;
        get(guildId: string): Player;
        cleanupPlayer(player: Player): void;

        client: any;
        nodes: Array<NodeConfig>;
        nodeMap: Map<string, Node>;
        players: Map<string, Player>;
        clientId: string | null;
        initiated: boolean;
        options: AquaOptions;
        shouldDeleteMessage: boolean;
        defaultSearchPlatform: string;
        leaveOnEnd: boolean;
        restVersion: string;
        plugins: Array<Plugin>;
        version: string;
        send: (payload: any) => void;
        autoResume: boolean;
        infiniteReconnects: boolean;
        _leastUsedCache: { nodes: Node[], timestamp: number };
    }

    export interface AquaOptions {
        send?: (payload: any) => void;
        defaultSearchPlatform?: string;
        restVersion?: string;
        plugins?: Array<Plugin>;
        autoResume?: boolean;
        infiniteReconnects?: boolean;
        shouldDeleteMessage?: boolean;
        leaveOnEnd?: boolean;
    }

    export interface NodeConfig {
        name?: string;
        host: string;
        port: number;
        password: string;
        secure?: boolean;
        sessionId?: string;
        regions?: string[];
    }

    export interface PlayerOptions {
        guildId: string;
        textChannel?: string;
        voiceChannel?: string;
        defaultVolume?: number;
        loop?: string;
        shouldDeleteMessage?: boolean;
        leaveOnEnd?: boolean;
        region?: string;
    }

    export interface ResolveOptions {
        query: string;
        source?: string;
        requester?: any;
        nodes?: string | Node;
    }

    export interface ResolveResponse {
        loadType: string;
        exception: any;
        playlistInfo: any;
        pluginInfo: any;
        tracks: Track[];
    }

    export interface VoiceStateUpdate {
        d: any;
        t: string;
    }

    export class Connection {
        constructor(player: Player);
        setServerUpdate(data: { endpoint: string, token: string }): void;
        setStateUpdate(data: { channel_id: string, session_id: string, self_deaf: boolean, self_mute: boolean }): void;
        _updatePlayerVoiceData(): Promise<void>;

        playerRef: WeakRef<Player>;
        voice: { sessionId: string | null, endpoint: string | null, token: string | null };
        region: string | null;
        selfDeaf: boolean;
        selfMute: boolean;
        voiceChannel: string;
        guildId: string;
        aqua: Aqua;
        nodes: any;
    }

    export class Filters {
        constructor(player: Player, options?: FiltersOptions);
        setEqualizer(bands: Array<any>): Promise<void>;
        setKaraoke(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setTimescale(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setTremolo(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setVibrato(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setRotation(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setDistortion(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setChannelMix(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setLowPass(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setBassboost(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setSlowmode(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setNightcore(enabled: boolean, options?: FiltersOptions): Promise<void>;
        setVaporwave(enabled: boolean, options?: FiltersOptions): Promise<void>;
        set8D(enabled: boolean, options?: FiltersOptions): Promise<void>;
        clearFilters(): Promise<void>;
        updateFilters(): Promise<void>;

        player: Player;
        volume: number;
        equalizer: any[];
        karaoke: any;
        timescale: any;
        tremolo: any;
        vibrato: any;
        rotation: any;
        distortion: any;
        channelMix: any;
        lowPass: any;
        bassboost: any;
        slowmode: any;
        nightcore: any;
        vaporwave: any;
        _8d: any;
    }

    export interface FiltersOptions {
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

    export class Node {
        constructor(aqua: Aqua, connOptions: NodeConfig, options?: NodeOptions);
        connect(): Promise<void>;
        getStats(): Promise<any>;
        destroy(clean?: boolean): void;

        aqua: Aqua;
        name: string;
        host: string;
        port: number;
        password: string;
        secure: boolean;
        sessionId: string | null;
        regions: string[];
        wsUrl: URL;
        rest: Rest;
        resumeTimeout: number;
        autoResume: boolean;
        reconnectTimeout: number;
        reconnectTries: number;
        infiniteReconnects: boolean;
        connected: boolean;
        info: any;
        defaultStats: any;
        stats: any;
    }

    export interface NodeOptions {
        resumeTimeout?: number;
        autoResume?: boolean;
        reconnectTimeout?: number;
        reconnectTries?: number;
        infiniteReconnects?: boolean;
    }

    export class Player extends EventEmitter {
        constructor(aqua: Aqua, nodes: any, options?: PlayerOptions);
        play(): Promise<void>;
        pause(paused: boolean): this;
        skip(): Promise<void>;
        destroy(): void;
        connect(options: PlayerOptions): this;
        disconnect(): this;
        setVolume(volume: number): this;
        setLoop(mode: string): this;
        setTextChannel(channel: string): this;
        setVoiceChannel(channel: string): this;
        shuffle(): this;
        replay(): this;
        stop(): this;
        seek(position: number): this;
        searchLyrics(query: string): Promise<any>;
        lyrics(): Promise<any>;
        addToPreviousTrack(track: Track): void;
        updatePlayer(data: any): Promise<void>;
        cleanup(): Promise<void>;
        updateTrackState(playing: boolean, paused: boolean): void;
        handleEvent(payload: any): Promise<void>;
        handleUnknownEvent(payload: any): void;
        trackStart(player: Player, track: Track): Promise<void>;
        trackEnd(player: Player, track: Track, payload: any): Promise<void>;
        trackError(player: Player, track: Track, payload: any): Promise<void>;
        trackStuck(player: Player, track: Track, payload: any): Promise<void>;
        socketClosed(player: Player, payload: any): Promise<void>;
        send(data: any): void;

        static LOOP_MODES: { NONE: string, TRACK: string, QUEUE: string };
        static EVENT_HANDLERS: { [key: string]: string };
        static validModes: Set<string>;

        aqua: Aqua;
        nodes: any;
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        connection: Connection;
        filters: Filters;
        volume: number;
        loop: string;
        queue: Queue;
        previousTracks: Track[];
        shouldDeleteMessage: boolean;
        leaveOnEnd: boolean;
        playing: boolean;
        paused: boolean;
        connected: boolean;
        current: Track | null;
        timestamp: number;
        ping: number;
        nowPlayingMessage: any;
        onPlayerUpdate: (state: any) => void;
    }

    export class Plugin {
        constructor(name: string);
        load(aqua: Aqua): void;
        unload(aqua: Aqua): void;

        name: string;
    }

    export class Queue extends Array<any> {
        constructor(...elements: any[]);
        size: number;
        first: any;
        last: any;
        add(track: any): this;
        remove(track: any): void;
        clear(): void;
        shuffle(): void;
        peek(): any;
        toArray(): any[];
        at(index: number): any;
        dequeue(): any;
        isEmpty(): boolean;
        enqueue(track: any): this;
    }

    export class Rest {
        constructor(aqua: Aqua, options: RestOptions);
        makeRequest(method: string, endpoint: string, body?: any): Promise<any>;
        getPlayers(): Promise<any>;
        destroyPlayer(guildId: string): Promise<void>;
        getTracks(identifier: string): Promise<any>;
        decodeTrack(track: string): Promise<any>;
        decodeTracks(tracks: any[]): Promise<any>;
        getStats(): Promise<any>;
        getInfo(): Promise<any>;
        getRoutePlannerStatus(): Promise<any>;
        getRoutePlannerAddress(address: string): Promise<any>;
        getLyrics(options: { track: any }): Promise<any>;
        setSessionId(sessionId: string): void;
        buildEndpoint(...segments: string[]): string;
        validateSessionId(): void;
        updatePlayer(options: { guildId: string, data: any }): Promise<void>;

        aqua: Aqua;
        sessionId: string;
        version: string;
        baseUrl: string;
        headers: Record<string, string>;
        client: any;
    }

    export interface RestOptions {
        secure: boolean;
        host: string;
        port: number;
        sessionId: string;
        password: string;
    }

    export class Track {
        constructor(data: TrackData, requester: Player, nodes: Node);
        resolve(aqua: Aqua): Promise<Track | null>;
        resolveThumbnail(thumbnail: string): string | null;
        _findMatchingTrack(tracks: Track[]): Track | null;

        info: TrackInfo;
        track: string | null;
        playlist: any;
        requester: Player;
        nodes: Node;
    }

    export interface TrackData {
        info?: TrackInfo;
        encoded?: string;
        playlist?: any;
    }

    export interface TrackInfo {
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
}
