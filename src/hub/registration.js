// vim: ts=4:sw=4:expandtab

const AtlasClient = require('./atlas');
const ProvisioningCipher = require('../provisioning_cipher');
const SignalClient = require('./signal');
const WebSocketResource = require('../websocket_resource');
const crypto = require('crypto');
const libsignal = require('libsignal');
const os = require('os');
const protobufs = require('../protobufs');
const storage = require('../storage');

function getUsername() {
    try {
        return os.userInfo().username;
    } catch (e) {
        return 'ANONYMOUS';
    }
}
const defaultName = `librelay-node (${getUsername()}@${os.hostname()} [${os.platform()}]`;

function generatePassword() {
    const passwordB64 = crypto.randomBytes(16).toString('base64');
    return passwordB64.substring(0, passwordB64.length - 2);
}

function generateSignalingKey() {
    return crypto.randomBytes(32 + 20);
}

/**
 * Create a new identity key and create or replace the signal account.
 * Note that any existing devices asssociated with your account will be
 * purged as a result of this action.  This should only be used for new
 * accounts or when you need to start over.
 *
 * @param {Object} [options]
 * @param {string} [options.name] - The public name to store in the signal server.
 * @param {AtlasClient} [options.atlasClient]
 */
async function registerAccount(options) {
    options = options || {};
    const atlasClient = options.atlasClient || await AtlasClient.factory();
    const name = options.name || defaultName;
    const registrationId = libsignal.keyhelper.generateRegistrationId();
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
    const identity = libsignal.keyhelper.generateIdentityKeyPair();
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

/**
 * Returned by {@link registerDevice}.
 *
 * @typedef {Object} RegisterDeviceResult
 * @property {Promise} done - Resolves when the registration process has completed.
 * @property {boolean} waiting - True while no auto-provisioning response has been received.
 * @property {function} cancel - Cancel the provision process (async).
 */

/**
 * Register an additional device with an existing signal account.
 *
 * @param {Object} [options]
 * @param {string} [options.name] - The public name to store in the signal server.
 * @param {AtlasClient} [options.atlasClient]
 * @param {boolean} [options.autoProvision=true] - Attempt to use Forsta auto-provisioning.
 *                                                 Requires existing online devices.
 * @param {function} [options.onProvisionReady] - Callback executed when a peer has an provisioning
 *                                                response.  Can be called more than once.
 * @returns {RegisterDeviceResult}
 */
async function registerDevice(options) {
    options = options || {};
    const atlasClient = options.atlasClient || await AtlasClient.factory();
    const accountInfo = await atlasClient.fetch('/v1/provision/account');
    if (!accountInfo.devices.length) {
        console.error("Must use `registerAccount` for first device");
        throw new TypeError("No Account");
    }
    const signalClient = new SignalClient(null, null, accountInfo.serverUrl);
    const autoProvision = options.autoProvision !== false;
    const name = options.name || defaultName;
    if (!options.onProvisionReady && !autoProvision) {
        throw new TypeError("Missing: onProvisionReady callback");
    }
    const returnInterface = {waiting: true};
    const provisioningCipher = new ProvisioningCipher();
    const pubKey = provisioningCipher.getPublicKey().toString('base64');
    let wsr;
    const webSocketWaiter = new Promise((resolve, reject) => {
        wsr = new WebSocketResource(signalClient.getProvisioningWebSocketURL(), {
            keepalive: {path: '/v1/keepalive/provisioning'},
            handleRequest: request => {
                if (request.path === "/v1/address" && request.verb === "PUT") {
                    const proto = protobufs.ProvisioningUuid.decode(request.body);
                    request.respond(200, 'OK');
                    if (autoProvision) {
                        atlasClient.fetch('/v1/provision/request', {
                            method: 'POST',
                            json: {
                                uuid: proto.uuid,
                                key: pubKey
                            }
                        }).catch(reject);
                    }
                    if (options.onProvisionReady) {
                        const r = options.onProvisionReady(proto.uuid, pubKey);
                        if (r instanceof Promise) {
                            r.catch(reject);
                        }
                    }
                } else if (request.path === "/v1/message" && request.verb === "PUT") {
                    const msgEnvelope = protobufs.ProvisionEnvelope.decode(request.body);
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
        if (provisionMessage.addr != accountInfo.userId) {
            throw new Error('Security Violation: Foreign account sent us an identity key!');
        }
        const registrationId = libsignal.keyhelper.generateRegistrationId();
        const password = generatePassword();
        const signalingKey = generateSignalingKey();
        const response = await signalClient.request({
            httpType: 'PUT',
            call: 'devices',
            urlParameters: '/' + provisionMessage.provisioningCode,
            json: {
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
