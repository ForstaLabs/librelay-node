// vim: ts=4:sw=4:expandtab

'use strict';

const TextSecureServer = require('./textsecure_server');
const crypto = require('crypto');
const fetch = require('node-fetch');
const libsignal = require('libsignal');
const storage = require('./storage');

const lastResortKeyId = 0xdeadbeef & ((2 ** 31) - 1); // Must fit inside signed 32bit int.
const defaultRegisterURL = 'https://ccsm-dev-api.forsta.io';


class AccountManager {

    constructor(textSecureServer, prekeyLowWater=10, prekeyHighWater=100) {
        this.tss = textSecureServer;
        this.preKeyLowWater = prekeyLowWater;  // Add more keys when we get this low.
        this.preKeyHighWater = prekeyHighWater; // Max fill level for prekeys.
    }

    static async factory() {
        const tss = await TextSecureServer.factory();
        return new this(tss);
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
        const resp = await fetch(url + '/v1/provision-proxy/', {
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
        const instance = new this(deviceInfo.serverUrl, deviceInfo.username, deviceInfo.password);
        await instance.saveDeviceState(deviceInfo);
        const keys = await instance.generateKeys(instance.preKeyHighWater);
        await instance.tss.registerKeys(keys);
        return instance;
    }

    async refreshPreKeys() {
        const preKeyCount = await this.tss.getMyKeys();
        const lastResortKey = await storage.loadPreKey(lastResortKeyId);
        if (preKeyCount <= this.preKeyLowWater || !lastResortKey) {
            // The server replaces existing keys so just go to the hilt.
            console.info("Refreshing pre-keys...");
            const keys = await this.generateKeys(this.preKeyHighWater);
            await this.tss.registerKeys(keys);
        }
    }

    async saveDeviceState(info) {
        await storage.clearSessionStore();
        await storage.removeOurIdentity();
        const state = [
            'addr',
            'deviceId',
            'name',
            'password',
            'registrationId',
            'serverUrl',
            'signalingKey',
            'username'
        ];
        await Promise.all(state.map(k => storage.removeState(k)));
        // update our own identity key, which may have changed
        // if we're relinking after a reinstall on the master device
        await storage.removeIdentityKey(info.addr);
        await storage.saveIdentity(info.addr, info.identityKeyPair.pubKey);
        await storage.saveOurIdentity(info.identityKeyPair);
        await Promise.all(state.map(k => storage.putState(k, info[k])));
    }

    async generateKeys(count, progressCallback) {
        if (typeof progressCallback !== 'function') {
            progressCallback = undefined;
        }
        const startId = await storage.getState('maxPreKeyId', 1);
        const signedKeyId = await storage.getState('signedKeyId', 1);

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
        await storage.putStateDict({
            maxPreKeyId: startId + count,
            signedKeyId: signedKeyId + 1
        });
        return result;
    }
}

module.exports = AccountManager;
