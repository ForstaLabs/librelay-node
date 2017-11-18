// vim: ts=4:sw=4:expandtab

'use strict';

const ProvisioningCipher = require('./provisioning_cipher');
const WebSocketResource = require('./websocket-resources');
const crypto = require('crypto');
const fetch = require('node-fetch');
const hub = require('./hub');
const libsignal = require('libsignal');
const protobufs = require('./protobufs');
const storage = require('./storage');


const lastResortKeyId = 0xdeadbeef & ((2 ** 31) - 1); // Must fit inside signed 32bit int.
const defaultRegisterURL = 'https://api.forsta.io';


class AccountManager {

    constructor(signal, prekeyLowWater=10, prekeyHighWater=100) {
        this.signal = signal;
        this.preKeyLowWater = prekeyLowWater;  // Add more keys when we get this low.
        this.preKeyHighWater = prekeyHighWater; // Max fill level for prekeys.
    }

    static async factory() {
        const signal = await hub.SignalServer.factory();
        return new this(signal);
    }

    _generateDeviceInfo(identityKeyPair, name) {
        const passwordB64 = crypto.randomBytes(16).toString('base64');
        const password = passwordB64.substring(0, passwordB64.length - 2);
        return {
            name,
            identityKeyPair,
            signalingKey: crypto.randomBytes(32 + 20),
            registrationId: libsignal.KeyHelper.generateRegistrationId(),
            password
        };
    }

    async registerAccount(name='librelay') {
        const identity = libsignal.KeyHelper.generateIdentityKeyPair();
        const devInfo = this._generateDeviceInfo(identity, name);
        const accountInfo = await this.signal.createAccount(devInfo);
        await storage.putState('addr', accountInfo.addr);
        await this.saveDeviceState(accountInfo.addr, accountInfo);
        const keys = await this.generateKeys(this.preKeyHighWater);
        await this.signal.registerKeys(keys);
        await this.registrationDone();
    }

    async registerDevice(name='librelay', setProvisioningUrl, confirmAddress, progressCallback) {
        const returnInterface = {waiting: true};
        const provisioningCipher = new ProvisioningCipher();
        const pubKey = provisioningCipher.getPublicKey();
        let wsr;
        const webSocketWaiter = new Promise((resolve, reject) => {
            const url = this.signal.getProvisioningWebSocketURL();
            wsr = new WebSocketResource(url, {
                keepalive: {path: '/v1/keepalive/provisioning'},
                handleRequest: request => {
                    if (request.path === "/v1/address" && request.verb === "PUT") {
                        const proto = protobufs.ProvisioningUuid.decode(request.body);
                        const uriPubKey = encodeURIComponent(pubKey.toString('base64'));
                        request.respond(200, 'OK');
                        const r = setProvisioningUrl(`tsdevice:/?uuid=${proto.uuid}&pub_key=${uriPubKey}`);
                        if (r instanceof Promise) {
                            r.catch(reject);
                        }
                    } else if (request.path === "/v1/message" && request.verb === "PUT") {
                        const msgEnvelope = protobufs.ProvisionEnvelope.decode(request.body, 'binary');
                        request.respond(200, 'OK');
                        wsr.close();
                        resolve(msgEnvelope);
                    } else {
                        reject(new Error('Unknown websocket message ' + request.path));
                    }
                }
            });
        });
        await wsr.connect();

        returnInterface.done = (async function() {
            const provisionMessage = await provisioningCipher.decrypt(await webSocketWaiter);
            returnInterface.waiting = false;
            await confirmAddress(provisionMessage.addr);
            const devInfo = this._generateDeviceInfo(provisionMessage.identityKeyPair, name);
            await this.signal.addDevice(provisionMessage.provisioningCode,
                                        provisionMessage.addr, devInfo);
            await this.saveDeviceState(provisionMessage.addr, devInfo);
            const keys = await this.generateKeys(this.preKeyHighWater, progressCallback);
            await this.signal.registerKeys(keys);
            await this.registrationDone();
        }).call(this);

        returnInterface.cancel = async function() {
            wsr.close();
            try {
                await webSocketWaiter;
            } catch(e) {
                console.warn("Ignoring web socket error:", e);
            }
        };
        return returnInterface;
    }

    async linkDevice(uuid, pubKey, options) {
        options = options || {};
        const code = await this.signal.getLinkDeviceVerificationCode();
        const ourIdent = await storage.getOurIdentity();
        const pMessage = new protobufs.ProvisionMessage();
        pMessage.identityKeyPrivate = ourIdent.privKey;
        pMessage.addr = await storage.getState('addr');
        pMessage.userAgent = options.userAgent || 'librelay-web';
        pMessage.provisioningCode = code;
        const provisioningCipher = new ProvisioningCipher();
        const pEnvelope = await provisioningCipher.encrypt(pubKey, pMessage);
        const resp = await this.signal.fetch('/v1/provisioning/' + uuid, {
            method: 'PUT',
            json: {
                body: pEnvelope.toString('base64') // XXX probably have to finish()/encode() this thing.
            }
        });
        if (!resp.ok) {
            // 404 means someone else handled it already.
            if (resp.status !== 404) {
                throw new Error(await resp.text());
            }
        }
    }

    

