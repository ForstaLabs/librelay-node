// vim: ts=4:sw=4:expandtab

/**
 * @module storage
 */

const util = require('../util');
const libsignal = require('libsignal');
const process = require('process');
exports.backing = require('./backing');

const defaultBacking = process.env.RELAY_STORAGE_BACKING || 'fs';
const defaultLabel = process.env.RELAY_STORAGE_LABEL || 'default';

const stateNS = 'state';
const sessionNS = 'session';
const preKeyNS = 'prekey';
const signedPreKeyNS = 'signedprekey';
const identityKeyNS = 'identitykey';
const blockedNS = 'blocked';


let _backing;
let _Backing;
let _label = defaultLabel;


function encode(data) {
    const o = {};
    if (data instanceof Buffer) {
        o.type = 'buffer';
        o.data = data.toString('base64');
    } else if (data instanceof ArrayBuffer) {
        throw TypeError("ArrayBuffer not supported");
    } else if (data instanceof Uint8Array) {
        o.type = 'uint8array';
        o.data = Buffer.from(data).toString('base64');
    } else {
        o.data = data;
    }
    return JSON.stringify(o);
}

function decode(obj) {
    const o = JSON.parse(obj);
    if (o.type) {
        if (o.type === 'buffer') {
            return Buffer.from(o.data, 'base64');
        } else if (o.type === 'uint8array') {
            return Uint8Array.from(Buffer.from(o.data, 'base64'));
        } else {
            throw TypeError("Unsupported type: " + o.type);
        }
    } else {
        return o.data;
    }
}


/**
 * Initialize the current {@link module:storage/backing~StorageInterface}
 */
exports.initialize = () => _backing.initialize();


/**
 * Get a value from the current {@link module:storage/backing~StorageInterface}
 *
 * @param {string} ns - Namespace for the store.
 * @param {string} key
 * @param {*} [defaultValue] - Value to return if key is not present.
 * @returns {*} Decoded value from the current
 *              {@link module:storage/backing~StorageInterface}
 */
exports.get = async (ns, key, defaultValue) => {
    let data;
    try {
        data = await _backing.get(ns, key);
    } catch(e) {
        if (e instanceof ReferenceError) {
            return defaultValue;
        } else {
            throw e;
        }
    }
    return data && decode(data);
};


/**
 * Set a value in the current {@link module:storage/backing~StorageInterface}.
 *
 * @param {string} ns - Namespace for the store.
 * @param {string} key
 * @param {*} value
 */
exports.set = (ns, key, value) => _backing.set(ns, key, encode(value));


/**
 * Test if a key is present in the current {@link module:storage/backing~StorageInterface}.
 *
 * @param {string} ns - Namespace for the store.
 * @param {string} key
 * @returns {boolean} - True if the key is present.
 */
exports.has = (ns, key, value) => _backing.has(ns, key);


/**
 * Remove an entry from the current {@link module:storage/backing~StorageInterface}.
 *
 * @param {string} ns - Namespace for the store.
 * @param {string} key
 */
exports.remove = (ns, key) => _backing.remove(ns, key);


/**
 * Scan the {@link module:storage/backing~StorageInterface} for keys.
 *
 * @param {string} ns - Namespace for the store.
 * @param {RegExp} [re] - Regular expression filter.
 * @returns {string[]} - Array of matching keys.
 */
exports.keys = (ns, re) => _backing.keys(ns, re);


/**
 * Shutdown the current {@link module:storage/backing~StorageInterface}.
 */
exports.shutdown = () => _backing.shutdown();


/**
 * Get a global state value from the {@link module:storage/backing~StorageInterface}.
 *
 * @param {string} key
 * @param {*} [defaultValue] - Value to return if key is not present.
 * @returns {*}
 */
exports.getState = async function(key, defaultValue) {
    return await exports.get(stateNS, key, defaultValue);
};


/**
 * Set a global state value in the {@link module:storage/backing~StorageInterface}.
 *
 * @param {string} key
 * @param {*} value
 */
exports.putState = async function(key, value) {
    return await exports.set(stateNS, key, value);
};


/**
 * Remove a value from the state store.
 * @param {string} key
 */
exports.removeState = async function(key) {
    return await _backing.remove(stateNS, key);
};


/**
 * @returns {KeyPair} The current user's identity key pair.
 */
exports.getOurIdentity = async function() {
    return {
        pubKey: await exports.getState('ourIdentityKey.pub'),
        privKey: await exports.getState('ourIdentityKey.priv')
    };
};


