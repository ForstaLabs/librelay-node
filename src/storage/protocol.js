/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const Backbone = require('./backbone-localstorage.js');
const Deferred = require('jquery-deferred').Deferred;
const ByteBuffer = require('bytebuffer');
const Database = require('./database.js');
const _ = require('underscore');
const storage = require('./storage.js');
const helpers = require('../helpers.js');
const models = require('./models');

var StaticByteBufferProto = new ByteBuffer().__proto__;
var StaticArrayBufferProto = new ArrayBuffer().__proto__;
var StaticUint8ArrayProto = new Uint8Array().__proto__;

function isStringable(thing) {
    return (thing === Object(thing) &&
                (thing.__proto__ == StaticArrayBufferProto ||
                thing.__proto__ == StaticUint8ArrayProto ||
                thing.__proto__ == StaticByteBufferProto));
}


function convertToArrayBuffer(thing) {
    if (thing === undefined) {
        return undefined;
    }
    if (thing === Object(thing)) {
        if (thing.__proto__ == StaticArrayBufferProto) {
            return thing;
        }
        //TODO: Several more cases here...
    }

    if (thing instanceof Array) {
        // Assuming Uint16Array from curve25519
        var res = new ArrayBuffer(thing.length * 2);
        var uint = new Uint16Array(res);
        for (var i = 0; i < thing.length; i++) {
            uint[i] = thing[i];
        }
        return res;
    }

    var str;
    if (isStringable(thing)) {
        str = stringObject(thing);
    } else if (typeof thing == "string") {
        str = thing;
    } else {
        throw new Error("Tried to convert a non-stringable thing of type " + typeof thing + " to an array buffer");
    }
    var res = new ArrayBuffer(str.length);
    var uint = new Uint8Array(res);
    for (var i = 0; i < str.length; i++) {
        uint[i] = str.charCodeAt(i);
    }
    return res;
}


function equalArrayBuffers(ab1, ab2) {
    if (!(ab1 instanceof ArrayBuffer && ab2 instanceof ArrayBuffer)) {
        return false;
    }
    if (ab1.byteLength !== ab2.byteLength) {
        return false;
    }
    var result = true;
    var ta1 = new Uint8Array(ab1);
    var ta2 = new Uint8Array(ab2);
    for (var i = 0; i < ab1.byteLength; ++i) {
        if (ta1[i] !== ta2[i]) { result = false; }
    }
    return result;
}


function RelayProtocolStore() {}

