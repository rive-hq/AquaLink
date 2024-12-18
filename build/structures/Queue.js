/**
 * A data structure to manage a queue of tracks.
 */
class Queue extends Array {
    /**
     * @param {...*} elements - The elements to initialize the queue with.
     */
    constructor(...elements) {
        super(...elements);
    }

    /**
     * Get the size of the queue.
     * @returns {number} The size of the queue.
     */
    get size() {
        return this.length;
    }

    /**
     * Get the first element in the queue.
     * @returns {*} The first element in the queue or null if the queue is empty.
     */
    get first() {
        return this[0] || null;
    }

    /**
     * Get the last element in the queue.
     * @returns {*} The last element in the queue or null if the queue is empty.
     */
    get last() {
        return this[this.length - 1] || null;
    }

    /**
     * Add a track to the end of the queue.
     * @param {*} track - The track to add.
     * @returns {Queue} The queue.
     */
    add(track) {
        this.push(track);
        return this;
    }

    /**
     * Remove a specific track from the queue.
     * @param {*} track - The track to remove.
     * @returns {Queue} The queue.
     */
    remove(track) {
        const index = this.indexOf(track);
        if (index !== -1) {
            this.splice(index, 1);
        }
        return this;
    }

    /**
     * Clear all tracks from the queue.
     * @returns {Queue} The queue.
     */
    clear() {
        this.length = 0;
        return this;
    }

    /**
     * Shuffle the tracks in the queue.
     * @returns {Queue} The queue.
     */
    shuffle() {
        for (let i = this.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this[i], this[j]] = [this[j], this[i]];
        }
        return this;
    }

    /**
     * Peek at the element at the front of the queue without removing it.
     * @returns {*} The element at the front of the queue or null if the queue is empty.
     */
    peek() {
        return this.first;
    }

    /**
     * Get all tracks in the queue as an array.
     * @returns {Array} The array of tracks in the queue.
     */
    toArray() {
        return [...this];
    }

    /**
     * Get a track at a specific index.
     * @param {number} index - The index of the track to retrieve.
     * @returns {*} The track at the specified index or null if out of bounds.
     */
    at(index) {
        return this[index] || null;
    }

    /**
     * Remove the first track from the queue.
     * @returns {*} The first track in the queue or null if the queue is empty.
     */
    dequeue() {
        return this.shift();
    }

    /**
     * Check if the queue is empty.
     * @returns {boolean} Whether the queue is empty.
     */
    isEmpty() {
        return this.length === 0;
    }

    /**
     * Add multiple tracks to the queue.
     * @param {Array} tracks - The tracks to add.
     * @returns {Queue} The queue.
     */
    addMultiple(tracks) {
        if (Array.isArray(tracks)) {
            this.push(...tracks);
        }
        return this;
    }

}

module.exports = { Queue };

