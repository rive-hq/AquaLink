import { EventEmitter } from "events";

declare module "aqualink" {
    // Main Classes
    export class Aqua extends EventEmitter {
        constructor(client: any, nodes: NodeOptions[], options?: AquaOptions);

        // Core Properties
        client: any;
        nodes: NodeOptions[];
        nodeMap: Map<string, Node>;
        players: Map<string, Player>;
        clientId: string | null;
        initiated: boolean;
        shouldDeleteMessage: boolean;
        defaultSearchPlatform: SearchSource;
        leaveOnEnd: boolean;
        restVersion: RestVersion;
        plugins: Plugin[];
        version: string;
        send: (payload: any) => void;
        autoResume: boolean;
        infiniteReconnects: boolean;
        options: AquaOptions;
        failoverOptions: FailoverOptions;

        // Private properties (for autocomplete awareness)
        private _leastUsedNodesCache: Node[] | null;
        private _leastUsedNodesCacheTime: number;
        private _nodeStates: Map<string, NodeState>;
        private _failoverQueue: Map<string, number>;
        private _lastFailoverAttempt: Map<string, number>;
        private _brokenPlayers: Map<string, BrokenPlayerState>;
        private _nodeLoadCache: Map<string, number>;
        private _nodeLoadCacheTime: Map<string, number>;

        // Getters
        get leastUsedNodes(): Node[];

        // Core Methods
        init(clientId: string): Promise<Aqua>;
        createNode(options: NodeOptions): Promise<Node>;
        destroyNode(identifier: string): void;
        updateVoiceState(data: VoiceStateUpdate): void;
        fetchRegion(region: string): Node[];
        createConnection(options: ConnectionOptions): Player;
        createPlayer(node: Node, options: PlayerOptions): Player;
        destroyPlayer(guildId: string): Promise<void>;
        resolve(options: ResolveOptions): Promise<ResolveResponse>;
        get(guildId: string): Player;
        search(query: string, requester: any, source?: SearchSource): Promise<Track[] | null>;

        // Advanced Methods
        searchSuggestions(query: string, source?: SearchSource): Promise<SearchSuggestion[]>;
        autocomplete(query: string, source?: SearchSource): Promise<AutocompleteResult>;
        cleanupPlayer(player: Player): Promise<void>;
        handleFailover(player: Player, error: Error): Promise<boolean>;
        handleNodeFailover(failedNode: Node): Promise<void>;
        getHealthyNodes(): Node[];
        isNodeHealthy(node: Node): boolean;
        loadPlayers(filePath?: string): Promise<void>;
        savePlayer(filePath?: string): Promise<void>;
        destroy(): Promise<void>;

        // Private Methods (for awareness)
        private _createDefaultSend(): (payload: any) => void;
        private _getCachedNodeLoad(node: Node): number;
        private _calculateNodeLoad(node: Node): number;
        private _getRequestNode(nodes?: string | Node | Node[]): Node;
        private _chooseLeastBusyNode(nodes: Node[]): Node | null;
        private _constructResponse(response: any, requester: any, requestNode: Node): ResolveResponse;
    }

    export class Node {
        constructor(aqua: Aqua, connOptions: NodeOptions, options?: NodeAdditionalOptions);

        // Core Properties
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
        info: NodeInfo | null;
        ws: WebSocket | null;
        reconnectAttempted: number;
        reconnectTimeoutId: NodeJS.Timeout | null;
        stats: NodeStats;
        lastFailure: number;
        health: NodeHealth;
        players: Set<Player>;

        // Methods
        connect(): Promise<void>;
        destroy(clean?: boolean): void;
        getStats(): Promise<NodeStats>;
        isHealthy(): boolean;
        markFailure(): void;
        markSuccess(): void;
        getHealth(): NodeHealth;
        initializeStats(): void;
    }

    export class Player extends EventEmitter {
        constructor(aqua: Aqua, node: Node, options: PlayerOptions);

        // Static Properties
        static readonly LOOP_MODES: {
            readonly NONE: 0;
            readonly TRACK: 1;
            readonly QUEUE: 2;
        };
        static readonly EVENT_HANDLERS: Record<string, string>;

        // Core Properties
        aqua: Aqua;
        node: Node;
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        connection: Connection;
        filters: Filters;
        volume: number;
        loop: LoopMode;
        queue: Queue;
        previousTracks: CircularBuffer;
        shouldDeleteMessage: boolean;
        leaveOnEnd: boolean;
        playing: boolean;
        paused: boolean;
        connected: boolean;
        destroyed: boolean;
        current: Track | null;
        position: number;
        timestamp: number;
        ping: number;
        nowPlayingMessage: any;
        isAutoplayEnabled: boolean;
        isAutoplay: boolean;
        autoplaySeed: AutoplaySeed | null;
        deaf: boolean;
        mute: boolean;

