
/**
 * @module storage/backing
 */


/**
 * Interface for a backing store.
 */
class StorageInterface {

    /**
     * @param {string} label - Namespace to use for this store.
     */
    constructor(label) {
        this.label = label;
    }

    /** @abstract */
    async initialize() {
    }

    /** @abstract */
    async set(ns, key, value) {
        throw new Error("Not Implemented");
    }

    /** @abstract */
    async get(ns, key) {
        /* If key not found should throw ReferenceError */
        throw new Error("Not Implemented");
    }

    /** @abstract */
    async has(ns, key) {
        throw new Error("Not Implemented");
    }

    /** @abstract */
    async remove(ns, key) {
        throw new Error("Not Implemented");
    }

    /** @abstract */
    async keys(ns, regex) {
        throw new Error("Not Implemented");
    }

    /** @abstract */
    async shutdown() {
    }
}

module.exports = StorageInterface;