/**
 * @param {KeyPair} keyPair - New identity key pair for current user.
 */
exports.saveOurIdentity = async function(keyPair) {
    await exports.putState('ourIdentityKey.pub', keyPair.pubKey);
    await exports.putState('ourIdentityKey.priv', keyPair.privKey);
};


/**
 * Remove the current user's identity key pair.
 */
exports.removeOurIdentity = async function() {
    await exports.removeState('ourIdentityKey.pub');
    await exports.removeState('ourIdentityKey.priv');
};


/**
 * @returns {?number} The current user's registration identifier.
 */
exports.getOurRegistrationId = async function() {
    return await exports.getState('registrationId');
};


/**
 * Get a prekey pair for the current user.
 *
 * @param {number} keyId
 * @returns {?KeyPair}
 */
exports.loadPreKey = async function(keyId) {
    if (!await _backing.has(preKeyNS, keyId + '.pub')) {
        return;
    }
    return {
        pubKey: await exports.get(preKeyNS, keyId + '.pub'),
        privKey: await exports.get(preKeyNS, keyId + '.priv')
    };
};


/**
 * Store a new prekey pair for the current user.
 *
 * @param {number} keyId
 * @param {KeyPair} keyPair
 */
exports.storePreKey = async function(keyId, keyPair) {
    await exports.set(preKeyNS, keyId + '.priv', keyPair.privKey);
    await exports.set(preKeyNS, keyId + '.pub', keyPair.pubKey);
};


/**
 * Remove a prekey pair for the current user.
 *
 * @param {number} keyId
 */
exports.removePreKey = async function(keyId) {
    try {
        await _backing.remove(preKeyNS, keyId + '.pub');
        await _backing.remove(preKeyNS, keyId + '.priv');
    } finally {
        // Avoid circular require..
        const hub = require('../hub');
        const signal = await hub.SignalClient.factory();
        await signal.refreshPreKeys();
    }
};


/**
 * Get a signed prekey pair for the current user.
 *
 * @param {number} keyId
 * @returns {?KeyPair}
 */
exports.loadSignedPreKey = async function(keyId) {
    if (!await _backing.has(signedPreKeyNS, keyId + '.pub')) {
        return;
    }
    return {
        pubKey: await exports.get(signedPreKeyNS, keyId + '.pub'),
        privKey: await exports.get(signedPreKeyNS, keyId + '.priv')
    };
};


/**
 * Store a new signed prekey pair for the current user.
 *
 * @param {number} keyId
 * @param {KeyPair} keyPair
 */
exports.storeSignedPreKey = async function(keyId, keyPair) {
    await exports.set(signedPreKeyNS, keyId + '.priv', keyPair.privKey);
    await exports.set(signedPreKeyNS, keyId + '.pub', keyPair.pubKey);
};


/**
 * Remove a signed prekey pair for the current user.
 *
 * @param {number} keyId
 */
exports.removeSignedPreKey = async function(keyId) {
    await _backing.remove(signedPreKeyNS, keyId + '.pub');
    await _backing.remove(signedPreKeyNS, keyId + '.priv');
};


/**
 * Load a signal cipher session for a peer.
 *
 * @param {EncodedUserAddress} encodedAddr
 * @returns {?libsignal.SessionRecord}
 */
exports.loadSession = async function(encodedAddr) {
    if (encodedAddr === null || encodedAddr === undefined) {
        throw new Error("Tried to get session for undefined/null addr");
    }
    const data = await exports.get(sessionNS, encodedAddr);
    if (data !== undefined) {
        return libsignal.SessionRecord.deserialize(data);
    }
};


/**
 * Store a signal cipher session for a peer.
 *
 * @param {EncodedUserAddress} encodedAddr
 * @returns {libsignal.SessionRecord} record
 */
exports.storeSession = async function(encodedAddr, record) {
    if (encodedAddr === null || encodedAddr === undefined) {
        throw new Error("Tried to set session for undefined/null addr");
    }
    await exports.set(sessionNS, encodedAddr, record.serialize());
};


/**
 * Remove a signal session cipher record for a peer.
 *
 * @param {EncodedUserAddress} encodedAddr
 */
exports.removeSession = async function(encodedAddr) {
    await _backing.remove(sessionNS, encodedAddr);
};


/**
 * Remove all signal session cipher records for a peer.
 *
 * @param {string} addr - UUID of peer.
 */
exports.removeAllSessions = async function _removeAllSessions(addr) {
    if (addr === null || addr === undefined) {
        throw new Error("Tried to remove sessions for undefined/null addr");
    }
    for (const x of await _backing.keys(sessionNS, new RegExp(addr + '\\..*'))) {
        await _backing.remove(sessionNS, x);
    }
};