        // Getters
        get previous(): Track | null;
        get currenttrack(): Track | null;

        // Core Methods
        play(): Promise<void>;
        connect(options?: ConnectionOptions | null): Player;
        destroy(): Player;
        pause(paused: boolean): Player;
        seek(position: number): Player;
        stop(): Player;
        setVolume(volume: number): Player;
        setLoop(mode: LoopMode | LoopModeName): Player;
        setTextChannel(channel: string): Player;
        setVoiceChannel(channel: string): Player;
        disconnect(): Player;
        shuffle(): Player;
        getQueue(): Queue;
        replay(): Player;
        skip(): Player;

        // Advanced Methods
        getLyrics(options?: LyricsOptions): Promise<LyricsResponse | null>;
        subscribeLiveLyrics(): Promise<any>;
        unsubscribeLiveLyrics(): Promise<any>;
        autoplay(): Promise<Player>;
        setAutoplay(enabled: boolean): Player;
        updatePlayer(data: any): Promise<any>;
        cleanup(): Promise<void>;

        // Data Methods
        set(key: string, value: any): void;
        get(key: string): any;
        clearData(): Player;

        // Utility Methods
        send(data: any): void;
        batchUpdatePlayer(data: any, immediate?: boolean): Promise<void>;

        // Event Handlers
        trackStart(player: Player, track: Track): Promise<void>;
        trackEnd(player: Player, track: Track, payload: TrackEndPayload): Promise<void>;
        trackError(player: Player, track: Track, payload: TrackErrorPayload): Promise<void>;
        trackStuck(player: Player, track: Track, payload: TrackStuckPayload): Promise<void>;
        socketClosed(player: Player, track: Track, payload: SocketClosedPayload): Promise<void>;
        lyricsLine(player: Player, track: Track, payload: LyricsLinePayload): Promise<void>;
        lyricsFound(player: Player, track: Track, payload: LyricsFoundPayload): Promise<void>;
        lyricsNotFound(player: Player, track: Track, payload: LyricsNotFoundPayload): Promise<void>;
    }

    export class Track {
        constructor(requester: any, node: Node, data?: TrackData);

        info: TrackInfo;
        track: string | null;
        playlist: PlaylistInfo | null;
        requester: any;
        node: Node;
        identifier: string;

        get length(): number;
        get thumbnail(): string;

        resolveThumbnail(url?: string): string | null;
        resolve(aqua: Aqua): Promise<Track | null>;
        isValid(): boolean;
        dispose(): void;
    }

    export class Rest {
        constructor(aqua: Aqua, options: RestOptions);

        aqua: Aqua;
        sessionId: string;
        version: RestVersion;
        baseUrl: string;
        headers: Record<string, string>;
        secure: boolean;
        timeout: number;
        client: any;
        calls: number;

        setSessionId(sessionId: string): void;
        makeRequest(method: HttpMethod, endpoint: string, body?: any): Promise<any>;
        updatePlayer(options: UpdatePlayerOptions): Promise<any>;
        getPlayers(): Promise<PlayerInfo[]>;
        destroyPlayer(guildId: string): Promise<any>;
        getTracks(identifier: string): Promise<Track[]>;
        decodeTrack(track: string): Promise<TrackInfo>;
        decodeTracks(tracks: string[]): Promise<TrackInfo[]>;
        getStats(): Promise<NodeStats>;
        getInfo(): Promise<NodeInfo>;
        getRoutePlannerStatus(): Promise<RoutePlannerStatus>;
        getRoutePlannerAddress(address: string): Promise<RoutePlannerAddress>;
        getLyrics(options: GetLyricsOptions): Promise<LyricsResponse>;
        getSearchSuggestions(query: string, source?: SearchSource): Promise<SearchSuggestion[]>;
        getAutocompleteSuggestions(query: string, source?: SearchSource): Promise<AutocompleteResult>;
        subscribeLiveLyrics(guildId: string, sync?: boolean): Promise<any>;
        unsubscribeLiveLyrics(guildId: string): Promise<any>;
    }

    export class Queue extends Array<Track> {
        constructor(...elements: Track[]);

        // Properties
        get size(): number;
        get first(): Track | null;
        get last(): Track | null;

        // Methods
        add(track: Track): Queue;
        remove(track: Track): boolean;
        clear(): void;
        shuffle(): Queue;
        peek(): Track | null;
        toArray(): Track[];
        at(index: number): Track | undefined;
        dequeue(): Track | undefined;
        isEmpty(): boolean;
        enqueue(track: Track): Queue;
    }

    export class Plugin {
        constructor(name: string);

        name: string;

        load(aqua: Aqua): void | Promise<void>;
        unload(aqua: Aqua): void | Promise<void>;
    }

    export class Filters {
        constructor(player: Player, options?: FilterOptions);

