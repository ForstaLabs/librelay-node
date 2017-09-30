// vim: ts=4:sw=4:expandtab

'use strict';

const api = require('./api');
const libsignal = require('libsignal');
const storage = require('./storage');

const lastResortKeyId = 0xdeadbeef & ((2 ** 31) - 1); // Must fit inside signed 32bit int.


class AccountManager {

    constructor(url, username, password, prekeyLowWater=20, prekeyHighWater=200) {
        this.server = new api.TextSecureServer(url, username, password);
        this.preKeyLowWater = prekeyLowWater;  // Add more keys when we get this low.
        this.preKeyHighWater = prekeyHighWater; // Max fill level for prekeys.
    }

    _generateDeviceInfo(identityKeyPair, name) {
        const passwd = libsignal.crypto.getRandomBytes(16).toString('base64');
        return {
            name,
            identityKeyPair,
            signalingKey: libsignal.crypto.getRandomBytes(32 + 20),
            registrationId: libsignal.KeyHelper.generateRegistrationId(),
            password: passwd.substring(0, passwd.length - 2)
        };
    }

    async registerAccount(authToken, url='https://api.forsta.io', name='librelay') {
        const identity = await libsignal.KeyHelper.generateIdentityKeyPair();
        const devInfo = await this._generateDeviceInfo(identity, name);
        await this.server.createAccount(url, authToken, devInfo);
        await this.saveDeviceState(devInfo);
        const keys = await this.generateKeys(this.preKeyHighWater);
        await this.server.registerKeys(keys);
    }

    async refreshPreKeys() {
        const preKeyCount = await this.server.getMyKeys();
        const lastResortKey = await storage.protocol.loadPreKey(lastResortKeyId);
        if (preKeyCount <= this.preKeyLowWater || !lastResortKey) {
            // The server replaces existing keys so just go to the hilt.
            console.info("Refreshing pre-keys...");
            const keys = await this.generateKeys(this.preKeyHighWater);
            await this.server.registerKeys(keys);
        }
    }

    async saveDeviceState(info) {
        await storage.protocol.clearSessionStore();
        await storage.protocol.removeOurIdentity();
        const wipestate = [
            'addr',
            'deviceId',
            'name',
            'password',
            'registrationId',
            'signalingKey',
            'username',
        ];
        await Promise.all(wipestate.map(key => storage.protocol.removeState(key)));
        // update our own identity key, which may have changed
        // if we're relinking after a reinstall on the master device
        await storage.protocol.removeIdentityKey(info.addr);
        await storage.protocol.saveIdentity(info.addr, info.identityKeyPair.pubKey);
        await storage.protocol.saveOurIdentity(info.identityKeyPair);
        await storage.protocol.putStateDict(info);
    }

    async generateKeys(count, progressCallback) {
        if (typeof progressCallback !== 'function') {
            progressCallback = undefined;
        }
        const startId = await storage.protocol.getState('maxPreKeyId', 1);
        const signedKeyId = await storage.protocol.getState('signedKeyId', 1);

        if (typeof startId != 'number') {
            throw new Error('Invalid maxPreKeyId');
        }
        if (typeof signedKeyId != 'number') {
            throw new Error('Invalid signedKeyId');
        }

        let lastResortKey = await storage.protocol.loadPreKey(lastResortKeyId);
        if (!lastResortKey) {
            // Last resort key only used if our prekey pool is drained faster than
            // we refresh it.  This prevents message dropping at the expense of
            // forward secrecy impairment.
            const pk = await libsignal.KeyHelper.generatePreKey(lastResortKeyId);
            await storage.protocol.storePreKey(lastResortKeyId, pk.keyPair);
            lastResortKey = pk.keyPair;
        }

        const ourIdent = await storage.protocol.getOurIdentity();
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
            await storage.protocol.storePreKey(preKey.keyId, preKey.keyPair);
            result.preKeys.push({
                keyId: preKey.keyId,
                publicKey: preKey.keyPair.pubKey
            });
            if (progressCallback) {
                progressCallback(keyId - startId);
            }
        }

        const sprekey = await libsignal.KeyHelper.generateSignedPreKey(ourIdent, signedKeyId);
        await storage.protocol.storeSignedPreKey(sprekey.keyId, sprekey.keyPair);
        result.signedPreKey = {
            keyId: sprekey.keyId,
            publicKey: sprekey.keyPair.pubKey,
            signature: sprekey.signature
        };

        await storage.protocol.removeSignedPreKey(signedKeyId - 2);
        await storage.protocol.putStateDict({
            maxPreKeyId: startId + count,
            signedKeyId: signedKeyId + 1
        });
        return result;
    }
}

module.exports = AccountManager;
