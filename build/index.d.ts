declare module "aqualink" {
    import { EventEmitter } from "events";

    /**
     * Main Aqua client for managing audio nodes and players
     * @extends EventEmitter
     */
    export class Aqua extends EventEmitter {
        /**
         * Creates a new Aqua instance
         * @param client The Discord client instance
         * @param nodes Array of node configurations
         * @param options Optional Aqua configuration
         */
        constructor(client: any, nodes: NodeConfig[], options?: AquaOptions);

        /**
         * Initializes the Aqua instance with the client ID
         * @param clientId The Discord client ID
         * @returns This Aqua instance
         */
        init(clientId: string): this;

        /**
         * Creates a new Node instance
         * @param options Node configuration
         * @returns The created Node
         */
        createNode(options: NodeConfig): Node;

        /**
         * Creates a new Player instance
         * @param node Node to create the player on
         * @param options Player configuration
         * @returns The created Player
         */
        createPlayer(node: Node, options: PlayerOptions): Player;

        /**
         * Destroys a player by guild ID
         * @param guildId The guild ID
         */
        destroyPlayer(guildId: string): Promise<void>;

        /**
         * Resolves a track query
         * @param options Track resolve options
         * @returns Track resolution response
         */
        resolve(options: ResolveOptions): Promise<ResolveResponse>;

        /**
         * Updates voice state based on Discord voice state update
         * @param data Voice state update data
         */
        updateVoiceState(data: VoiceStateUpdate): void;

        /**
         * Gets an option with a default fallback
         * @param options Options object
         * @param key Key to retrieve
         * @param defaultValue Default value if key doesn't exist
         * @returns The option value or default
         */
        getOption<T>(options: Record<string, any>, key: string, defaultValue: T): T;

        /**
         * Default function for sending voice updates to Discord
         * @param payload Voice payload
         */
        defaultSendFunction(payload: any): void;

        /**
         * Validates client and nodes input
         * @param client Discord client
         * @param nodes Array of node configurations
         */
        validateInputs(client: any, nodes: NodeConfig[]): void;

        /**
         * Gets nodes sorted by least load
         */
        get leastUsedNodes(): Node[];

        /**
         * Fetches nodes by region
         * @param region Region to filter by
         * @returns Nodes in the specified region
         */
        fetchRegion(region: string): Node[];

        /**
         * Calculates load on a node
         * @param node Node to calculate load for
         * @returns Load metric
         */
        calculateLoad(node: Node): number;

        /**
         * Creates a player connection
         * @param options Player options
         * @returns The created Player
         */
        createConnection(options: PlayerOptions): Player;

        /**
         * Gets a node for making requests
         * @param nodes Optional node specification
         * @returns Selected node
         */
        getRequestNode(nodes?: string | Node): Node;

        /**
         * Ensures the Aqua instance is initialized
         * @throws If not initialized
         */
        ensureInitialized(): void;

        /**
         * Formats a query for a specific source
         * @param query Search query
         * @param source Source platform
         * @returns Formatted query string
         */
        formatQuery(query: string, source: string): string;

        /**
         * Handles when no matches are found for a query
         * @param rest Rest instance
         * @param query Search query
         * @returns Resolve response
         */
        handleNoMatches(rest: Rest, query: string): Promise<ResolveResponse>;

        /**
         * Constructs a response for track resolution
         * @param response Raw response
         * @param requester Requester
         * @param requestNode Node used for the request
         * @returns Formatted resolve response
         */
        constructorResponse(response: any, requester: any, requestNode: Node): ResolveResponse;

        /**
         * Gets a player by guild ID
         * @param guildId Guild ID
         * @returns Player instance or undefined
         */
        get(guildId: string): Player | undefined;

        /**
         * Cleans up a player
         * @param player Player to clean up
         */
        cleanupPlayer(player: Player): void;

        /** Discord client instance */
        client: any;
        
        /** Array of node configurations */
        nodes: NodeConfig[];
        
        /** Map of node names to Node instances */
        nodeMap: Map<string, Node>;
        
        /** Map of guild IDs to Player instances */
        players: Map<string, Player>;
        
        /** Discord client ID */
        clientId: string | null;
        
        /** Whether the client has been initialized */
        initiated: boolean;
        
        /** Aqua options */
        options: AquaOptions;
        
        /** Whether to delete nowplaying messages */
        shouldDeleteMessage: boolean;
        
        /** Default platform for searching */
        defaultSearchPlatform: string;
        
        /** Whether to leave voice channel when queue ends */
        leaveOnEnd: boolean;
        
        /** REST API version to use */
        restVersion: string;
        
        /** Loaded plugins */
        plugins: Plugin[];
        
        /** Aqualink version */
        version: string;
        
        /** Function for sending voice updates to Discord */
        send: (payload: any) => void;
        
        /** Whether to auto-resume sessions */
        autoResume: boolean;
        
        /** Whether to reconnect indefinitely */
        infiniteReconnects: boolean;
        
        /** Cache for least used nodes */
        _leastUsedCache: { nodes: Node[], timestamp: number };
    }

    /**
     * Aqua client configuration options
     */
    export interface AquaOptions {
        /** Function for sending voice updates to Discord */
        send?: (payload: any) => void;
        
        /** Default platform for searching */
        defaultSearchPlatform?: string;
        
        /** REST API version to use */
        restVersion?: string;
        
        /** Plugins to load */
        plugins?: Plugin[];
        
        /** Whether to auto-resume sessions */
        autoResume?: boolean;
        
        /** Whether to reconnect indefinitely */
        infiniteReconnects?: boolean;
        
        /** Whether to delete nowplaying messages */
        shouldDeleteMessage?: boolean;
        
        /** Whether to leave voice channel when queue ends */
        leaveOnEnd?: boolean;
    }

    /**
     * Configuration for a Lavalink node
     */
    export interface NodeConfig {
        /** Node name for identification */
        name?: string;
        
        /** Node hostname */
        host: string;
        
        /** Node port */
        port: number;
        
        /** Node password */
        password: string;
        
        /** Whether to use secure connection */
        secure?: boolean;
        
        /** Session ID for resuming */
        sessionId?: string;
        
        /** Regions this node handles */
        regions?: string[];
    }

    /**
     * Configuration for a player
     */
    export interface PlayerOptions {
        /** Guild ID */
        guildId: string;
        
        /** Text channel ID */
        textChannel?: string;
        
        /** Voice channel ID */
        voiceChannel?: string;
        
        /** Default volume (0-1000) */
        defaultVolume?: number;
        
        /** Loop mode */
        loop?: string;
        
        /** Whether to delete nowplaying messages */
        shouldDeleteMessage?: boolean;
        
        /** Whether to leave voice channel when queue ends */
        leaveOnEnd?: boolean;
        
        /** Voice region */
        region?: string;
    }

    /**
     * Options for resolving a track
     */
    export interface ResolveOptions {
        /** Search query */
        query: string;
        
        /** Source platform */
        source?: string;
        
        /** Requester data */
        requester?: any;
        
        /** Specific node(s) to use */
        nodes?: string | Node;
    }

    /**
     * Response from a track resolution
     */
    export interface ResolveResponse {
        /** Type of load (TRACK_LOADED, SEARCH_RESULT, etc.) */
        loadType: string;
        
        /** Exception details if any */
        exception: any;
        
        /** Playlist information if result is a playlist */
        playlistInfo: any;
        
        /** Plugin-specific information */
        pluginInfo: any;
        
        /** Resolved tracks */
        tracks: Track[];
    }

    /**
     * Discord voice state update data
     */
    export interface VoiceStateUpdate {
        /** Update data */
        d: any;
        
        /** Update type */
        t: string;
    }

    /**
     * Manages voice connection for a player
     */
    export class Connection {
        /**
         * Creates a new Connection
         * @param player Player instance
         */
        constructor(player: Player);

        /**
         * Sets server update data
         * @param data Server update data
         */
        setServerUpdate(data: { endpoint: string, token: string }): void;

        /**
         * Sets state update data
         * @param data State update data
         */
        setStateUpdate(data: { channel_id: string, session_id: string, self_deaf: boolean, self_mute: boolean }): void;

        /**
         * Updates player voice data
         */
        _updatePlayerVoiceData(): Promise<void>;

        /** Weak reference to player */
        playerRef: WeakRef<Player>;
        
        /** Voice connection data */
        voice: { sessionId: string | null, endpoint: string | null, token: string | null };
        
        /** Voice region */
        region: string | null;
        
        /** Whether the bot is self-deafened */
        selfDeaf: boolean;
        
        /** Whether the bot is self-muted */
        selfMute: boolean;
        
        /** Voice channel ID */
        voiceChannel: string;
        
        /** Guild ID */
        guildId: string;
        
        /** Aqua instance */
        aqua: Aqua;
        
        /** Available nodes */
        nodes: any;
    }

    /**
     * Manages audio filters for a player
     */
    export class Filters {
        /**
         * Creates a new Filters instance
         * @param player Player instance
         * @param options Filter options
         */
        constructor(player: Player, options?: FiltersOptions);

        /**
         * Sets equalizer bands
         * @param bands Array of frequency bands
         */
        setEqualizer(bands: Array<any>): Promise<void>;

        /**
         * Toggles karaoke filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setKaraoke(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles timescale filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setTimescale(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles tremolo filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setTremolo(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles vibrato filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setVibrato(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles rotation filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setRotation(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles distortion filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setDistortion(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles channel mix filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setChannelMix(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles low pass filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setLowPass(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles bass boost filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setBassboost(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles slow mode filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setSlowmode(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles nightcore filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setNightcore(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles vaporwave filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        setVaporwave(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Toggles 8D filter
         * @param enabled Whether to enable the filter
         * @param options Filter options
         */
        set8D(enabled: boolean, options?: FiltersOptions): Promise<void>;

        /**
         * Clears all active filters
         */
        clearFilters(): Promise<void>;

        /**
         * Updates all filters
         */
        updateFilters(): Promise<void>;

        /** Player instance */
        player: Player;
        
        /** Current volume */
        volume: number;
        
        /** Equalizer bands */
        equalizer: any[];
        
        /** Karaoke filter settings */
        karaoke: any;
        
        /** Timescale filter settings */
        timescale: any;
        
        /** Tremolo filter settings */
        tremolo: any;
        
        /** Vibrato filter settings */
        vibrato: any;
        
        /** Rotation filter settings */
        rotation: any;
        
        /** Distortion filter settings */
        distortion: any;
        
        /** Channel mix filter settings */
        channelMix: any;
        
        /** Low pass filter settings */
        lowPass: any;
        
        /** Bass boost filter settings */
        bassboost: any;
        
        /** Slow mode filter settings */
        slowmode: any;
        
        /** Nightcore filter settings */
        nightcore: any;
        
        /** Vaporwave filter settings */
        vaporwave: any;
        
        /** 8D filter settings */
        _8d: any;
    }

    /**
     * Options for audio filters
     */
    export interface FiltersOptions {
        /** Volume level */
        volume?: number;
        
        /** Equalizer bands */
        equalizer?: any[];
        
        /** Karaoke filter settings */
        karaoke?: any;
        
        /** Timescale filter settings */
        timescale?: any;
        
        /** Tremolo filter settings */
        tremolo?: any;
        
        /** Vibrato filter settings */
        vibrato?: any;
        
        /** Rotation filter settings */
        rotation?: any;
        
        /** Distortion filter settings */
        distortion?: any;
        
        /** Channel mix filter settings */
        channelMix?: any;
        
        /** Low pass filter settings */
        lowPass?: any;
        
        /** Bass boost filter settings */
        bassboost?: any;
        
        /** Slow mode filter settings */
        slowmode?: any;
        
        /** Nightcore filter settings */
        nightcore?: any;
        
        /** Vaporwave filter settings */
        vaporwave?: any;
        
        /** 8D filter settings */
        _8d?: any;
    }

    /**
     * Represents a Lavalink node
     */
    export class Node {
        /**
         * Creates a new Node instance
         * @param aqua Aqua instance
         * @param connOptions Node connection options
         * @param options Node behavior options
         */
        constructor(aqua: Aqua, connOptions: NodeConfig, options?: NodeOptions);

        /**
         * Connects to the Lavalink node
         */
        connect(): Promise<void>;

        /**
         * Gets node statistics
         */
        getStats(): Promise<any>;

        /**
         * Destroys the node connection
         * @param clean Whether to clean up gracefully
         */
        destroy(clean?: boolean): void;

        /** Aqua instance */
        aqua: Aqua;
        
        /** Node name */
        name: string;
        
        /** Node host */
        host: string;
        
        /** Node port */
        port: number;
        
        /** Node password */
        password: string;
        
        /** Whether to use secure connection */
        secure: boolean;
        
        /** Session ID for resuming */
        sessionId: string | null;
        
        /** Regions this node handles */
        regions: string[];
        
        /** WebSocket URL */
        wsUrl: URL;
        
        /** REST interface */
        rest: Rest;
        
        /** Resume timeout in seconds */
        resumeTimeout: number;
        
        /** Whether to auto-resume */
        autoResume: boolean;
        
        /** Reconnection timeout in ms */
        reconnectTimeout: number;
        
        /** Max reconnection attempts */
        reconnectTries: number;
        
        /** Whether to reconnect indefinitely */
        infiniteReconnects: boolean;
        
        /** Whether connected to the node */
        connected: boolean;
        
        /** Node information */
        info: any;
        
        /** Default statistics */
        defaultStats: any;
        
        /** Current statistics */
        stats: any;
    }

    /**
     * Node behavior options
     */
    export interface NodeOptions {
        /** Resume timeout in seconds */
        resumeTimeout?: number;
        
        /** Whether to auto-resume */
        autoResume?: boolean;
        
        /** Reconnection timeout in ms */
        reconnectTimeout?: number;
        
        /** Max reconnection attempts */
        reconnectTries?: number;
        
        /** Whether to reconnect indefinitely */
        infiniteReconnects?: boolean;
    }

    /**
     * Audio player for a guild
     * @extends EventEmitter
     */
    export class Player extends EventEmitter {
        /**
         * Creates a new Player instance
         * @param aqua Aqua instance
         * @param nodes Available nodes
         * @param options Player options
         */
        constructor(aqua: Aqua, nodes: any, options?: PlayerOptions);

        /**
         * Starts playback of the current track
         */
        play(): Promise<void>;

        /**
         * Toggles pause state
         * @param paused Whether to pause
         * @returns This player instance
         */
        pause(paused: boolean): this;

        /**
         * Skips the current track
         */
        skip(): Promise<void>;

        /**
         * Destroys the player
         */
        destroy(): void;

        /**
         * Connects to a voice channel
         * @param options Connection options
         * @returns This player instance
         */
        connect(options: PlayerOptions): this;

        /**
         * Disconnects from voice channel
         * @returns This player instance
         */
        disconnect(): this;

        /**
         * Sets player volume
         * @param volume Volume level (0-1000)
         * @returns This player instance
         */
        setVolume(volume: number): this;

        /**
         * Sets loop mode
         * @param mode Loop mode ("none", "track", "queue")
         * @returns This player instance
         */
        setLoop(mode: string): this;

        /**
         * Sets text channel
         * @param channel Text channel ID
         * @returns This player instance
         */
        setTextChannel(channel: string): this;

        /**
         * Sets voice channel
         * @param channel Voice channel ID
         * @returns This player instance
         */
        setVoiceChannel(channel: string): this;

        /**
         * Shuffles the queue
         * @returns This player instance
         */
        shuffle(): this;

        /**
         * Replays current track
         * @returns This player instance
         */
        replay(): this;

        /**
         * Stops playback
         * @returns This player instance
         */
        stop(): this;

        /**
         * Seeks to position
         * @param position Position in milliseconds
         * @returns This player instance
         */
        seek(position: number): this;

        /**
         * Searches for lyrics
         * @param query Search query
         * @returns Lyrics search result
         */
        searchLyrics(query: string): Promise<any>;

        /**
         * Gets lyrics for current track
         * @returns Lyrics result
         */
        lyrics(): Promise<any>;

        /**
         * Adds track to previous tracks
         * @param track Track to add
         */
        addToPreviousTrack(track: Track): void;

        /**
         * Updates player state
         * @param data Update data
         */
        updatePlayer(data: any): Promise<void>;

        /**
         * Cleans up player resources
         */
        cleanup(): Promise<void>;

        /**
         * Updates track state
         * @param playing Whether playing
         * @param paused Whether paused
         */
        updateTrackState(playing: boolean, paused: boolean): void;

        /**
         * Handles an event from node
         * @param payload Event payload
         */
        handleEvent(payload: any): Promise<void>;

        /**
         * Handles unknown event
         * @param payload Event payload
         */
        handleUnknownEvent(payload: any): void;

        /**
         * Handles track start event
         * @param player Player instance
         * @param track Current track
         */
        trackStart(player: Player, track: Track): Promise<void>;

        /**
         * Handles track end event
         * @param player Player instance
         * @param track Ended track
         * @param payload Event payload
         */
        trackEnd(player: Player, track: Track, payload: any): Promise<void>;

        /**
         * Handles track error event
         * @param player Player instance
         * @param track Errored track
         * @param payload Event payload
         */
        trackError(player: Player, track: Track, payload: any): Promise<void>;

        /**
         * Handles track stuck event
         * @param player Player instance
         * @param track Stuck track
         * @param payload Event payload
         */
        trackStuck(player: Player, track: Track, payload: any): Promise<void>;

        /**
         * Handles socket closed event
         * @param player Player instance
         * @param payload Event payload
         */
        socketClosed(player: Player, payload: any): Promise<void>;

        /**
         * Sends data to node
         * @param data Data to send
         */
        send(data: any): void;

        /** Available loop modes */
        static LOOP_MODES: { NONE: string, TRACK: string, QUEUE: string };
        
        /** Event handler mapping */
        static EVENT_HANDLERS: { [key: string]: string };
        
        /** Valid loop modes */
        static validModes: Set<string>;

        /** Aqua instance */
        aqua: Aqua;
        
        /** Available nodes */
        nodes: any;
        
        /** Guild ID */
        guildId: string;
        
        /** Text channel ID */
        textChannel: string;
        
        /** Voice channel ID */
        voiceChannel: string;
        
        /** Voice connection */
        connection: Connection;
        
        /** Audio filters */
        filters: Filters;
        
        /** Volume level */
        volume: number;
        
        /** Loop mode */
        loop: string;
        
        /** Track queue */
        queue: Queue;
        
        /** Previously played tracks */
        previousTracks: Track[];
        
        /** Whether to delete nowplaying messages */
        shouldDeleteMessage: boolean;
        
        /** Whether to leave on queue end */
        leaveOnEnd: boolean;
        
        /** Whether currently playing */
        playing: boolean;
        
        /** Whether currently paused */
        paused: boolean;
        
        /** Whether connected to voice */
        connected: boolean;
        
        /** Current track */
        current: Track | null;
        
        /** Timestamp of last update */
        timestamp: number;
        
        /** Connection ping */
        ping: number;
        
        /** Now playing message */
        nowPlayingMessage: any;
        
        /** Player update handler */
        onPlayerUpdate: (state: any) => void;
    }

    /**
     * Plugin for extending Aqua functionality
     */
    export class Plugin {
        /**
         * Creates a new Plugin
         * @param name Plugin name
         */
        constructor(name: string);

        /**
         * Loads the plugin
         * @param aqua Aqua instance
         */
        load(aqua: Aqua): void;

        /**
         * Unloads the plugin
         * @param aqua Aqua instance
         */
        unload(aqua: Aqua): void;

        /** Plugin name */
        name: string;
    }

    /**
     * Track queue implementation
     * @extends Array
     */
    export class Queue extends Array<any> {
        /**
         * Creates a new Queue
         * @param elements Initial elements
         */
        constructor(...elements: any[]);

        /** Number of items in queue */
        size: number;
        
        /** First item in queue */
        first: any;
        
        /** Last item in queue */
        last: any;

        /**
         * Adds a track to the queue
         * @param track Track to add
         * @returns This queue instance
         */
        add(track: any): this;

        /**
         * Removes a track from the queue
         * @param track Track to remove
         */
        remove(track: any): void;

        /**
         * Clears the queue
         */
        clear(): void;

        /**
         * Shuffles the queue
         */
        shuffle(): void;

        /**
         * Gets the first item without removing
         * @returns First item
         */
        peek(): any;

        /**
         * Converts queue to array
         * @returns Array of items
         */
        toArray(): any[];

        /**
         * Gets item at index
         * @param index Index
         * @returns Item at index
         */
        at(index: number): any;

        /**
         * Removes and returns first item
         * @returns First item
         */
        dequeue(): any;

        /**
         * Checks if queue is empty
         * @returns Whether empty
         */
        isEmpty(): boolean;

        /**
         * Adds item to end of queue
         * @param track Item to add
         * @returns This queue instance
         */
        enqueue(track: any): this;
    }

    /**
     * REST API wrapper for Lavalink
     */
    export class Rest {
        /**
         * Creates a new Rest instance
         * @param aqua Aqua instance
         * @param options REST options
         */
        constructor(aqua: Aqua, options: RestOptions);

        /**
         * Makes an HTTP request
         * @param method HTTP method
         * @param endpoint API endpoint
         * @param body Request body
         * @returns Response data
         */
        makeRequest(method: string, endpoint: string, body?: any): Promise<any>;

        /**
         * Gets all players on the node
         */
        getPlayers(): Promise<any>;

        /**
         * Destroys a player on the node
         * @param guildId Guild ID
         */
        destroyPlayer(guildId: string): Promise<void>;

        /**
         * Gets tracks by identifier
         * @param identifier Track identifier
         */
        getTracks(identifier: string): Promise<any>;

        /**
         * Decodes a track
         * @param track Encoded track
         */
        decodeTrack(track: string): Promise<any>;

        /**
         * Decodes multiple tracks
         * @param tracks Encoded tracks
         */
        decodeTracks(tracks: any[]): Promise<any>;

        /**
         * Gets node statistics
         */
        getStats(): Promise<any>;

        /**
         * Gets node information
         */
        getInfo(): Promise<any>;

        /**
         * Gets route planner status
         */
        getRoutePlannerStatus(): Promise<any>;

        /**
         * Gets route planner address
         * @param address IP address
         */
        getRoutePlannerAddress(address: string): Promise<any>;

        /**
         * Gets lyrics for a track
         * @param options Lyrics options
         */
        getLyrics(options: { track: any }): Promise<any>;

        /**
         * Sets the session ID
         * @param sessionId Session ID
         */
        setSessionId(sessionId: string): void;

        /**
         * Builds an API endpoint path
         * @param segments Path segments
         */
        buildEndpoint(...segments: string[]): string;

        /**
         * Validates session ID exists
         * @throws If no session ID
         */
        validateSessionId(): void;

        /**
         * Updates player state
         * @param options Update options
         */
        updatePlayer(options: { guildId: string, data: any }): Promise<void>;

        /** Aqua instance */
        aqua: Aqua;
        
        /** Session ID */
        sessionId: string;
        
        /** API version */
        version: string;
        
        /** Base URL */
        baseUrl: string;
        
        /** Request headers */
        headers: Record<string, string>;
        
        /** HTTP client */
        client: any;
    }

    /**
     * REST API options
     */
    export interface RestOptions {
        /** Whether to use HTTPS */
        secure: boolean;
        
        /** Host address */
        host: string;
        
        /** Port number */
        port: number;
        
        /** Session ID */
        sessionId: string;
        
        /** Authentication password */
        password: string;
    }

    /**
     * Represents an audio track
     */
    export class Track {
        /**
         * Creates a new Track
         * @param data Track data
         * @param requester Requester
         * @param nodes Node
         */
        constructor(data: TrackData, requester: Player, nodes: Node);

        /**
         * Resolves a track
         * @param aqua Aqua instance
         * @returns Resolved track or null
         */
        resolve(aqua: Aqua): Promise<Track | null>;

        /**
         * Resolves track thumbnail
         * @param thumbnail Thumbnail URL
         * @returns Processed thumbnail URL or null
         */
        resolveThumbnail(thumbnail: string): string | null;

        /**
         * Finds matching track in collection
         * @param tracks Tracks to search
         * @returns Matching track or null
         */
        _findMatchingTrack(tracks: Track[]): Track | null;

        /** Track information */
        info: TrackInfo;
        
        /** Encoded track string */
        track: string | null;
        
        /** Playlist information if part of playlist */
        playlist: any;
        
        /** Track requester */
        requester: Player;
        
        /** Node for this track */
        nodes: Node;
    }

    /**
     * Track data structure
     */
    export interface TrackData {
        /** Track information */
        info?: TrackInfo;
        
        /** Encoded track string */
        encoded?: string;
        
        /** Playlist information */
        playlist?: any;
    }

    /**
     * Track information
     */
    export interface TrackInfo {
        /** Track identifier */
        identifier: string;
        
        /** Whether track is seekable */
        isSeekable: boolean;
        
        /** Track author/artist */
        author: string;
        
        /** Track length in ms */
        length: number;
        
        /** Whether track is a stream */
        isStream: boolean;
        
        /** Track title */
        title: string;

        /** Track URI */
        uri: string;

        /** Track thumbnail URL */
        thumbnail?: string;
    }
}