        player: Player;
        volume: number;
        equalizer: EqualizerBand[];
        karaoke: KaraokeSettings | null;
        timescale: TimescaleSettings | null;
        tremolo: TremoloSettings | null;
        vibrato: VibratoSettings | null;
        rotation: RotationSettings | null;
        distortion: DistortionSettings | null;
        channelMix: ChannelMixSettings | null;
        lowPass: LowPassSettings | null;
        bassboost: BassBoostSettings | null;
        slowmode: SlowModeSettings | null;
        nightcore: NightcoreSettings | null;
        vaporwave: VaporwaveSettings | null;
        _8d: EightDSettings | null;

        // Filter Methods
        setEqualizer(bands: EqualizerBand[]): Filters;
        setKaraoke(enabled: boolean, options?: KaraokeSettings): Filters;
        setTimescale(enabled: boolean, options?: TimescaleSettings): Filters;
        setTremolo(enabled: boolean, options?: TremoloSettings): Filters;
        setVibrato(enabled: boolean, options?: VibratoSettings): Filters;
        setRotation(enabled: boolean, options?: RotationSettings): Filters;
        setDistortion(enabled: boolean, options?: DistortionSettings): Filters;
        setChannelMix(enabled: boolean, options?: ChannelMixSettings): Filters;
        setLowPass(enabled: boolean, options?: LowPassSettings): Filters;
        setBassboost(enabled: boolean, options?: BassBoostSettings): Filters;
        setSlowmode(enabled: boolean, options?: SlowModeSettings): Filters;
        setNightcore(enabled: boolean, options?: NightcoreSettings): Filters;
        setVaporwave(enabled: boolean, options?: VaporwaveSettings): Filters;
        set8D(enabled: boolean, options?: EightDSettings): Filters;
        clearFilters(): Promise<Filters>;
        updateFilters(): Promise<Filters>;
    }

    export class Connection {
        constructor(player: Player);

        private _player: Player;
        private _aqua: Aqua;
        private _node: Node;
        private _guildId: string;
        private _clientId: string | null;

        voiceChannel: string;
        sessionId: string | null;
        endpoint: string | null;
        token: string | null;
        region: string | null;
        sequence: number;
        private _lastEndpoint: string | null;
        private _pendingUpdate: { isResume: boolean } | null;
        private _updateTimer: NodeJS.Timeout | null;

        private _checkListeners(): void;
        private _extractRegion(endpoint: string): string | null;
        setServerUpdate(data: VoiceServerUpdate['d']): void;
        setStateUpdate(data: VoiceStateUpdate['d']): void;
        private _handleDisconnect(): void;
        updateSequence(seq: number): void;
        private _clearPendingUpdate(): void;
        private _scheduleVoiceUpdate(isResume?: boolean): void;
        private _executeVoiceUpdate(): void;
        private _sendUpdate(payload: any): Promise<void>;
        destroy(): void;
    }

    // Utility Classes
    export class CircularBuffer {
        constructor(size?: number);

        buffer: any[];
        size: number;
        index: number;
        count: number;

        push(item: any): void;
        getLast(): any;
        clear(): void;
    }

    // Enhanced Options and Configuration Interfaces
    export interface AquaOptions {
        shouldDeleteMessage?: boolean;
        defaultSearchPlatform?: SearchSource;
        leaveOnEnd?: boolean;
        restVersion?: RestVersion;
        plugins?: Plugin[];
        send?: (payload: any) => void;
        autoResume?: boolean;
        infiniteReconnects?: boolean;
        failoverOptions?: FailoverOptions;
    }

    export interface FailoverOptions {
        enabled?: boolean;
        maxRetries?: number;
        retryDelay?: number;
        preservePosition?: boolean;
        resumePlayback?: boolean;
        cooldownTime?: number;
        maxFailoverAttempts?: number;
        healthCheckInterval?: number;
        unhealthyThreshold?: number;
        recoveryCooldown?: number;
    }

    export interface NodeOptions {
        host: string;
        name?: string;
        port?: number;
        password?: string;
        secure?: boolean;
        sessionId?: string;
        regions?: string[];
        priority?: number;
        retryAmount?: number;
        retryDelay?: number;
    }

    export interface NodeAdditionalOptions {
        resumeTimeout?: number;
        autoResume?: boolean;
        reconnectTimeout?: number;
        reconnectTries?: number;
        infiniteReconnects?: boolean;
    }

    export interface PlayerOptions {
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        defaultVolume?: number;
        loop?: LoopModeName;
        shouldDeleteMessage?: boolean;
        leaveOnEnd?: boolean;
        autoplay?: boolean;
        enableFailover?: boolean;
        deaf?: boolean;
        mute?: boolean;
    }

    export interface ConnectionOptions {
        guildId: string;
        voiceChannel: string;
        textChannel?: string;
        deaf?: boolean;
        mute?: boolean;
        defaultVolume?: number;
        region?: string;
    }

