/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const EventEmitter = require('events');
const ProvisioningCipher = require('./provisioning_cipher');
const WebSocketResource = require('./websocket-resources');
const api = require('./api');
const fetch = require('node-fetch');
const helpers = require('./helpers');
const libsignal = require('libsignal');
const node_crypto = require('crypto');
const protobufs = require('./protobufs');
const storage = require('./storage');


class AccountManager extends EventEmitter {

    constructor(url, username, password, prekey_low_water=20,
                prekey_high_water=200) {
        super();
        this.server = new api.RelayServer(url, username, password);
        this.prekey_low_water = prekey_low_water;
        this.prekey_high_water = prekey_high_water;
    }

    static async registerAccount(ccsm_url, ccsm_token, deviceName=null) {
        let password = node_crypto.randomBytes(16).toString('base64');
        password = password.substring(0, password.length - 2);
        const signalingKey = node_crypto.randomBytes(32 + 20).toString('base64');
        const registrationId = libsignal.KeyHelper.generateRegistrationId();
        const request = {
            password,
            signalingKey,
            registrationId,
            deviceName,
            fetchesMessages: true,
            userAgent: 'librelay-node'
        };

        const r = await fetch(ccsm_url + '/v1/provision-proxy/', {
            method: 'PUT',
            headers: {
                "Authorization": 'Token ' + ccsm_token,
                "Content-Type": 'application/json'
            },
            body: JSON.stringify(request)
        });
        const resp = await r.json();
        if (!r.ok) {
            throw new Error(JSON.stringify(resp));
        }

        const identityKeyPair = libsignal.KeyHelper.generateIdentityKeyPair();

        await storage.protocol.clearSessionStore();
        await storage.remove('number_id');
        await storage.remove('device_name');
        await storage.protocol.saveIdentity(resp.userId, identityKeyPair.pubKey);
        await storage.protocol.setLocalIdentityKeyPair(identityKeyPair);
        await storage.put_item('signaling_key', signalingKey);
        await storage.put_item('password', password);
        await storage.put_item('registrationId', registrationId);
        await storage.put_item('serverUrl', resp.serverUrl);
        await storage.user.setNumberAndDeviceId(resp.userId, resp.deviceId, deviceName);
        await storage.put_item('regionCode', 'ZZ');
        await storage.put_item('safety-numbers-approval', false);

        const username = await storage.get_item('number_id');
        const am = new this(resp.serverUrl, username, password);
        const keys = await am.generateKeys(am.prekey_high_water);
        await am.server.registerKeys(keys);
        await storage.put_item('browserRegistrationDoneEver', '');
        await storage.put_item('browserRegistrationDone', '');
        return am;
    }

    async maybeRefreshPreKeys() {
        const available = await this.server.getMyKeys()
        if (available < this.prekey_low_water) {
            console.log('Refilling prekey pool');
            const keys = await this.generateKeys(this.prekey_high_water);
            await this.server.registerKeys(keys);
        }
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
