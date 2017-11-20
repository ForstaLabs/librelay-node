// vim: ts=4:sw=4:expandtab

'use strict';

const AtlasClient = require('./atlas');
const ProvisioningCipher = require('../provisioning_cipher');
const SignalClient = require('./signal');
const WebSocketResource = require('../websocket_resource');
const crypto = require('crypto');
const libsignal = require('libsiganl');
const protobufs = require('../protobufs');
const storage = require('../storage');


let defaultName = 'librelay';

function generatePassword() {
    const passwordB64 = crypto.randomBytes(16).toString('base64');
    return passwordB64.substring(0, passwordB64.length - 2);
}

function generateSignalingKey() {
    return crypto.randomBytes(32 + 20);
}

async function registerAccount({atlasClient, name=defaultName}) {
    if (!atlasClient) {
        atlasClient = await AtlasClient.factory();
    }
    const registrationId = libsignal.KeyHelper.generateRegistrationId();
    const password = generatePassword();
    const signalingKey = generateSignalingKey();
    const response = await atlasClient.fetch('/v1/provision/account', {
        method: 'PUT',
        json: {
            signalingKey: signalingKey.toString('base64'),
            supportsSms: false,
            fetchesMessages: true,
            registrationId,
            name,
            password
        }
    });
    const addr = response.userId;
    const username = `${addr}.${response.deviceId}`;
    const identity = libsignal.KeyHelper.generateIdentityKeyPair();
    await storage.clearSessionStore();
    await storage.removeOurIdentity();
    await storage.removeIdentity(addr);
    await storage.saveIdentity(addr, identity.pubKey);
    await storage.saveOurIdentity(identity);
    await storage.putState('addr', addr);
    await storage.putState('serverUrl', response.serverUrl);
    await storage.putState('deviceId', response.deviceId);
    await storage.putState('name', name);
    await storage.putState('username', username);
    await storage.putState('password', password);
    await storage.putState('registrationId', registrationId);
    await storage.putState('signalingKey', signalingKey);
    const sc = new SignalClient(username, password, response.serverUrl);
    await sc.registerKeys(await sc.generateKeys());
}

/* TODO: Make atlas API for this so the init/auth are the same as registerAccount */
async function registerDevice({
    signalClient,
    name=defaultName,
    setProvisioningUrl,
    confirmAddress
}) {
    if (!setProvisioningUrl) {
        throw new TypeError("Missing: setProvisioningUrl callback");
    }
    if (!confirmAddress) {
        throw new TypeError("Missing: confirmAddress callback");
    }
    if (!signalClient) {
        signalClient = new SignalClient();
    }
    const returnInterface = {waiting: true};
    const provisioningCipher = new ProvisioningCipher();
    const pubKey = provisioningCipher.getPublicKey();
    let wsr;
    const webSocketWaiter = new Promise((resolve, reject) => {
        wsr = new WebSocketResource(signalClient.getProvisionWebSocketURL(), {
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

    returnInterface.done = (async () => {
        const provisionMessage = await provisioningCipher.decrypt(await webSocketWaiter);
        returnInterface.waiting = false;
        const addr = provisionMessage.addr;
        const identity = provisionMessage.identityKeyPair;
        await confirmAddress(provisionMessage.addr);
        const registrationId = libsignal.KeyHelper.generateRegistrationId();
        const password = generatePassword();
        const signalingKey = generateSignalingKey();
        const response = await signalClient.request({
            httpType: 'PUT',
            call: 'devices',
            urlParameters: '/' + provisionMessage.provisioningCode,
            jsonData: {
                signalingKey: signalingKey.toString('base64'),
                supportsSms: false,
                fetchesMessages: true,
                registrationId,
                name
            },
            username: addr,
            password,
            validateResponse: {deviceId: 'number'}
        });
        const username = `${addr}.${response.deviceId}`;
        await storage.clearSessionStore();
        await storage.removeOurIdentity();
        await storage.removeIdentity(addr);
        await storage.saveIdentity(addr, identity.pubKey);
        await storage.saveOurIdentity(identity);
        await storage.putState('addr', addr);
        await storage.putState('serverUrl', signalClient.url);
        await storage.putState('deviceId', response.deviceId);
        await storage.putState('name', name);
        await storage.putState('username', username);
        await storage.putState('password', password);
        await storage.putState('registrationId', registrationId);
        await storage.putState('signalingKey', signalingKey);
        const authedClient = new SignalClient(username, password, signalClient.url);
        await authedClient.registerKeys(await authedClient.generateKeys());
    })();

    returnInterface.cancel = async () => {
        wsr.close();
        try {
            await webSocketWaiter;
        } catch(e) {
            console.warn("Ignoring web socket error:", e);
        }
    };
    return returnInterface;
}

module.exports = {
    registerAccount,
    registerDevice
};