    export interface ResolveOptions {
        query: string;
        source?: SearchSource;
        requester: any;
        node?: string | Node | Node[];
    }

    export interface RestOptions {
        secure: boolean;
        host: string;
        port: number;
        sessionId: string;
        password: string;
        timeout?: number;
    }

    // Response and Data Interfaces
    export interface ResolveResponse {
        loadType: LoadType;
        exception: LavalinkException | null;
        playlistInfo: PlaylistInfo | null;
        pluginInfo: Record<string, any>;
        tracks: Track[];
    }

    export interface NodeStats {
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

    export interface NodeInfo {
        version: {
            semver: string;
            major: number;
            minor: number;
            patch: number;
            preRelease?: string;
            build?: string;
        };
        buildTime: number;
        git: {
            branch: string;
            commit: string;
            commitTime: number;
        };
        jvm: string;
        lavaplayer: string;
        sourceManagers: string[];
        filters: string[];
        plugins: Array<{
            name: string;
            version: string;
        }>;
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
        artworkUrl: string | null;
        position?: number;
        isrc?: string;
    }

    export interface TrackData {
        encoded?: string;
        info: TrackInfo;
        playlist?: PlaylistInfo;
    }

    export interface PlaylistInfo {
        name: string;
        selectedTrack: number;
        thumbnail?: string;
        author?: string;
        duration?: number;
        trackCount?: number;
    }

    export interface LavalinkException {
        message: string;
        severity: ExceptionSeverity;
        cause: string;
    }

    export interface NodeHealth {
        healthy: boolean;
        consecutiveFailures: number;
        lastCheck: number;
        responseTime: number;
        uptime: number;
    }

    // Filter Interfaces
    export interface FilterOptions {
        volume?: number;
        equalizer?: EqualizerBand[];
        karaoke?: KaraokeSettings;
        timescale?: TimescaleSettings;
        tremolo?: TremoloSettings;
        vibrato?: VibratoSettings;
        rotation?: RotationSettings;
        distortion?: DistortionSettings;
        channelMix?: ChannelMixSettings;
        lowPass?: LowPassSettings;
        bassboost?: BassBoostSettings;
        slowmode?: SlowModeSettings;
        nightcore?: NightcoreSettings;
        vaporwave?: VaporwaveSettings;
        _8d?: EightDSettings;
    }

    export interface EqualizerBand {
        band: number;
        gain: number;
    }

    export interface KaraokeSettings {
        level?: number;
        monoLevel?: number;
        filterBand?: number;
        filterWidth?: number;
    }

    export interface TimescaleSettings {
        speed?: number;
        pitch?: number;
        rate?: number;
    }

    export interface TremoloSettings {
        frequency?: number;
        depth?: number;
    }

    export interface VibratoSettings {
        frequency?: number;
        depth?: number;
    }

    export interface RotationSettings {
        rotationHz?: number;
    }

    export interface DistortionSettings {
        sinOffset?: number;
        sinScale?: number;
        cosOffset?: number;
        cosScale?: number;
        tanOffset?: number;
        tanScale?: number;
        offset?: number;
        scale?: number;
    }

    export interface ChannelMixSettings {
        leftToLeft?: number;
        leftToRight?: number;
        rightToLeft?: number;
        rightToRight?: number;
    }

    export interface LowPassSettings {
        smoothing?: number;
    }

    export interface BassBoostSettings {
        frequency?: number;
        gain?: number;
    }

    export interface SlowModeSettings {
        speed?: number;
        pitch?: number;
        rate?: number;
    }

    export interface NightcoreSettings {
        speed?: number;
        pitch?: number;
        rate?: number;
    }

    export interface VaporwaveSettings {
        speed?: number;
        pitch?: number;
        rate?: number;
    }

    export interface EightDSettings {
        rotationHz?: number;
    }

    // Search and Autocomplete Interfaces
    export interface SearchSuggestion {
        text: string;
        highlighted: string;
        type: SuggestionType;
        source: SearchSource;
        thumbnail?: string;
        duration?: number;
        author?: string;
    }

    export interface AutocompleteResult {
        query: string;
        suggestions: SearchSuggestion[];
        hasMore: boolean;
        timestamp: number;
        source: SearchSource;
        total?: number;
    }

    // Voice Update Interfaces
    export interface VoiceStateUpdate {
        d: {
            guild_id: string;
            channel_id: string | null;
            user_id: string;
            session_id: string;
            deaf: boolean;
            mute: boolean;
            self_deaf: boolean;
            self_mute: boolean;
            suppress: boolean;
            request_to_speak_timestamp: string | null;
        };
        t: 'VOICE_STATE_UPDATE';
    }

