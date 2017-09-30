// vim: ts=4:sw=4:expandtab

'use strict';

const helpers = require('../helpers');
const models = require('./models');
const storage = require('./storage');
const libsignal = require('libsignal');


class RelayProtocolStore {

    async getLocalIdentityKeyPair() {
        if (this._local_ident_key_pair === undefined) {
            this._local_ident_key_pair = {
                pubKey: Buffer.from(await storage.get_item('identityKey.pub'), 'base64'),
                privKey: Buffer.from(await storage.get_item('identityKey.priv'), 'base64')
            };
        }
        return this._local_ident_key_pair;
    }

    async setLocalIdentityKeyPair(keys) {
        await storage.put_item('identityKey.pub', keys.pubKey.toString('base64'));
        await storage.put_item('identityKey.priv', keys.privKey.toString('base64'));
        this._local_ident_key_pair = keys;
    }

    async getLocalRegistrationId() {
        return storage.get_item('registrationId');
    }

    /* Returns a prekeypair object or undefined */
    async loadPreKey(keyId) {
        var prekey = new models.PreKey({id: keyId});
        try {
            await prekey.fetch();
        } catch(e) {
            console.warn("Missing PreKey:", keyId);
            return;
        }
        console.log("Loaded PreKey:", keyId);
        return {
            pubKey: Buffer.from(prekey.get('publicKey'), 'base64'),
            privKey: Buffer.from(prekey.get('privateKey'), 'base64')
        };
    }

    async storePreKey(keyId, keyPair) {
        console.log("Storing PreKey:", keyId);
        var prekey = new models.PreKey({
            id: keyId,
            publicKey: keyPair.pubKey.toString('base64'),
            privateKey: keyPair.privKey.toString('base64')
        });
        await prekey.save();
    }

    async removePreKey(keyId) {
        console.log("Removing PreKey:", keyId);
        const prekey = new models.PreKey({id: keyId});
        try {
            await prekey.destroy();
        } catch(e) {
            console.warn("Already removed PreKey:", keyId);
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
        const data = await storage.get_item(`session-${encodedAddr}`);
        if (data !== undefined) {
            return libsignal.SessionRecord.deserialize(data);
        }
    }

    async storeSession(encodedAddr, record) {
        if (encodedAddr === null || encodedAddr === undefined) {
            throw new Error("Tried to put session for undefined/null addr");
        }
        await storage.put_item(`session-${encodedAddr}`, record.serialize());
    }

    async removeSession(encodedAddr) {
        await storage.remove(`session-${encodedAddr}`);
    }

    async removeAllSessions(addr) {
        if (addr === null || addr === undefined) {
            throw new Error("Tried to remove sessions for undefined/null addr");
        }
        for (const x of await storage.keys(`session-${addr}.*`)) {
            await storage.remove(x);
        }
    }

    async clearSessionStore() {
        for (const x of await storage.keys('session-*')) {
            await storage.remove(x);
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
            console.warn("WARNING: Implicit trust of new peer:", identifier);
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
            console.log("Saving new identity key:", identifier);
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
        const idents = await storage.keys(`session-${addr}.*`);
        return Array.from(idents).map(x => x.split('.')[1]);
    }

    async removeIdentityKey(addr) {
        var identityKey = new models.IdentityKey({id: addr});
        await identityKey.fetch();
        await identityKey.save({publicKey: undefined});
        await this.removeAllSessions(addr);
    }
}

module.exports = new RelayProtocolStore();
