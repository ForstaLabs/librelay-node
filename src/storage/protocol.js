/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const helpers = require('../helpers');
const models = require('./models');
const storage = require('./storage');


class RelayProtocolStore {

    constructor() {
        this._sessions = {};
        this._sessions_by_number = {};
    }

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
        await storage.put_item('identityKey.pub', keys.pubKey.toString('base64')),
        await storage.put_item('identityKey.priv', keys.privKey.toString('base64'))
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

    loadSession(encodedNumber) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to get session for undefined/null number");
        }
        return this._sessions[encodedNumber];
    }

    storeSession(encodedNumber, record) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to put session for undefined/null number");
        }
        const number = helpers.unencodeNumber(encodedNumber)[0];
        this._sessions[encodedNumber] = record;
        if (!this._sessions_by_number.hasOwnProperty(number)) {
            this._sessions_by_number[number] = new Set();
        }
        this._sessions_by_number[number].add(encodedNumber);
    }

    removeSession(encodedNumber) {
        if (!this._sessions.hasOwnProperty(encodedNumber)) {
            throw new Error('Not a valid session');
        }
        const number = helpers.unencodeNumber(encodedNumber)[0];
        this._sessions_by_number[number].delete(encodedNumber);
        delete this._sessions[encodedNumber];
        
    }

    removeAllSessions(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to remove sessions for undefined/null number");
        }
        const idents = this._sessions_by_number[number];
        for (const x of idents) {
            delete this._sessions[x];
        }
        idents.clear();
    }

    clearSessionStore() {
        this._sessions = {};
        this._sessions_by_number = {};
    }

    /* Always trust remote identity. */
    async isTrustedIdentity(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
        try {
            await identityKey.fetch();
        } catch(e) {
            console.error("WARNING: Implicit trust of new peer:", identifier);
            return true;
        }
        const oldpublicKey = Buffer.from(identityKey.get('publicKey'), 'base64');
        if (oldpublicKey.equals(publicKey)) {
            console.log("Known and trusted peer:", identifier);
            return true;
        } else {
            console.error("WARNING: Auto-accepting new peer identity:",
                          identifier);
            await this.removeIdentityKey(identifier);
            await this.saveIdentity(identifier, publicKey);
            return true;
        }
    }

    async loadIdentityKey(identifier) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
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
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
        try {
            await identityKey.fetch();
        } catch(e) {} // not found
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

    getDeviceIds(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to get device ids for undefined/null number");
        }
        const idents = this._sessions_by_number[number];
        return Array.from(idents).map(x => helpers.unencodeNumber(x)[1]);
    }

    async removeIdentityKey(number) {
        var identityKey = new models.IdentityKey({id: number});
        await identityKey.fetch();
        identityKey.save({publicKey: undefined});
        storage.protocol.removeAllSessions(number);
    }

    async getGroup(groupId) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to get group for undefined/null id");
        }
        const group = new models.Group({id: groupId});
        await group.fetch();
        return group.get('data');
    }

    async putGroup(groupId, value) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to put group key for undefined/null id");
        }
        if (group === null || group === undefined) {
            throw new Error("Tried to put undefined/null group object");
        }
        const group = new models.Group({id: groupId, data: value});
        await group.save();
    }

    async removeGroup(groupId) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to remove group key for undefined/null id");
        }
        const group = new models.Group({id: groupId});
        await group.destroy();
    }
}

module.exports = new RelayProtocolStore();