    export interface VoiceServerUpdate {
        d: {
            token: string;
            guild_id: string;
            endpoint: string | null;
        };
        t: 'VOICE_SERVER_UPDATE';
    }

    // Event Payload Interfaces
    export interface TrackEndPayload {
        reason: TrackEndReason;
        track: string;
    }

    export interface TrackErrorPayload {
        exception: {
            message: string;
            severity: string;
            cause: string;
        };
        track: string;
    }

    export interface TrackStuckPayload {
        thresholdMs: number;
        track: string;
    }

    export interface SocketClosedPayload {
        code: number;
        reason: string;
        byRemote: boolean;
        guildId: string;
    }

    export interface LyricsLinePayload {
        line: string;
        timestamp: number;
    }

    export interface LyricsFoundPayload {
        lyrics: string;
        source?: string;
    }

    export interface LyricsNotFoundPayload {
        message: string;
    }

    // Utility Interfaces
    export interface LyricsOptions {
        query?: string;
        useCurrentTrack?: boolean;
        skipTrackSource?: boolean;
    }

    export interface LyricsResponse {
        text?: string;
        source?: string;
        lines?: Array<{
            line: string;
            timestamp?: number;
        }>;
    }

    export interface AutoplaySeed {
        trackId: string;
        artistIds: string;
    }

    export interface BrokenPlayerState {
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        volume: number;
        paused: boolean;
        position: number;
        current: Track | null;
        queue: Track[];
        originalNodeId: string;
        brokenAt: number;
        deaf: boolean;
    }

    export interface NodeState {
        connected: boolean;
        failoverInProgress: boolean;
    }

    export interface UpdatePlayerOptions {
        guildId: string;
        data: {
            track?: { encoded: string | null };
            position?: number;
            volume?: number;
            paused?: boolean;
            filters?: any;
            voice?: any;
        };
    }

    export interface PlayerInfo {
        guildId: string;
        track?: {
            encoded: string;
            info: TrackInfo;
        };
        volume: number;
        paused: boolean;
        voice: {
            token: string;
            endpoint: string;
            sessionId: string;
        };
        filters: any;
    }

    export interface GetLyricsOptions {
        track: {
            info: TrackInfo;
            encoded?: string;
            identifier?: string;
            guild_id?: string;
        };
        skipTrackSource?: boolean;
    }

    export interface RoutePlannerStatus {
        class: string;
        details: any;
    }

    export interface RoutePlannerAddress {
        address: string;
        failingTimestamp: number;
        failingTime: string;
    }

    // Type Unions and Enums
    export type SearchSource =
        | 'ytsearch'
        | 'ytmsearch'
        | 'scsearch'
        | 'spsearch'
        | 'amsearch'
        | 'dzsearch'
        | 'yandexsearch'
        | 'soundcloud'
        | 'youtube'
        | 'spotify'
        | 'applemusic'
        | 'deezer'
        | 'bandcamp'
        | 'vimeo'
        | 'twitch'
        | 'http';

    export type LoopMode = 0 | 1 | 2;
    export type LoopModeName = 'none' | 'track' | 'queue';

    export type LoadType =
        | 'track'
        | 'playlist'
        | 'search'
        | 'empty'
        | 'error'
        | 'TRACK_LOADED'
        | 'PLAYLIST_LOADED'
        | 'SEARCH_RESULT'
        | 'NO_MATCHES'
        | 'LOAD_FAILED';

    export type RestVersion = 'v3' | 'v4';

    export type SuggestionType =
        | 'track'
        | 'artist'
        | 'album'
        | 'playlist'
        | 'query';

    export type ExceptionSeverity =
        | 'common'
        | 'suspicious'
        | 'fault';

    export type TrackEndReason =
        | 'finished'
        | 'loadFailed'
        | 'stopped'
        | 'replaced'
        | 'cleanup'
        | 'FINISHED'
        | 'LOAD_FAILED'
        | 'STOPPED'
        | 'REPLACED'
        | 'CLEANUP';

    export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