    static async register({token, jwt, url=defaultRegisterURL, name='librelay'}) {
        if (!token && !jwt) {
            throw TypeError("`token` or `jwt` required");
        }
        const authHeader = token ? `Token ${token}` : `JWT ${jwt}`;
        const identityKeyPair = libsignal.KeyHelper.generateIdentityKeyPair();
        const passwordB64 = crypto.randomBytes(16).toString('base64');
        const password = passwordB64.substring(0, passwordB64.length - 2);
        const deviceInfo = {
            name,
            identityKeyPair,
            signalingKey: crypto.randomBytes(32 + 20),
            registrationId: libsignal.KeyHelper.generateRegistrationId(),
            password
        };
        const accountInfo = {
            signalingKey: deviceInfo.signalingKey.toString('base64'),
            supportsSms: false,
            fetchesMessages: true,
            registrationId: deviceInfo.registrationId,
            name,
            password
        };
        const resp = await fetch(url + '/v1/provision/account', {
            method: 'PUT',
            headers: {
                "Authorization": authHeader,
                "Content-Type": 'application/json'
            },
            body: JSON.stringify(accountInfo)
        });
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const respData = await resp.json();
        deviceInfo.addr = respData.userId;
        deviceInfo.deviceId = respData.deviceId;
        deviceInfo.serverUrl = respData.serverUrl;
        deviceInfo.username = `${deviceInfo.addr}.${deviceInfo.deviceId}`;
        const signal = new hub.SignalServer(deviceInfo.serverUrl, deviceInfo.username,
                                            deviceInfo.password);
        const instance = new this(signal);
        await instance.saveDeviceState(deviceInfo);
        const keys = await instance.generateKeys(instance.preKeyHighWater);
        await instance.signal.registerKeys(keys);
        return instance;
    }

    async refreshPreKeys() {
        const preKeyCount = await this.signal.getMyKeys();
        const lastResortKey = await storage.loadPreKey(lastResortKeyId);
        if (preKeyCount <= this.preKeyLowWater || !lastResortKey) {
            // The server replaces existing keys so just go to the hilt.
            console.info("Refreshing pre-keys...");
            const keys = await this.generateKeys(this.preKeyHighWater);
            await this.signal.registerKeys(keys);
        }
    }

    async saveDeviceState(addr, info) {
        await storage.clearSessionStore();
        await storage.removeOurIdentity();
        const stateKeys = [
            'deviceId',
            'name',
            'password',
            'registrationId',
            'serverUrl',
            'signalingKey',
            'username'
        ];
        await Promise.all(stateKeys.map(key => storage.removeState(key)));
        // update our own identity key, which may have changed
        // if we're relinking after a reinstall on the master device
        await storage.removeIdentity(addr);
        await storage.putState('addr', addr);
        await storage.saveIdentity(addr, info.identityKeyPair.pubKey);
        await storage.saveOurIdentity(info.identityKeyPair);
        await Promise.all(stateKeys.map(key => storage.putState(key, info[key])));
    }

    async generateKeys(count, progressCallback) {
        if (typeof progressCallback !== 'function') {
            progressCallback = undefined;
        }
        const startId = await storage.getState('maxPreKeyId') || 1;
        const signedKeyId = await storage.getState('signedKeyId') || 1;

        if (typeof startId != 'number') {
            throw new Error('Invalid maxPreKeyId');
        }
        if (typeof signedKeyId != 'number') {
            throw new Error('Invalid signedKeyId');
        }

        let lastResortKey = await storage.loadPreKey(lastResortKeyId);
        if (!lastResortKey) {
            // Last resort key only used if our prekey pool is drained faster than
            // we refresh it.  This prevents message dropping at the expense of
            // forward secrecy impairment.
            const pk = await libsignal.KeyHelper.generatePreKey(lastResortKeyId);
            await storage.storePreKey(lastResortKeyId, pk.keyPair);
            lastResortKey = pk.keyPair;
        }

        const ourIdent = await storage.getOurIdentity();
        const result = {
            preKeys: [],
            identityKey: ourIdent.pubKey,
            lastResortKey: {
                keyId: lastResortKeyId,
                publicKey: lastResortKey.pubKey
            }
        };

        for (let keyId = startId; keyId < startId + count; ++keyId) {
            const preKey = await libsignal.KeyHelper.generatePreKey(keyId);
            await storage.storePreKey(preKey.keyId, preKey.keyPair);
            result.preKeys.push({
                keyId: preKey.keyId,
                publicKey: preKey.keyPair.pubKey
            });
            if (progressCallback) {
                progressCallback(keyId - startId);
            }
        }

        const sprekey = await libsignal.KeyHelper.generateSignedPreKey(ourIdent, signedKeyId);
        await storage.storeSignedPreKey(sprekey.keyId, sprekey.keyPair);
        result.signedPreKey = {
            keyId: sprekey.keyId,
            publicKey: sprekey.keyPair.pubKey,
            signature: sprekey.signature
        };
        await storage.removeSignedPreKey(signedKeyId - 2);
        await storage.putState('maxPreKeyId', startId + count);
        await storage.putState('signedKeyId', signedKeyId + 1);
        return result;
    }

    async deleteDevice(deviceId) {
        await this.signal.deleteDevice(deviceId);
    }
}

module.exports = AccountManager;