RelayProtocolStore.prototype = {

    constructor: RelayProtocolStore,

    getIdentityKeyPair: async function() {
        return {
            pubKey: storage.get_arraybuffer('identityKey.pub'),
            privKey: storage.get_arraybuffer('identityKey.priv')
        }
    },

    getLocalRegistrationId: function() {
        return storage.get_item('registrationId');
    },

    /* Returns a prekeypair object or undefined */
    loadPreKey: async function(keyId) {
        var prekey = new models.PreKey({id: keyId});
        try {
            await prekey.fetch();
        } catch(e) {
            return undefined;
        }
        return {
            pubKey: storage.array_buffer_decode(prekey.get('publicKey')),
            privKey: storage.array_buffer_decode(prekey.get('privateKey'))
        };
    },

    storePreKey: async function(keyId, keyPair) {
        var prekey = new models.PreKey({
            id         : keyId,
            publicKey  : storage.array_buffer_encode(keyPair.pubKey),
            privateKey : storage.array_buffer_encode(keyPair.privKey)
        });
        await prekey.save();
    },

    removePreKey: function(keyId) {
        const prekey = new models.PreKey({id: keyId});

        // XXX This is suspect...
        console.log("XXX Skipping SUSPECT refresh thing!");  // maybe this should block on refresh after the del.
        //new Promise(function(resolve) {
        //    getAccountManager().refreshPreKeys().then(resolve);
        //});

        return new Promise(function(resolve) {
            prekey.destroy().then(function() {
                resolve();
            });
        });
    },

    /* Returns a signed keypair object or undefined */
    loadSignedPreKey: async function(keyId) {
        const prekey = new models.SignedPreKey({id: keyId});
        await prekey.fetch();
        return {
            pubKey: storage.array_buffer_decode(prekey.get('publicKey')),
            privKey: storage.array_buffer_decode(prekey.get('privateKey'))
        };
    },

    storeSignedPreKey: async function(keyId, keyPair) {
        const prekey = new models.SignedPreKey({
            id: keyId,
            publicKey: storage.array_buffer_encode(keyPair.pubKey),
            privateKey: storage.array_buffer_encode(keyPair.privKey)
        });
        await prekey.save();
    },

    removeSignedPreKey: async function(keyId) {
        const prekey = new models.SignedPreKey({id: keyId});
        await prekey.destroy();
    },

    loadSession: async function(encodedNumber) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to get session for undefined/null number");
        }
        const session = new models.Session({id: encodedNumber});
        return undefined; // XXX FUCK THIS
        try {
            await session.fetch();
        } catch(e) {
            console.log(`WARNING: Session not found for: ${encodedNumber}`);
            return;
        }
        return session.get('record');
    },

    storeSession: async function(encodedNumber, record) {
        if (encodedNumber === null || encodedNumber === undefined) {
            throw new Error("Tried to put session for undefined/null number");
        }
        const number = helpers.unencodeNumber(encodedNumber)[0];
        const deviceId = parseInt(helpers.unencodeNumber(encodedNumber)[1]);
        const session = new models.Session({id: encodedNumber});
        console.log("XXX Skipping session save");
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
    },

    getDeviceIds: async function(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to get device ids for undefined/null number");
        }
        const sessions = new models.SessionCollection();
        await sessions.fetchSessionsForNumber(number);
        return sessions.pluck('deviceId');
    },

    removeSession: function(encodedNumber) {
        return new Promise(function(resolve) {
            var session = new models.Session({id: encodedNumber});
            session.fetch().then(function() {
                session.destroy().then(resolve);
            });
        });
    },

    removeAllSessions: function(number) {
        if (number === null || number === undefined) {
            throw new Error("Tried to remove sessions for undefined/null number");
        }
        return new Promise(function(resolve) {
            var sessions = new models.SessionCollection();
            sessions.fetchSessionsForNumber(number).always(function() {
                var promises = [];
                while (sessions.length > 0) {
                    promises.push(new Promise(function(res) {
                        sessions.pop().destroy().then(res);
                    }));
                }
                Promise.all(promises).then(resolve);
            });
        });
    },

    clearSessionStore: function() {
        return new Promise(function(resolve) {
            var sessions = new models.SessionCollection();
            if (sessions.id) {
                console.log("XXXX DOINGGIGNIG! session delete!!!!!!!");
                sessions.sync('delete', sessions, {}).always(resolve);
            } else {
                console.log("XXXX skipping session delete!!!!!!!");
                console.log("XXXX skipping session delete!!!!!!!");
                console.log("XXXX skipping session delete!!!!!!!");
                console.log("XXXX skipping session delete!!!!!!!");
                resolve();
            }
        });

    },

    isTrustedIdentity: async function(identifier, publicKey) {
        console.log("WARNING: Blind trust", identifier);
        return true;
    },

    isTrustedIdentity_orig: function(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        var number = helpers.unencodeNumber(identifier)[0];
        return new Promise(function(resolve) {
            var identityKey = new models.IdentityKey({id: number});
            identityKey.fetch().always(function() {
                var oldpublicKey = identityKey.get('publicKey');
                if (!oldpublicKey || equalArrayBuffers(oldpublicKey, publicKey)) {
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
    },

    loadIdentityKey: async function(identifier) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to get identity key for undefined/null key");
        }
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
        await identityKey.fetch();
        return storage.array_buffe_decode(identityKey.get('publicKey'));
    },

    saveIdentity: async function(identifier, publicKey) {
        if (identifier === null || identifier === undefined) {
            throw new Error("Tried to put identity key for undefined/null key");
        }
        if (!(publicKey instanceof ArrayBuffer)) {
            throw new Error(`Invalid type for saveIdentity: ${typeof publicKey}`);
            //publicKey = convertToArrayBuffer(publicKey); // XXX toss this out
        }
        const number = helpers.unencodeNumber(identifier)[0];
        const identityKey = new models.IdentityKey({id: number});
        try {
            await identityKey.fetch();
        } catch(e) {} // not found
        const oldpublicKey = identityKey.get('publicKey');
        if (!oldpublicKey) {
            // Lookup failed, or the current key was removed, so save this one.
            await identityKey.save({
                publicKey: storage.array_buffer_encode(publicKey)
            });
        } else {
            if (!equalArrayBuffers(oldpublicKey, publicKey)) {
                console.log("WARNING: Saving over identity key:", identifier);
                //reject(new Error("Attempted to overwrite a different identity key"));
                await identityKey.save({
                    publicKey: storage.array_buffer_encode(publicKey)
                });
            }
        }
    },

    removeIdentityKey: async function(number) {
        var identityKey = new models.IdentityKey({id: number});
        await identityKey.fetch();
        identityKey.save({publicKey: undefined});
        await storage.protocol.removeAllSessions(number);
    },

    getGroup: async function(groupId) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to get group for undefined/null id");
        }
        const group = new Group({id: groupId});
        await group.fetch();
        return group.get('data');
    },

    putGroup: async function(groupId, value) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to put group key for undefined/null id");
        }
        if (group === null || group === undefined) {
            throw new Error("Tried to put undefined/null group object");
        }
        const group = new Group({id: groupId, data: value});
        await group.save();
    },

    removeGroup: async function(groupId) {
        if (groupId === null || groupId === undefined) {
            throw new Error("Tried to remove group key for undefined/null id");
        }
        const group = new Group({id: groupId});
        await group.destroy();
    },
};
_.extend(RelayProtocolStore.prototype, Backbone.Events);

module.exports = new RelayProtocolStore();