    // Enhanced Event Interfaces with Strong Typing
    export interface AquaEvents {
        'nodeConnect': (node: Node) => void;
        'nodeDisconnect': (node: Node, code: number, reason: string) => void;
        'nodeError': (node: Node, error: Error) => void;
        'nodeReconnect': (node: Node) => void;
        'nodeCreate': (node: Node) => void;
        'nodeDestroy': (node: Node) => void;
        'nodeFailover': (node: Node) => void;
        'nodeFailoverComplete': (node: Node, successful: number, failed: number) => void;
        'playerCreate': (player: Player) => void;
        'playerDestroy': (player: Player) => void;
        'playerUpdate': (player: Player, packet: any) => void;
        'playerMigrated': (oldPlayer: Player, newPlayer: Player, targetNode: Node) => void;
        'playerReconnected': (player: Player, data: any) => void;
        'trackStart': (player: Player, track: Track) => void;
        'trackEnd': (player: Player, track: Track, reason?: TrackEndReason) => void;
        'trackError': (player: Player, track: Track, error: any) => void;
        'trackStuck': (player: Player, track: Track, thresholdMs: number) => void;
        'queueEnd': (player: Player) => void;
        'playerMove': (player: Player, oldChannel: string, newChannel: string) => void;
        'playerDisconnect': (player: Player, oldChannel: string) => void;
        'failover': (player: Player, oldNode: Node, newNode: Node) => void;
        'failoverFailed': (player: Player, error: Error) => void;
        'playersRebuilt': (node: Node, count: number) => void;
        'reconnectionFailed': (player: Player, data: any) => void;
        'socketClosed': (player: Player, payload: any) => void;
        'lyricsLine': (player: Player, track: Track, payload: LyricsLinePayload) => void;
        'lyricsFound': (player: Player, track: Track, payload: LyricsFoundPayload) => void;
        'lyricsNotFound': (player: Player, track: Track, payload: LyricsNotFoundPayload) => void;
        'debug': (source: string, message: string) => void;
        'error': (error: Error) => void;
    }

    export interface PlayerEvents {
        'trackStart': (track: Track) => void;
        'trackEnd': (track: Track, reason?: TrackEndReason) => void;
        'trackError': (track: Track, error: any) => void;
        'trackStuck': (track: Track, thresholdMs: number) => void;
        'playerUpdate': (state: any) => void;
        'queueEnd': () => void;
        'socketClosed': (code: number, reason: string, byRemote: boolean) => void;
        'failover': (oldNode: Node, newNode: Node) => void;
        'failoverFailed': (error: Error) => void;
        'event': (payload: any) => void;
        'lyricsLine': (payload: LyricsLinePayload) => void;
        'lyricsFound': (payload: LyricsFoundPayload) => void;
        'lyricsNotFound': (payload: LyricsNotFoundPayload) => void;
    }

    // Constants
    export const DEFAULT_OPTIONS: Required<AquaOptions>;

    // Event Emitter Type Extensions
    interface Aqua {
        on<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        on(event: string | symbol, listener: (...args: any[]) => void): this;

        once<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        once(event: string | symbol, listener: (...args: any[]) => void): this;

        emit<K extends keyof AquaEvents>(event: K, ...args: Parameters<AquaEvents[K]>): boolean;
        emit(event: string | symbol, ...args: any[]): boolean;

        off<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        off(event: string | symbol, listener: (...args: any[]) => void): this;

        removeListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        removeListener(event: string | symbol, listener: (...args: any[]) => void): this;

        addListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        addListener(event: string | symbol, listener: (...args: any[]) => void): this;

        removeAllListeners<K extends keyof AquaEvents>(event?: K): this;
        removeAllListeners(event?: string | symbol): this;

        setMaxListeners(n: number): this;
        getMaxListeners(): number;
        listeners<K extends keyof AquaEvents>(event: K): AquaEvents[K][];
        listeners(event: string | symbol): ((...args: any[]) => void)[];

        rawListeners<K extends keyof AquaEvents>(event: K): AquaEvents[K][];
        rawListeners(event: string | symbol): ((...args: any[]) => void)[];

        listenerCount<K extends keyof AquaEvents>(event: K): number;
        listenerCount(event: string | symbol): number;

        prependListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        prependListener(event: string | symbol, listener: (...args: any[]) => void): this;

        prependOnceListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this;
    }

    interface Player {
        on<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        on(event: string | symbol, listener: (...args: any[]) => void): this;

        once<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        once(event: string | symbol, listener: (...args: any[]) => void): this;

        emit<K extends keyof PlayerEvents>(event: K, ...args: Parameters<PlayerEvents[K]>): boolean;
        emit(event: string | symbol, ...args: any[]): boolean;

        off<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        off(event: string | symbol, listener: (...args: any[]) => void): this;

        removeListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        removeListener(event: string | symbol, listener: (...args: any[]) => void): this;

        addListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        addListener(event: string | symbol, listener: (...args: any[]) => void): this;

        removeAllListeners<K extends keyof PlayerEvents>(event?: K): this;
        removeAllListeners(event?: string | symbol): this;

        setMaxListeners(n: number): this;
        getMaxListeners(): number;
        listeners<K extends keyof PlayerEvents>(event: K): PlayerEvents[K][];
        listeners(event: string | symbol): ((...args: any[]) => void)[];

        rawListeners<K extends keyof PlayerEvents>(event: K): PlayerEvents[K][];
        rawListeners(event: string | symbol): ((...args: any[]) => void)[];

        listenerCount<K extends keyof PlayerEvents>(event: K): number;
        listenerCount(event: string | symbol): number;

        prependListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        prependListener(event: string | symbol, listener: (...args: any[]) => void): this;

        prependOnceListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this;
    }

    // Advanced Type Utilities for Better IntelliSense
    export type DeepPartial<T> = {
        [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
    };

    export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

    export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

    // Method Chaining Types for Fluent API
    export type FluentPlayer = {
        [K in keyof Player]: Player[K] extends (...args: any[]) => Player
            ? (...args: Parameters<Player[K]>) => FluentPlayer
            : Player[K];
    };

    export type FluentFilters = {
        [K in keyof Filters]: Filters[K] extends (...args: any[]) => Filters
            ? (...args: Parameters<Filters[K]>) => FluentFilters
            : Filters[K];
    };

    export type FluentQueue = {
        [K in keyof Queue]: Queue[K] extends (...args: any[]) => Queue
            ? (...args: Parameters<Queue[K]>) => FluentQueue
            : Queue[K];
    };

    // Search Source Validation
    export type ValidSearchSource<T extends string> = T extends SearchSource ? T : never;

    // Volume Range Type (0-200)
    export type VolumeLevel = number & { readonly __volumeBrand: unique symbol };

    // Position Type (milliseconds)
    export type Position = number & { readonly __positionBrand: unique symbol };

    // Duration Type (milliseconds)
    export type Duration = number & { readonly __durationBrand: unique symbol };

    // Guild ID Type
    export type GuildId = string & { readonly __guildBrand: unique symbol };

    // Channel ID Type
    export type ChannelId = string & { readonly __channelBrand: unique symbol };

    // Track Identifier Type
    export type TrackIdentifier = string & { readonly __trackBrand: unique symbol };

    // Advanced Search Options
    export interface AdvancedSearchOptions {
        query: string;
        source?: SearchSource;
        requester: any;
        limit?: number;
        offset?: number;
        sortBy?: 'relevance' | 'upload_date' | 'view_count' | 'rating';
        filters?: {
            duration?: {
                min?: number;
                max?: number;
            };
            upload_date?: {
                after?: string;
                before?: string;
            };
            features?: string[];
        };
        region?: string;
        language?: string;
    }

    // Playlist Creation Options
    export interface PlaylistOptions {
        name: string;
        tracks: Track[];
        author?: string;
        description?: string;
        thumbnail?: string;
        isPublic?: boolean;
        shuffle?: boolean;
    }

    // Advanced Player Statistics
    export interface PlayerStatistics {
        totalPlayTime: number;
        tracksPlayed: number;
        skipsCount: number;
        loopsCount: number;
        volumeChanges: number;
        seekOperations: number;
        errorCount: number;
        reconnectCount: number;
        averageTrackDuration: number;
        mostPlayedSource: SearchSource;
        sessionStartTime: number;
        lastActivityTime: number;
    }

    // Node Performance Metrics
    export interface NodePerformanceMetrics extends NodeStats {
        responseTime: number;
        successRate: number;
        errorRate: number;
        requestCount: number;
        bytesSent: number;
        bytesReceived: number;
        connectionsCount: number;
        averageLoadTime: number;
        healthScore: number;
    }

    // Advanced Error Types
    export interface AqualinkError extends Error {
        code: string;
        status?: number;
        retryable: boolean;
        timestamp: number;
        context?: Record<string, any>;
    }

    export interface TrackResolveError extends AqualinkError {
        query: string;
        source: SearchSource;
        attempts: number;
    }

    export interface NodeConnectionError extends AqualinkError {
        nodeId: string;
        host: string;
        port: number;
        lastConnected?: number;
    }

    export interface PlayerStateError extends AqualinkError {
        guildId: string;
        playerState: 'destroyed' | 'disconnected' | 'stuck' | 'failed';
        recoverable: boolean;
    }

    // Quality of Service Types
    export interface QoSOptions {
        maxRetries?: number;
        retryDelay?: number;
        timeout?: number;
        priority?: 'low' | 'normal' | 'high' | 'critical';
        fallbackNodes?: string[];
        healthCheckInterval?: number;
        performanceThreshold?: number;
    }

    // Cache Management
    export interface CacheOptions {
        ttl?: number;
        maxSize?: number;
        strategy?: 'lru' | 'lfu' | 'fifo';
        persistent?: boolean;
        compression?: boolean;
    }

    // Advanced Logging
    export interface LoggingOptions {
        level?: 'debug' | 'info' | 'warn' | 'error';
        format?: 'json' | 'text';
        destination?: 'console' | 'file' | 'both';
        filePath?: string;
        maxFileSize?: number;
        rotateFiles?: boolean;
        includeStackTrace?: boolean;
    }

    // Monitoring and Telemetry
    export interface TelemetryData {
        timestamp: number;
        nodeId: string;
        playerId?: string;
        event: string;
        data: Record<string, any>;
        duration?: number;
        success: boolean;
        error?: string;
    }

    export interface MetricsCollector {
        recordEvent(event: string, data?: Record<string, any>): void;
        recordTiming(operation: string, duration: number): void;
        recordCounter(metric: string, value?: number): void;
        recordGauge(metric: string, value: number): void;
        getMetrics(): Record<string, any>;
        resetMetrics(): void;
    }

    // Plugin System Extensions
    export interface AdvancedPlugin extends Plugin {
        version: string;
        description?: string;
        author?: string;
        dependencies?: string[];
        config?: Record<string, any>;

        init?(aqua: Aqua): Promise<void>;
        destroy?(aqua: Aqua): Promise<void>;
        onPlayerCreate?(player: Player): void;
        onPlayerDestroy?(player: Player): void;
        onTrackStart?(player: Player, track: Track): void;
        onTrackEnd?(player: Player, track: Track): void;
        onNodeConnect?(node: Node): void;
        onNodeDisconnect?(node: Node): void;
    }

    // Middleware System
    export interface Middleware {
        name: string;
        priority?: number;

        beforeResolve?(options: ResolveOptions): ResolveOptions | Promise<ResolveOptions>;
        afterResolve?(response: ResolveResponse): ResolveResponse | Promise<ResolveResponse>;
        beforePlay?(player: Player, track: Track): boolean | Promise<boolean>;
        afterPlay?(player: Player, track: Track): void | Promise<void>;
        onError?(error: Error, context: any): boolean | Promise<boolean>;
    }

    // Export additional utilities
    export function createPlugin(name: string, implementation: Partial<AdvancedPlugin>): AdvancedPlugin;
    export function createMiddleware(name: string, implementation: Partial<Middleware>): Middleware;
    export function validateSearchSource(source: string): source is SearchSource;
    export function validateVolume(volume: number): volume is VolumeLevel;
    export function formatDuration(ms: number): string;
    export function parseQuery(query: string): { source?: SearchSource; cleanQuery: string };

    // Version information
    export const version: string;
    export const supportedLavalinkVersions: string[];
    export const supportedNodeVersions: string[];

    // Global configuration
    export interface GlobalConfig {
        defaultTimeout: number;
        maxConcurrentConnections: number;
        defaultRetryAttempts: number;
        cacheOptions: CacheOptions;
        loggingOptions: LoggingOptions;
        qosOptions: QoSOptions;
        telemetryEnabled: boolean;
    }

    export function setGlobalConfig(config: Partial<GlobalConfig>): void;
    export function getGlobalConfig(): GlobalConfig;
    export function resetGlobalConfig(): void;

    // Health Check Utilities
    export function checkNodeHealth(node: Node): Promise<NodeHealth>;
    export function checkAllNodesHealth(aqua: Aqua): Promise<Map<string, NodeHealth>>;
    export function getRecommendedNode(aqua: Aqua, criteria?: {
        region?: string;
        maxLoad?: number;
        minUptime?: number;
    }): Node | null;

    // Debugging Utilities
    export function enableDebugMode(enabled?: boolean): void;
    export function getDebugInfo(aqua: Aqua): {
        nodes: Array<{
            id: string;
            connected: boolean;
            stats: NodeStats;
            health: NodeHealth;
        }>;
        players: Array<{
            guildId: string;
            playing: boolean;
            current: Track | null;
            queueSize: number;
        }>;
        system: {
            memory: NodeJS.MemoryUsage;
            uptime: number;
            version: string;
        };
    };

    // Type Guards
    export function isTrack(obj: any): obj is Track;
    export function isPlayer(obj: any): obj is Player;
    export function isNode(obj: any): obj is Node;
    export function isPlaylist(response: ResolveResponse): response is ResolveResponse & { playlistInfo: PlaylistInfo };
    export function isError(response: ResolveResponse): response is ResolveResponse & { exception: LavalinkException };

    // Advanced Type Definitions for Library Extensions
    export namespace Extensions {
        export interface DatabaseIntegration {
            savePlaylist(playlist: PlaylistOptions): Promise<string>;
            loadPlaylist(id: string): Promise<Track[]>;
            savePlayerState(player: Player): Promise<void>;
            loadPlayerState(guildId: string): Promise<Partial<PlayerOptions>>;
            getUserHistory(userId: string): Promise<Track[]>;
            getPopularTracks(limit?: number): Promise<Track[]>;
        }

        export interface WebhookIntegration {
            registerWebhook(url: string, events: (keyof AquaEvents)[]): string;
            unregisterWebhook(id: string): boolean;
            testWebhook(id: string): Promise<boolean>;
        }

        export interface AnalyticsIntegration {
            trackEvent(event: string, properties: Record<string, any>): void;
            trackUser(userId: string, properties: Record<string, any>): void;
            getAnalytics(timeRange: { start: Date; end: Date }): Promise<Record<string, any>>;
        }
    }
}
