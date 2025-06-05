class Queue extends Array {
    /**
     * @param {...*} elements - The elements to initialize the queue with.
     */
    constructor(...elements) {
        super(...elements);
    }

    // Get the size of the queue
    get size() {
        return this.length;
    }

    // Get the first element in the queue
    get first() {
        return this[0] ?? null;
    }

    // Get the last element in the queue
    get last() {
        return this[this.length - 1] ?? null;
    }

    /**
     * Add a track to the end of the queue.
     * @param {*} track - The track to add.
     */
    enqueue(track) {
        this.push(track);
        return this;
    }

    /**
     * Remove a specific track from the queue.
     * @param {*} track - The track to remove.
     * @returns {boolean} True if the track was removed, false otherwise.
     */
    remove(track) {
        const index = this.indexOf(track);
        if (index !== -1) {
            this.splice(index, 1);
            return true;
        }
        return false;
    }

    // Clear all tracks from the queue
    clear() {
        this.length = 0;
    }

    // Shuffle the tracks in the queue
    shuffle() {
        for (let i = this.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this[i], this[j]] = [this[j], this[i]];
        }
        return this;
    }

    // Peek at the element at the front of the queue without removing it
    peek() {
        return this[0] ?? null;
    }

    // Get all tracks in the queue as an array
    toArray() {
        return [...this];
    }

    /**
     * Get a track at a specific index.
     * @param {number} index - The index of the track to retrieve.
     * @returns {*} The track at the specified index or null if out of bounds.
     */
    at(index) {
        return (index >= 0 && index < this.length) ? this[index] : null;
    }

    // Remove the first track from the queue
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
     * Add a track to the queue
     * @param {*} track - The track to find.
     * @returns {true} The track object that was added to the queue.
     */
    add(track) {
        this.push(track);
        return this;
    }
}

module.exports = Queue;
