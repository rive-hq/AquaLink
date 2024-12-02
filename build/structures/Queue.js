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
        return this.length > 0 ? this[0] : null;
    }

    // Get the last element in the queue
    get last() {
        return this.length > 0 ? this[this.length - 1] : null;
    }

    /**
     * Add a track to the end of the queue.
     * @param {*} track - The track to add.
     */
    add(track) {
        this.push(track);
        return this;
    }

    /**
     * Remove a specific track from the queue.
     * @param {*} track - The track to remove.
     */
    remove(track) {
        const index = this.indexOf(track);
        if (index !== -1) {
            this.splice(index, 1);
        }
    }

    // Clear all tracks from the queue
    clear() {
        this.length = 0; // More efficient memory handling
    }

    // Shuffle the tracks in the queue
    shuffle() {
        for (let i = this.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this[i], this[j]] = [this[j], this[i]];
        }
    }

    // Peek at the element at the front of the queue without removing it
    peek() {
        return this.first;
    }

    // Get all tracks in the queue as an array
    toArray() {
        return [...this]; // Create a shallow copy of the queue
    }

    /**
     * Get a track at a specific index.
     * @param {number} index - The index of the track to retrieve.
     * @returns {*} The track at the specified index or null if out of bounds.
     */
    at(index) {
        return this[index] || null; // Return null if index is out of bounds
    }

    // Remove the first track from the queue
    dequeue() {
        return this.shift(); // Removes and returns the first element
    }

    // Check if the queue is empty
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
     */
    addMultiple(tracks) {
        if (Array.isArray(tracks)) {
            this.push(...tracks);
        }
    }

}

module.exports = { Queue };

