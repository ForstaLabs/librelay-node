// vim: ts=4:sw=4:expandtab

'use strict';

const util = require('../util');
const libsignal = require('libsignal');
const process = require('process');
exports.backing = require('./backing');

const defaultBacking = process.env.RELAY_STORAGE_BACKING || 'fs';

const stateNS = 'state';
const sessionNS = 'session';
const preKeyNS = 'prekey';
const signedPreKeyNS = 'signedprekey';
const identityKeyNS = 'identitykey';


let _backing;
let _Backing;
let _label = 'default';


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

async function _get(ns, key) {
    const data = await _backing.get(ns, key);
    if (data) {
        return decode(data);
    } else {
        return data;
    }
}

async function _set(ns, key, value) {
    return await _backing.set(ns, key, encode(value));
}

exports.shutdown = async function() {
    return await _backing.shutdown();
};

exports.getState = async function(key, defaultValue) {
    return await _get(stateNS, key, defaultValue);
};

exports.putState = async function(key, value) {
    return await _set(stateNS, key, value);
};

exports.removeState = async function(key) {
    return await _backing.remove(stateNS, key);
};

exports.getOurIdentity = async function() {
    return {
        pubKey: await exports.getState('ourIdentityKey.pub'),
        privKey: await exports.getState('ourIdentityKey.priv')
    };
};

exports.saveOurIdentity = async function(keyPair) {
    await exports.putState('ourIdentityKey.pub', keyPair.pubKey);
    await exports.putState('ourIdentityKey.priv', keyPair.privKey);
};

exports.removeOurIdentity = async function() {
    await exports.removeState('ourIdentityKey.pub');
    await exports.removeState('ourIdentityKey.priv');
};

exports.getOurRegistrationId = async function() {
    return await exports.getState('registrationId');
};

exports.loadPreKey = async function(keyId) {
    if (!await _backing.has(preKeyNS, keyId + '.pub')) {
        return;
    }
    return {
        pubKey: await _get(preKeyNS, keyId + '.pub'),
        privKey: await _get(preKeyNS, keyId + '.priv')
    };
};

exports.storePreKey = async function(keyId, keyPair) {
    await _set(preKeyNS, keyId + '.priv', keyPair.privKey);
    await _set(preKeyNS, keyId + '.pub', keyPair.pubKey);
};

exports.removePreKey = async function(keyId) {
    try {
        await _backing.remove(preKeyNS, keyId + '.pub');
        await _backing.remove(preKeyNS, keyId + '.priv');
    } finally {
        // Avoid circular require..
        const AccountManager = require('../account_manager');
        const am = await AccountManager.factory();
        await am.refreshPreKeys();
    }
};

exports.loadSignedPreKey = async function(keyId) {
    if (!await _backing.has(signedPreKeyNS, keyId + '.pub')) {
        return;
    }
    return {
        pubKey: await _get(signedPreKeyNS, keyId + '.pub'),
        privKey: await _get(signedPreKeyNS, keyId + '.priv')
    };
};

exports.storeSignedPreKey = async function(keyId, keyPair) {
    await _set(signedPreKeyNS, keyId + '.priv', keyPair.privKey);
    await _set(signedPreKeyNS, keyId + '.pub', keyPair.pubKey);
};

exports.removeSignedPreKey = async function(keyId) {
    await _backing.remove(signedPreKeyNS, keyId + '.pub');
    await _backing.remove(signedPreKeyNS, keyId + '.priv');
};

exports.loadSession = async function(encodedAddr) {
    if (encodedAddr === null || encodedAddr === undefined) {
        throw new Error("Tried to get session for undefined/null addr");
    }
    const data = await _get(sessionNS, encodedAddr);
    if (data !== undefined) {
        return libsignal.SessionRecord.deserialize(data);
    }
};

exports.storeSession = async function(encodedAddr, record) {
    if (encodedAddr === null || encodedAddr === undefined) {
        throw new Error("Tried to set session for undefined/null addr");
    }
    await _set(sessionNS, encodedAddr, record.serialize());
};

exports.removeSession = async function(encodedAddr) {
    await _backing.remove(sessionNS, encodedAddr);
};

exports.removeAllSessions = async function(addr) {
    if (addr === null || addr === undefined) {
        throw new Error("Tried to remove sessions for undefined/null addr");
    }
    for (const x of await _backing.keys(sessionNS, new RegExp(addr + '\\..*'))) {
        await _backing.remove(sessionNS, x);
    }
};

exports.clearSessionStore = async function() {
    for (const x of await _backing.keys(sessionNS)) {
        await _backing.remove(sessionNS, x);
    }
};

exports.isTrustedIdentity = async function(identifier, publicKey) {
    if (identifier === null || identifier === undefined) {
        throw new Error("Tried to get identity key for undefined/null key");
    }
    const identityKey = await exports.loadIdentity(identifier);
    if (!identityKey) {
        console.warn("WARNING: Implicit trust of peer:", identifier);
        return true;
    }
    return identityKey.equals(publicKey);
};

exports.loadIdentity = async function(identifier) {
    if (!identifier) {
        throw new Error("Tried to get identity key for undefined/null key");
    }
    const addr = util.unencodeAddr(identifier)[0];
    return await _get(identityKeyNS, addr);
};

exports.saveIdentity = async function(identifier, publicKey) {
    if (!identifier) {
        throw new Error("Tried to set identity key for undefined/null key");
    }
    if (!(publicKey instanceof Buffer)) {
        throw new Error(`Invalid type for saveIdentity: ${publicKey.constructor.name}`);
    }
    const addr = util.unencodeAddr(identifier)[0];
    await _set(identityKeyNS, addr, publicKey);
};

exports.removeIdentity = async function(identifier) {
    const addr = util.unencodeAddr(identifier)[0];
    await _backing.remove(identityKeyNS, addr);
    await exports.removeAllSessions(addr);
};

exports.getDeviceIds = async function(addr) {
    if (addr === null || addr === undefined) {
        throw new Error("Tried to get device ids for undefined/null addr");
    }
    const idents = await _backing.keys(sessionNS, new RegExp(addr + '\\..*'));
    return Array.from(idents).map(x => x.split('.')[1]);
};

function getBackingClass(name) {
    return {
        redis: exports.backing.RedisBacking,
        fs: exports.backing.FSBacking
    }[name];
}

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

exports.setLabel = function(label) {
    _label = label;
    _backing = new _Backing(label);
};


exports.setBacking(defaultBacking);
