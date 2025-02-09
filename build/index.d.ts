declare module "AquaLink" {
    export class Aqua {
    /**
     * @param {Object} client - The client instance.
     * @param {Array<Object>} nodes - An array of node configurations.
     * @param {Object} options - Configuration options for Aqua.
     * @param {Function} options.send - Function to send data.
     * @param {string} [options.defaultSearchPlatform="ytsearch"] - Default search platform.
     * @param {string} [options.restVersion="v4"] - Version of the REST API.
     * @param {Array<Object>} [options.plugins=[]] - Plugins to load.
     * @param {boolean} [options.autoResume=false] - Automatically resume tracks on reconnect.
     * @param {boolean} [options.infiniteReconnects=false] - Reconnect infinitely.
     */
        constructor(client: any, nodes: Array<any>, options?: { [key: string]: any });
        init(clientId: string): this;
        createNode(options: { [key: string]: any }): Node;
        createPlayer(node: Node, options: { [key: string]: any }): Player;
        destroyPlayer(guildId: string): Promise<void>;
        resolve(options: { query: string, source?: string, requester?: any, nodes?: any }): Promise<any>;
        updateVoiceState(data: { d: any, t: string }): void;
    }

    export class Connection {
        constructor(player: Player);
        setServerUpdate(data: { endpoint: string, token: string }): void;
        setStateUpdate(data: { channel_id: string, session_id: string, self_deaf: boolean, self_mute: boolean }): void;
    }

    export class Filters {
        constructor(player: Player, options?: { [key: string]: any });
        setEqualizer(bands: Array<any>): Promise<void>;
        setKaraoke(enabled: boolean, options?: { [key: string]: any }): Promise<void>;
        clearFilters(): Promise<void>;
    }

    export class Node {
        constructor(aqua: Aqua, connOptions: { [key: string]: any }, options?: { [key: string]: any });
        connect(): Promise<void>;
        getStats(): Promise<any>;
        destroy(clean?: boolean): void;
    }

    export class Player {
        constructor(aqua: Aqua, nodes: any, options?: { [key: string]: any });
        play(): Promise<void>;
        pause(paused: boolean): this;
        skip(): Promise<void>;
        destroy(): void;
    }

    export class Plugin {
        constructor(name: string);
        load(aqua: Aqua): void;
        unload(aqua: Aqua): void;
    }

    export class Queue extends Array {
        add(track: any): this;
        remove(track: any): void;
        clear(): void;
        shuffle(): void;
        peek(): any;
        toArray(): Array<any>;
        at(index: number): any;
        dequeue(): any;
        isEmpty(): boolean;
    }

    export class Rest {
        constructor(aqua: Aqua, options: { [key: string]: any });
        makeRequest(method: string, endpoint: string, body?: any): Promise<any>;
        getPlayers(): Promise<any>;
        destroyPlayer(guildId: string): Promise<void>;
    }

    export class Track {
        constructor(data: { [key: string]: any }, requester: Player, nodes: Node);
        resolve(aqua: Aqua): Promise<Track | null>;
    }
}