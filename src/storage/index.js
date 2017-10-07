// vim: ts=4:sw=4:expandtab

'use strict';

const helpers = require('../helpers');
const libsignal = require('libsignal');
const models = require('./models');
const redis = require('./redis');


class StorageInterface {

    constructor(store) {
        this.store = store;
    }

    async shutdown() {
        return await this.store.shutdown();
    }

    async getState(key, defaultValue) {
        return await this.store.get(key, defaultValue);
    }

    async getStateDict(keys) {
        return await this.store.getDict(keys);
    }

    async putState(key, value) {
        return await this.store.put(key, value);
    }

    async putStateDict(dict) {
        return await this.store.putDict(dict);
    }

    async removeState(key) {
        return await this.store.remove(key);
    }

    async getOurIdentity() {
        return {
            pubKey: Buffer.from(await this.store.get('ourIdentityKey.pub'), 'base64'),
            privKey: Buffer.from(await this.store.get('ourIdentityKey.priv'), 'base64')
        };
    }

    async getIdentityKeyPair() {
        // XXX Deprecate this...
        return await this.getOurIdentity();
    }

    async getLocalIdentityKeyPair() {
        // XXX Deprecate this...
        return await this.getOurIdentity();
    }

    async saveOurIdentity(keyPair) {
        await this.store.put('ourIdentityKey.pub', keyPair.pubKey.toString('base64'));
        await this.store.put('ourIdentityKey.priv', keyPair.privKey.toString('base64'));
    }

    async removeOurIdentity() {
        await this.store.remove('ourIdentityKey.pub');
        await this.store.remove('ourIdentityKey.priv');
    }

    async getOurRegistrationId() {
        return await this.store.get('ourRegistrationId');
    }

    async getLocalRegistrationId() {
        // XXX Deprecate this...
        return await this.getOurRegistrationId();
    }

    /* Returns a prekeypair object or undefined */
    async loadPreKey(keyId) {
        var prekey = new models.PreKey({id: keyId});
        try {
            await prekey.fetch();
        } catch(e) {
            return;
        }
        return {
            pubKey: Buffer.from(prekey.get('publicKey'), 'base64'),
            privKey: Buffer.from(prekey.get('privateKey'), 'base64')
        };
    }

    async storePreKey(keyId, keyPair) {
        var prekey = new models.PreKey({
            id: keyId,
            publicKey: keyPair.pubKey.toString('base64'),
            privateKey: keyPair.privKey.toString('base64')
        });
        await prekey.save();
    }

    async removePreKey(keyId) {
        const prekey = new models.PreKey({id: keyId});
        try {
            await prekey.destroy();
        } catch(e) {
            console.warn("Already removed PreKey:", keyId);
        } finally {
            // Avoid circular require..
            const AccountManager = require('../account_manager');
            const am = await AccountManager.factory();
            await am.refreshPreKeys();
        }
    }

    /* Returns a signed keypair object or undefined */
    async loadSignedPreKey(keyId) {
        const prekey = new models.SignedPreKey({id: keyId});
        try {
            await prekey.fetch();
        } catch(e) {
            console.warn("Missing SignedPreKey:", keyId);
            return;
        }
        console.warn("Loaded SignedPreKey:", keyId);
        return {
            pubKey: Buffer.from(prekey.get('publicKey'), 'base64'),
            privKey: Buffer.from(prekey.get('privateKey'), 'base64')
        };
    }

    async storeSignedPreKey(keyId, keyPair) {
        const prekey = new models.SignedPreKey({
            id: keyId,
            publicKey: keyPair.pubKey.toString('base64'),
            privateKey: keyPair.privKey.toString('base64')
        });
        await prekey.save();
    }

    async removeSignedPreKey(keyId) {
        const prekey = new models.SignedPreKey({id: keyId});
        await prekey.destroy();
    }

    async loadSession(encodedAddr) {
        if (encodedAddr === null || encodedAddr === undefined) {
            throw new Error("Tried to get session for undefined/null addr");
        }
        const data = await this.store.get(`session-${encodedAddr}`);
        if (data !== undefined) {
            return libsignal.SessionRecord.deserialize(data);
        }
    }

    async storeSession(encodedAddr, record) {
        if (encodedAddr === null || encodedAddr === undefined) {
            throw new Error("Tried to put session for undefined/null addr");
        }
        await this.store.put(`session-${encodedAddr}`, record.serialize());
    }

    async removeSession(encodedAddr) {
        await this.store.remove(`session-${encodedAddr}`);
    }

    async removeAllSessions(addr) {
        if (addr === null || addr === undefined) {
            debugger;
            throw new Error("Tried to remove sessions for undefined/null addr");
        }
        for (const x of await this.store.keys(`session-${addr}.*`)) {
            await this.store.remove(x);
        }
    }

    async clearSessionStore() {
        for (const x of await this.store.keys('session-*')) {
            await this.store.remove(x);
        }
    }

    async isTrustedIdentity(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const addr = helpers.unencodeAddr(identifier)[0];
        const identityKey = new models.IdentityKey({id: addr});
        try {
            await identityKey.fetch();
        } catch(e) {
            console.warn("WARNING: Implicit trust of peer:", identifier);
            return true;
        }
        const knownPublicKey = Buffer.from(identityKey.get('publicKey'), 'base64');
        return knownPublicKey.equals(publicKey);
    }

    async loadIdentityKey(identifier) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const addr = helpers.unencodeAddr(identifier)[0];
        const identityKey = new models.IdentityKey({id: addr});
        await identityKey.fetch();
        return Buffer.from(identityKey.get('publicKey'), 'base64');
    }

    async saveIdentity(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to put identity key for undefined/null key");
        }
        if (!(publicKey instanceof Buffer)) {
            throw new Error(`Invalid type for saveIdentity: ${publicKey.constructor.name}`);
        }
        const addr = helpers.unencodeAddr(identifier)[0];
        const identityKey = new models.IdentityKey({id: addr});
        try {
            await identityKey.fetch();
        } catch(e) { /* not found */ }
        const oldpublicKey = identityKey.get('publicKey');
        if (!oldpublicKey) {
            await identityKey.save({
                publicKey: publicKey.toString('base64')
            });
        } else {
            if (!Buffer.from(oldpublicKey, 'base64').equals(publicKey)) {
                console.log("WARNING: Saving over identity key:", identifier);
                await identityKey.save({
                    publicKey: publicKey.toString('base64')
                });
            }
        }
    }

    async getDeviceIds(addr) {
        if (addr === null || addr === undefined) {
            throw new Error("Tried to get device ids for undefined/null addr");
        }
        const idents = await this.store.keys(`session-${addr}.*`);
        return Array.from(idents).map(x => x.split('.')[1]);
    }

    async removeIdentityKey(addr) {
        var identityKey = new models.IdentityKey({id: addr});
        await identityKey.destroy();
        await this.removeAllSessions(addr);
    }
}

module.exports = new StorageInterface(redis);
