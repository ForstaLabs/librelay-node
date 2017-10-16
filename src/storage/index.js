// vim: ts=4:sw=4:expandtab

'use strict';

const helpers = require('../helpers');
const libsignal = require('libsignal');
const process = require('process');

const storage = process.env.RELAY_STORAGE;

const stateNS = 'state';
const sessionNS = 'session';
const preKeyNS = 'prekey';
const signedPreKeyNS = 'signedprekey';
const identityKeyNS = 'identitykey';


class StorageInterface {

    constructor(store) {
        this.store = store;
    }

    encode(data) {
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

    decode(obj) {
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

    async _get(ns, key) {
        const data = await this.store.get(ns, key);
        if (data) {
            return this.decode(data);
        } else {
            return data;
        }
    }

    async _set(ns, key, value) {
        return await this.store.set(ns, key, this.encode(value));
    }

    async shutdown() {
        return await this.store.shutdown();
    }

    async getState(key, defaultValue) {
        return await this._get(stateNS, key, defaultValue);
    }

    async setState(key, value) {
        return await this._set(stateNS, key, value);
    }

    async removeState(key) {
        return await this.store.remove(stateNS, key);
    }

    async getOurIdentity() {
        return {
            pubKey: await this.getState('ourIdentityKey.pub'),
            privKey: await this.getState('ourIdentityKey.priv')
        };
    }

    async saveOurIdentity(keyPair) {
        await this.setState('ourIdentityKey.pub', keyPair.pubKey);
        await this.setState('ourIdentityKey.priv', keyPair.privKey);
    }

    async removeOurIdentity() {
        await this.removeState('ourIdentityKey.pub');
        await this.removeState('ourIdentityKey.priv');
    }

    async getOurRegistrationId() {
        return await this.getState('registrationId');
    }

    async loadPreKey(keyId) {
        if (!await this.store.has(preKeyNS, keyId + '.pub')) {
            return;
        }
        return {
            pubKey: await this._get(preKeyNS, keyId + '.pub'),
            privKey: await this._get(preKeyNS, keyId + '.priv')
        };
    }

    async storePreKey(keyId, keyPair) {
        await this._set(preKeyNS, keyId + '.priv', keyPair.privKey);
        await this._set(preKeyNS, keyId + '.pub', keyPair.pubKey);
    }

    async removePreKey(keyId) {
        try {
            await this.store.remove(preKeyNS, keyId + '.pub');
            await this.store.remove(preKeyNS, keyId + '.priv');
        } finally {
            // Avoid circular require..
            const AccountManager = require('../account_manager');
            const am = await AccountManager.factory();
            await am.refreshPreKeys();
        }
    }

    async loadSignedPreKey(keyId) {
        if (!await this.store.has(signedPreKeyNS, keyId + '.pub')) {
            return;
        }
        return {
            pubKey: await this._get(signedPreKeyNS, keyId + '.pub'),
            privKey: await this._get(signedPreKeyNS, keyId + '.priv')
        };
    }

    async storeSignedPreKey(keyId, keyPair) {
        await this._set(signedPreKeyNS, keyId + '.priv', keyPair.privKey);
        await this._set(signedPreKeyNS, keyId + '.pub', keyPair.pubKey);
    }

    async removeSignedPreKey(keyId) {
        await this.store.remove(signedPreKeyNS, keyId + '.pub');
        await this.store.remove(signedPreKeyNS, keyId + '.priv');
    }

    async loadSession(encodedAddr) {
        if (encodedAddr === null || encodedAddr === undefined) {
            throw new Error("Tried to get session for undefined/null addr");
        }
        const data = await this._get(sessionNS, encodedAddr);
        if (data !== undefined) {
            return libsignal.SessionRecord.deserialize(data);
        }
    }

    async storeSession(encodedAddr, record) {
        if (encodedAddr === null || encodedAddr === undefined) {
            throw new Error("Tried to set session for undefined/null addr");
        }
        await this._set(sessionNS, encodedAddr, record.serialize());
    }

    async removeSession(encodedAddr) {
        await this.store.remove(sessionNS, encodedAddr);
    }

    async removeAllSessions(addr) {
        if (addr === null || addr === undefined) {
            throw new Error("Tried to remove sessions for undefined/null addr");
        }
        for (const x of await this.store.keys(sessionNS, new RegExp(addr + '\\..*'))) {
            await this.store.remove(sessionNS, x);
        }
    }

    async clearSessionStore() {
        for (const x of await this.store.keys(sessionNS)) {
            await this.store.remove(sessionNS, x);
        }
    }

    async isTrustedIdentity(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const identityKey = await this.loadIdentity(identifier);
        if (!identityKey) {
            console.warn("WARNING: Implicit trust of peer:", identifier);
            return true;
        }
        return identityKey.equals(publicKey);
    }

    async loadIdentity(identifier) {
        if (!identifier) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const addr = helpers.unencodeAddr(identifier)[0];
        return await this._get(identityKeyNS, addr);
    }

    async saveIdentity(identifier, publicKey) {
        if (!identifier) {
            throw new Error("Tried to set identity key for undefined/null key");
        }
        if (!(publicKey instanceof Buffer)) {
            throw new Error(`Invalid type for saveIdentity: ${publicKey.constructor.name}`);
        }
        const addr = helpers.unencodeAddr(identifier)[0];
        await this._set(identityKeyNS, addr, publicKey);
    }

    async removeIdentity(identifier) {
        const addr = helpers.unencodeAddr(identifier)[0];
        await this.store.remove(identityKeyNS, addr);
        await this.removeAllSessions(addr);
    }

    async getDeviceIds(addr) {
        if (addr === null || addr === undefined) {
            throw new Error("Tried to get device ids for undefined/null addr");
        }
        const idents = await this.store.keys(sessionNS, new RegExp(addr + '\\..*'));
        return Array.from(idents).map(x => x.split('.')[1]);
    }
}

if (storage === 'redis') {
    const redis = require('./redis');
    module.exports = new StorageInterface(redis);
} else if (!storage || storage === 'fs') {
    const fs = require('./fs');
    module.exports = new StorageInterface(fs);
} else {
    throw new TypeError("Unhandled storage type: " + storage);
}
