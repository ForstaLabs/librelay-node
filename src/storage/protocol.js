/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const helpers = require('../helpers.js');
const models = require('./models');
const storage = require('./storage.js');



class RelayProtocolStore {

    async getIdentityKeyPair() {
        return {
            pubKey: Buffer.from(storage.get_item('identityKey.pub'), 'base64'),
            privKey: Buffer.from(storage.get_item('identityKey.priv'), 'base64')
        }
    }

    getLocalRegistrationId() {
        return storage.get_item('registrationId');
    }

    /* Returns a prekeypair object or undefined */
    async loadPreKey(keyId) {
        var prekey = new models.PreKey({id: keyId});
        try {
            await prekey.fetch();
        } catch(e) {
            return undefined;
        }
        return {
            pubKey: Buffer.from(prekey.get('publicKey'), 'base64'),
            privKey: Buffer.from(prekey.get('privateKey'), 'base64')
        };
    }

    async storePreKey(keyId, keyPair) {
        var prekey = new models.PreKey({
            id         : keyId,
            publicKey  : keyPair.pubKey.toString('base64'),
            privateKey : keyPair.privKey.toString('base64')
        });
        await prekey.save();
    }

    async removePreKey(keyId) {
        const prekey = new models.PreKey({id: keyId});
        console.log("Removing PreKey:", keyId);

        // XXX This is suspect...
        console.log("XXX Skipping SUSPECT refresh thing!");  // maybe this should block on refresh after the del.
        //new Promise(function(resolve) {
        //    getAccountManager().refreshPreKeys().then(resolve);
        //});
        await prekey.destroy();
    }

    /* Returns a signed keypair object or undefined */
    async loadSignedPreKey(keyId) {
        const prekey = new models.SignedPreKey({id: keyId});
        await prekey.fetch();
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

    async loadSession(encodedNumber) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to get session for undefined/null number");
        }
        const session = new models.Session({id: encodedNumber});
        console.log("XXX SESSION LOADING IS BROKEN!!!!");
        return undefined; // XXX FUCK THIS
        try {
            await session.fetch();
        } catch(e) {
            console.log(`WARNING: Session not found for: ${encodedNumber}`);
            return;
        }
        return session.get('record');
    }

    async storeSession(encodedNumber, record) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to put session for undefined/null number");
        }
        const number = helpers.unencodeNumber(encodedNumber)[0];
        const deviceId = parseInt(helpers.unencodeNumber(encodedNumber)[1]);
        const session = new models.Session({id: encodedNumber});
        console.log("XXX Skipping session save THIS NEEDS TO HAPPEN");
        return; //XXX
        try {
            await session.fetch();
        } catch(e) {
            console.log(`WARNING: Storing new session: ${e}`);
        }
        await session.save({
            record: record,
            deviceId: deviceId,
            number: number
        });
    }

    async getDeviceIds(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to get device ids for undefined/null number");
        }
        const sessions = new models.SessionCollection();
        await sessions.fetchSessionsForNumber(number);
        return sessions.pluck('deviceId');
    }

    async removeSession(encodedNumber) {
        const session = new models.Session({id: encodedNumber});
        await session.fetch();
        await session.destroy();
    }

    async removeAllSessions(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to remove sessions for undefined/null number");
        }
        const sessions = new models.SessionCollection();
        try {
            await sessions.fetchSessionsForNumber(number);
        } catch(e) {}  // XXX this is how it behaved in stock code.
        var promises = [];
        while (sessions.length > 0) {
            promises.push(sessions.pop().destroy());
        }
        await Promise.all(promises);
    }

    async clearSessionStore() {
        const sessions = new models.SessionCollection();
        if (sessions.id) {
            console.log("XXXX DOINGGIGNIG! session delete!!!!!!!");
            await sessions.sync('delete', sessions, {});
        } else {
            console.log("XXXX skipping session delete because no sessioncollection found?!!!!!!!");
        }
    }

    async isTrustedIdentity_dumb(identifier, publicKey) {
        console.log("WARNING: Blind trust", identifier);
        return true;
    }

    /* Always trust remote identity. */
    async isTrustedIdentity(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
        await identityKey.fetch();
        const oldpublicKey = Buffer.from(identityKey.get('publicKey'), 'base64');
        if (!oldpublicKey || oldpublicKey.equals(publicKey)) {
            console.log("XXXX HEY! We trust them!!!");
            return true;
        } else {
            console.error("WARNING: Auto-accepting new remote identity key for:",
                          identifier);
            await this.removeIdentityKey(identifier);
            await this.saveIdentity(identifier, publicKey);
            this.trigger('keychange:' + identifier);
            return true;
        }
    }

    isTrustedIdentity_orig_orig(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        var number = helpers.unencodeNumber(identifier)[0];
        return new Promise(function(resolve) {
            var identityKey = new models.IdentityKey({id: number});
            identityKey.fetch().always(function() {
                var oldpublicKey = Buffer.from(identityKey.get('publicKey'), 'base64');
                if (!oldpublicKey || oldpublicKey.equals(publicKey)) {
                    resolve(true);
                } else if (!storage.get_item('safety-numbers-approval', true)) {
                    this.removeIdentityKey(identifier).then(function() {
                        this.saveIdentity(identifier, publicKey).then(function() {
                            console.log('Key changed for', identifier);
                            this.trigger('keychange:' + identifier);
                            resolve(true);
                        }.bind(this));
                    }.bind(this));
                } else {
                    resolve(false);
                }
            }.bind(this));
        }.bind(this));
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

    async removeIdentityKey(number) {
        var identityKey = new models.IdentityKey({id: number});
        await identityKey.fetch();
        identityKey.save({publicKey: undefined});
        await storage.protocol.removeAllSessions(number);
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
