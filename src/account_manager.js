/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const EventTarget = require('./event_target.js');
const ProvisioningCipher = require('./provisioning_cipher.js');
const WebSocketResource = require('./websocket-resources.js');
const api = require('./api.js');
const btoa = require('bytebuffer').btoa;
const helpers = require('./helpers.js');
const libsignal = require('libsignal');
const protobufs = require('./protobufs.js');
const storage = require('./storage');


function AccountManager(url, username, password) {
    this.server = new api.RelayServer(url, username, password);
}

AccountManager.prototype = new EventTarget();

AccountManager.prototype.extend({

    constructor: AccountManager,

    requestVoiceVerification: function(number) {
        return this.server.requestVerificationVoice(number);
    },

    requestSMSVerification: function(number) {
        return this.server.requestVerificationSMS(number);
    },

    registerSingleDevice: async function(number, verificationCode) {
        const identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();
        await this.createAccount(number, verificationCode, identityKeyPair);
        const keys = await this.generateKeys(100);
        await this.server.registerKeys(keys);
    },

    registerSecondDevice: function(setProvisioningUrl, confirmNumber) {
        throw new Error("UNUSED?");
        var createAccount = this.createAccount.bind(this);
        var generateKeys = this.generateKeys.bind(this, 100);
        var registerKeys = this.server.registerKeys.bind(this.server);
        var getSocket = this.server.getProvisioningSocket.bind(this.server);
        var provisioningCipher = new ProvisioningCipher();
        return provisioningCipher.getPublicKey().then(function(pubKey) {
            return new Promise(function(resolve, reject) {
                var socket = getSocket();
                socket.onclose = function(e) {
                    console.log('websocket closed', e.code);
                    reject(new Error('websocket closed'));
                };
                var wsr = new WebSocketResource(socket, {
                    keepalive: { path: '/v1/keepalive/provisioning' },
                    handleRequest: function(request) {
                        if (request.path === "/v1/address" && request.verb === "PUT") {
                            var proto = protobufs.ProvisioningUuid.decode(request.body);
                            setProvisioningUrl([
                                'tsdevice:/?uuid=', proto.uuid, '&pub_key=',
                                encodeURIComponent(btoa(helpers.getString(pubKey)))
                            ].join(''));
                            request.respond(200, 'OK');
                        } else if (request.path === "/v1/message" && request.verb === "PUT") {
                            var envelope = protobufs.ProvisionEnvelope.decode(request.body, 'binary');
                            request.respond(200, 'OK');
                            wsr.close();
                            resolve(provisioningCipher.decrypt(envelope).then(function(provisionMessage) {
                                return confirmNumber(provisionMessage.number).then(function(deviceName) {
                                    if (typeof deviceName !== 'string' || deviceName.length === 0) {
                                        throw new Error('Invalid device name');
                                    }
                                    return createAccount(
                                        provisionMessage.number,
                                        provisionMessage.provisioningCode,
                                        provisionMessage.identityKeyPair,
                                        deviceName
                                    );
                                });
                            }));
                        } else {
                            console.log('Unknown websocket message', request.path);
                        }
                    }
                });
            });
        }).then(generateKeys).
           then(registerKeys);
    },

    refreshPreKeys: async function() {
        if (this.server.getMyKeys() < 10) {
            const keys = await generateKeys(100);
            await this.server.registerKeys(keys);
        }
    },

    createAccount: async function(number, verificationCode, identityKeyPair, deviceName) {
        var signalingKey = libsignal.crypto.getRandomBytes(32 + 20);
        var password = btoa(helpers.getString(libsignal.crypto.getRandomBytes(16)));
        password = password.substring(0, password.length - 2);
        var registrationId = libsignal.KeyHelper.generateRegistrationId();

        const resp = await this.server.confirmCode(number, verificationCode,
                                                   password, signalingKey,
                                                   registrationId, deviceName);
        await storage.protocol.clearSessionStore();
        storage.remove_item('identityKey');
        storage.remove_item('signaling_key');
        storage.remove_item('password');
        storage.remove_item('registrationId');
        storage.remove_item('number_id');
        storage.remove_item('device_name');
        storage.remove_item('regionCode');

        // update our own identity key, which may have changed
        // if we're relinking after a reinstall on the master device
        try {
            await storage.protocol.removeIdentityKey(number);
        } catch(e) {
            console.log("WARNING: Ignoring removeIdentityKey error");
        }
        await storage.protocol.saveIdentity(number, identityKeyPair.pubKey);

        storage.put_arraybuffer('identityKey.pub', identityKeyPair.pubKey);
        storage.put_arraybuffer('identityKey.priv', identityKeyPair.privKey);
        storage.put_arraybuffer('signaling_key', signalingKey);
        storage.put_item('password', password);
        storage.put_item('registrationId', registrationId);

        console.log("SetNumberAndDeviceId", number, resp.deviceId, deviceName);
        storage.user.setNumberAndDeviceId(number, resp.deviceId || 1, deviceName);
        //storage.put_item('regionCode', libphonenumber.util.getRegionCodeForNumber(number));
        storage.put_item('regionCode', 'ZZ'); // XXX Do we care?
        this.server.setUsername(storage.get_item('number_id'));
        this.server.setPassword(password);
    },

    generateKeys: async function (count) {
        var startId = storage.get_item('maxPreKeyId', 1);
        var signedKeyId = storage.get_item('signedKeyId', 1);

        if (typeof startId != 'number') {
            throw new Error(`Invalid maxPreKeyId: ${startId} ${typeof startId}`);
        }
        if (typeof signedKeyId != 'number') {
            throw new Error(`Invalid signedKeyId: ${signedKeyId} ${typeof signedKeyId}`);
        }

        var store = storage.protocol;
        var identityKey = {
            pubKey: storage.get_arraybuffer('identityKey.pub'),
            privKey: storage.get_arraybuffer('identityKey.priv')
        }
        console.log('xxxxxxx', identityKey);
        var result = { preKeys: [], identityKey: identityKey.pubKey };

        for (var keyId = startId; keyId < startId+count; ++keyId) {
            console.log("Generating key:", keyId);
            let k = await libsignal.KeyHelper.generatePreKey(keyId);
            store.storePreKey(k.keyId, k.keyPair);
            result.preKeys.push({
                keyId     : k.keyId,
                publicKey : k.keyPair.pubKey
            });
        }

        const spk = await libsignal.KeyHelper.generateSignedPreKey(identityKey, signedKeyId);
        store.storeSignedPreKey(spk.keyId, spk.keyPair);
        result.signedPreKey = {
            keyId     : spk.keyId,
            publicKey : spk.keyPair.pubKey,
            signature : spk.signature
        };

        store.removeSignedPreKey(signedKeyId - 2);
        storage.put_item('maxPreKeyId', startId + count);
        storage.put_item('signedKeyId', signedKeyId + 1);
        return result;
    }
});

module.exports = AccountManager;
