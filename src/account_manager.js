/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const EventEmitter = require('events');
const ProvisioningCipher = require('./provisioning_cipher');
const WebSocketResource = require('./websocket-resources');
const api = require('./api');
const helpers = require('./helpers');
const libsignal = require('libsignal');
const node_crypto = require('crypto');
const protobufs = require('./protobufs');
const storage = require('./storage');


class AccountManager extends EventEmitter {

    constructor(url, username, password) {
        super();
        this.server = new api.RelayServer(url, username, password);
    }

    requestVoiceVerification(number) {
        return this.server.requestVerificationVoice(number);
    }

    requestSMSVerification(number) {
        return this.server.requestVerificationSMS(number);
    }

    async registerSingleDevice(number, verificationCode) {
        const identityKeyPair = libsignal.KeyHelper.generateIdentityKeyPair();
        await this.createAccount(number, verificationCode, identityKeyPair);
        const keys = await this.generateKeys(100);
        await this.server.registerKeys(keys);
    }

    registerSecondDevice(setProvisioningUrl, confirmNumber) {
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
                                encodeURIComponent(storage.array_buffer_encode(pubKey, 'base64')) // XXX validate
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
    }

    async refreshPreKeys() {
        if (this.server.getMyKeys() < 10) {
            const keys = await generateKeys(100);
            await this.server.registerKeys(keys);
        }
    }

    async createAccount(number, verificationCode, identityKeyPair, deviceName) {
        var signalingKey = node_crypto.randomBytes(32 + 20);
        var password = node_crypto.randomBytes(16).toString('base64');
        password = password.substring(0, password.length - 2);
        var registrationId = libsignal.KeyHelper.generateRegistrationId();

        const resp = await this.server.confirmCode(number, verificationCode,
                                                   password, signalingKey,
                                                   registrationId, deviceName);
        storage.protocol.clearSessionStore();
        await storage.remove('number_id');
        await storage.remove('device_name');
        await storage.protocol.saveIdentity(number, identityKeyPair.pubKey);
        await storage.protocol.setLocalIdentityKeyPair(identityKeyPair);
        await storage.put_item('signaling_key', signalingKey.toString('base64'));
        await storage.put_item('password', password);
        await storage.put_item('registrationId', registrationId);
        await storage.user.setNumberAndDeviceId(number, resp.deviceId || 1, deviceName);
        await storage.put_item('regionCode', 'ZZ');
        this.server.setUsername(await storage.get_item('number_id'));
        this.server.setPassword(password);
    }

    async generateKeys(count) {
        const startId = await storage.get_item('maxPreKeyId', 1);
        const signedKeyId = await storage.get_item('signedKeyId', 1);
        if (typeof startId != 'number') {
            throw new Error(`Invalid maxPreKeyId: ${startId} ${typeof startId}`);
        }
        if (typeof signedKeyId != 'number') {
            throw new Error(`Invalid signedKeyId: ${signedKeyId} ${typeof signedKeyId}`);
        }
        const identityKey = await storage.protocol.getLocalIdentityKeyPair();
        const result = {
            preKeys: [],
            identityKey: identityKey.pubKey
        };
        for (var keyId = startId; keyId < startId+count; ++keyId) {
            console.log("Generating key:", keyId);
            let k = libsignal.KeyHelper.generatePreKey(keyId);
            await storage.protocol.storePreKey(k.keyId, k.keyPair);
            result.preKeys.push({
                keyId: k.keyId,
                publicKey: k.keyPair.pubKey
            });
        }
        const spk = libsignal.KeyHelper.generateSignedPreKey(identityKey, signedKeyId);
        await storage.protocol.storeSignedPreKey(spk.keyId, spk.keyPair);
        result.signedPreKey = {
            keyId     : spk.keyId,
            publicKey : spk.keyPair.pubKey,
            signature : spk.signature
        };
        await storage.protocol.removeSignedPreKey(signedKeyId - 2);
        await storage.put_item('maxPreKeyId', startId + count);
        await storage.put_item('signedKeyId', signedKeyId + 1);
        return result;
    }
}

module.exports = AccountManager;