/**
 * Clear all signal session cipher records.
 */
exports.clearSessionStore = async function() {
    for (const x of await _backing.keys(sessionNS)) {
        await _backing.remove(sessionNS, x);
    }
};


/**
 * Determine if a peer's public identity key matches our records.
 *
 * @param {string} identifier - Address of peer
 * @param {Buffer} publicKey - Public key to test.
 * @returns {boolean}
 */
exports.isTrustedIdentity = async function(identifier, publicKey) {
    if (!identifier) {
        throw new TypeError("`identifier` required");
    }
    if (!(publicKey instanceof Buffer)) {
        throw new TypeError("publicKey must be Buffer");
    }
    const trustedIdentityKey = await exports.loadIdentity(identifier);
    if (!trustedIdentityKey) {
        console.warn("WARNING: Implicit trust of peer:", identifier);
        await exports.saveIdentity(identifier, publicKey);
    }
    return !trustedIdentityKey || trustedIdentityKey.equals(publicKey);
};


/**
 * Load our last known identity key for a peer.
 *
 * @param {string} identifier - Address of peer
 * @returns {?Buffer} Public identity key for peer
 */
exports.loadIdentity = async function(identifier) {
    if (!identifier) {
        throw new Error("Tried to get identity key for undefined/null key");
    }
    const addr = util.unencodeAddr(identifier)[0];
    return await exports.get(identityKeyNS, addr);
};


/**
 * Store a new trusted public identity key for a peer.
 *
 * @param {string} identifier - Address of peer
 * @param {Buffer} publicKey - Public identity key for peer
 */
exports.saveIdentity = async function(identifier, publicKey) {
    if (!identifier) {
        throw new TypeError("`identifier` required");
    }
    if (!(publicKey instanceof Buffer)) {
        throw new TypeError("publicKey must be Buffer");
    }
    const addr = util.unencodeAddr(identifier)[0];
    const oldPublicKey = await this.loadIdentity(addr);
    if (oldPublicKey && !oldPublicKey.equals(publicKey)) {
        console.warn("Changing trusted identity key for:", addr);
        await exports.removeAllSessions(addr);
    }
    await exports.set(identityKeyNS, addr, publicKey);
};


/**
 * Remove the current trusted public identity key for a peer.
 *
 * @params {string} identifier - Address of peer
 */
exports.removeIdentity = async function(identifier) {
    const addr = util.unencodeAddr(identifier)[0];
    await _backing.remove(identityKeyNS, addr);
    await exports.removeAllSessions(addr);
};


/**
 * Get the current known list of device IDs for a peer.
 *
 * @params {string} addr - Address of peer
 * @returns {number[]}
 */
exports.getDeviceIds = async function(addr) {
    if (addr === null || addr === undefined) {
        throw new Error("Tried to get device ids for undefined/null addr");
    }
    const idents = await _backing.keys(sessionNS, new RegExp(addr + '\\..*'));
    return Array.from(idents).map(x => Number(x.split('.')[1]));
};


/**
 * Indicates if an address is considered to be "blocked".  Generally this means
 * message handling will be aborted for this address.
 *
 * @param {string} addr - Address of peer.
 * @returns {boolean}
 */
exports.isBlocked = async function(addr) {
    return await _backing.has(blockedNS, addr);
};


function getBackingClass(name) {
    return {
        redis: exports.backing.RedisBacking,
        postgres: exports.backing.PostgresBacking,
        fs: exports.backing.FSBacking
    }[name];
}

/**
 * Set the default {@link module:storage/backing~StorageInterface} to use for
 * further storage operations.
 *
 * @param {(module:storage/backing~StorageInterface|string)} Backing - Class or string label.
 */
exports.setBacking = function(Backing) {
    if (typeof Backing === 'string') {
        Backing = getBackingClass(Backing);
    }
    if (!Backing) {
        throw new TypeError("Invalid storage backing: " + Backing);
    }
    _Backing = Backing;
    _backing = new Backing(_label);
};


/**
 * Set the label to use within the current
 * {@link module:storage/backing~StorageInterface}.  This is an ideal way of
 * partitioning a single store for multiple users.  E.g sharing the
 * same database instance for more than one librelay based application.
 *
 * @param {string} label
 */
exports.setLabel = function(label) {
    _label = label;
    _backing = new _Backing(label);
};


exports.setBacking(defaultBacking);
