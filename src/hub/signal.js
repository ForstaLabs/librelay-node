// vim: ts=4:sw=4:expandtab

const ProvisioningCipher = require('../provisioning_cipher');
const errors = require('../errors');
const fetch = require('./fetch');
const libsignal = require('libsignal');
const protobufs = require('../protobufs');
const storage = require('../storage');

const SIGNAL_URL_CALLS = {
    accounts: "/v1/accounts",
    devices: "/v1/devices",
    keys: "/v2/keys",
    messages: "/v1/messages",
    attachment: "/v1/attachments"
};

const SIGNAL_HTTP_MESSAGES = {
    401: "Invalid authentication or invalidated registration",
    403: "Invalid code",
    404: "Address is not registered",
    413: "Server rate limit exceeded",
    417: "Address already registered"
};


/**
 * Interface with the Signal server.  The signal server handles the exchange
 * of encrypted messages and brokering of public keys.
 */
class SignalClient {

    constructor(username, password, url) {
        this.url = url;
        this.username = username;
        this.password = password;
        this.attachment_id_regex = RegExp("^https?://.*/(\\d+)?");
    }

    /**
     * Return a default instance.
     */
    static async factory() {
        const url = await storage.getState('serverUrl');
        const username = await storage.getState('username');
        const password = await storage.getState('password');
        return new this(username, password, url);
    }

    /**
     * Respond positively to a provision request from a new foreign device.
     * WARNING: This will send your private identity key to the requesting
     * device!
     *
     * @param {string} uuid - UUID param provided by the foreign device.
     * @param {string} pubKey - Ephemeral public key used for provisioning.
     * @param {Object} [options]
     * @param {string} [options.userAgent]
     */
    async linkDevice(uuid, pubKey, options) {
        options = options || {};
        const provisionResp = await this.request({
            call: 'devices',
            urlParameters: '/provisioning/code'
        });
        const ourIdent = await storage.getOurIdentity();
        const pMessage = new protobufs.ProvisionMessage();
        pMessage.identityKeyPrivate = ourIdent.privKey;
        pMessage.addr = await storage.getState('addr');
        pMessage.userAgent = options.userAgent || 'librelay-web';
        pMessage.provisioningCode = provisionResp.verificationCode;
        const provisioningCipher = new ProvisioningCipher();
        const pEnvelope = await provisioningCipher.encrypt(pubKey, pMessage);
        const resp = await this.fetch('/v1/provisioning/' + uuid, {
            method: 'PUT',
            json: {
                body: pEnvelope.toString('base64')
            }
        });
        if (!resp.ok) {
            // 404 means someone else handled it already.
            if (resp.status !== 404) {
                throw new Error(await resp.text());
            }
        }
    }

    /**
     * Generate a new signed prekey and pool of prekeys if needed.
     * If new keys are generated they are uploaded to the signal service
     * so they can be used for new incoming messages.
     *
     * @param {number} [minLevel=10] - If less then this many keys are
     *                                 available then generate new keys.
     * @param {number} [fill=100] - The number of new keys to generate when
     *                              needed.
     */
    async refreshPreKeys(minLevel=10, fill=100) {
        const preKeyCount = await this.getMyKeys();
        if (preKeyCount <= minLevel) {
            // The server replaces existing keys so just go to the hilt.
            console.info("Refreshing pre-keys...");
            await this.registerKeys(await this.generateKeys(fill));
        }
    }

    async generateKeys(count=100, progressCallback) {
        if (typeof progressCallback !== 'function') {
            progressCallback = undefined;
        }
        const startId = await storage.getState('maxPreKeyId') || 1;
        if (typeof startId !== 'number') {
            throw new Error('Invalid maxPreKeyId');
        }
        const signedKeyId = await storage.getState('signedKeyId') || 1;
        if (typeof signedKeyId !== 'number') {
            throw new Error('Invalid signedKeyId');
        }
        const ourIdent = await storage.getOurIdentity();
        const result = {
            preKeys: [],
            identityKey: ourIdent.pubKey
        };
        for (let keyId = startId; keyId < startId + count; ++keyId) {
            const preKey = libsignal.keyhelper.generatePreKey(keyId);
            await storage.storePreKey(preKey.keyId, preKey.keyPair);
            result.preKeys.push({
                keyId: preKey.keyId,
                publicKey: preKey.keyPair.pubKey
            });
            if (progressCallback) {
                progressCallback(keyId - startId);
            }
        }
        const sprekey = await libsignal.keyhelper.generateSignedPreKey(ourIdent, signedKeyId);
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

    authHeader(username, password) {
        const token = Buffer.from(username + ':' + password).toString('base64');
        return 'Basic ' + token;
    }

    validateResponse(response, schema) {
        try {
            for (var i in schema) {
                switch (schema[i]) {
                    case 'object':
                    case 'string':
                    case 'number':
                        if (typeof response[i] !== schema[i]) {
                            return false;
                        }
                        break;
                }
            }
        } catch(ex) {
            return false;
        }
        return true;
    }

    async request(param) {
        if (!param.urlParameters) {
            param.urlParameters = '';
        }
        const path = SIGNAL_URL_CALLS[param.call] + param.urlParameters;
        const headers = new fetch.Headers();
        if (param.username && param.password) {
            headers.set('Authorization', this.authHeader(param.username, param.password));
        }
        let resp;
        try {
            resp = await this.fetch(path, {
                method: param.httpType || 'GET',
                json: param.json,
                headers
            });
        } catch(e) {
            /* Fetch throws a very boring TypeError, throw something better.. */
            throw new errors.NetworkError(`${e.message}: ${param.call}`);
        }
        let resp_content;
        if ((resp.headers.get('content-type') || '').startsWith('application/json')) {
            resp_content = await resp.json();
        } else {
            resp_content = await resp.text();
        }
        if (!resp.ok) {
            const e = new errors.ProtocolError(resp.status, resp_content);
            if (SIGNAL_HTTP_MESSAGES.hasOwnProperty(e.code)) {
                e.message = SIGNAL_HTTP_MESSAGES[e.code];
            } else {
                e.message = `Status code: ${e.code}`;
            }
            throw e;
        }
        if (resp.status !== 204) {
            if (param.validateResponse &&
                !this.validateResponse(resp_content, param.validateResponse)) {
                throw new errors.ProtocolError(resp.status, resp_content);
            }
            return resp_content;
        }
    }

    /**
     * Authenticated fetch to the signal service.
     *
     * @param {string} urn
     * @param {Object} [options]
     * @returns {*} - Data response from service.
     */
    async fetch(urn, options) {
        /* Thin wrapper to augment json and auth support. */
        options = options || {};
        options.headers = options.headers || new fetch.Headers();
        if (!options.headers.has('Authorization')) {
            if (this.username && this.password) {
                options.headers.set('Authorization', this.authHeader(this.username, this.password));
            }
        }
        return await fetch(`${this.url}/${urn.replace(/^\//, '')}`, options);
    }

    /**
     * Fetch the current list of known devices associated with your account.
     *
     * @returns {Array} - Array of device info objects.
     */
    async getDevices() {
        const data = await this.request({call: 'devices'});
        return data && data.devices;
    }

    async registerKeys(genKeys) {
        const json = {};
        json.identityKey = genKeys.identityKey.toString('base64');
        json.signedPreKey = {
            keyId: genKeys.signedPreKey.keyId,
            publicKey: genKeys.signedPreKey.publicKey.toString('base64'),
            signature: genKeys.signedPreKey.signature.toString('base64')
        };
        json.preKeys = [];
        var j = 0;
        for (var i in genKeys.preKeys) {
            json.preKeys[j++] = {
                keyId: genKeys.preKeys[i].keyId,
                publicKey: genKeys.preKeys[i].publicKey.toString('base64')
            };
        }
        return await this.request({
            call: 'keys',
            httpType: 'PUT',
            json
        });
    }

    async getMyKeys() {
        const res = await this.request({
            call: 'keys',
            validateResponse: {count: 'number'}
        });
        return res.count;
    }

    /**
     * Get a public prekey and signed prekey for a peer.
     *
     * @param {string} addr
     * @param {number} deviceId
     * @returns {Object} - Key material object.
     */
    async getKeysForAddr(addr, deviceId) {
        if (deviceId === undefined) {
            deviceId = "*";
        }
        const res = await this.request({
            call: 'keys',
            urlParameters: "/" + addr + "/" + deviceId,
            validateResponse: {identityKey: 'string', devices: 'object'}
        });
        if (res.devices.constructor !== Array) {
            throw new TypeError("Invalid response");
        }
        res.identityKey = Buffer.from(res.identityKey, 'base64');
        for (const device of res.devices) {
            if (!this.validateResponse(device, {signedPreKey: 'object'}) ||
                !this.validateResponse(device.signedPreKey, {publicKey: 'string', signature: 'string'})) {
                throw new TypeError("Invalid signedPreKey");
            }
            if (device.preKey) {
                if (!this.validateResponse(device, {preKey: 'object'}) ||
                    !this.validateResponse(device.preKey, {publicKey: 'string'})) {
                    throw new TypeError("Invalid preKey");
                }
                device.preKey.publicKey = Buffer.from(device.preKey.publicKey, 'base64');
            }
            device.signedPreKey.publicKey = Buffer.from(device.signedPreKey.publicKey, 'base64');
            device.signedPreKey.signature = Buffer.from(device.signedPreKey.signature, 'base64');
        }
        return res;
    }

    /**
     * Transmit encrypted messages to the signal service.
     *
     * @param {string} destination - Address of peer
     * @param {Array} messages - Array of encrypted messages
     * @param {number} timestamp - Official timestamp for these messages.
     */
    async sendMessages(destination, messages, timestamp) {
        return await this.request({
            call: 'messages',
            httpType: 'PUT',
            urlParameters: '/' + destination,
            json: {
                messages,
                timestamp
            }
        });
    }

    /**
     * Transmit a single encrytped message to the signal service.
     * Use this when sending a message to just 1 peer device.
     *
     * @param {string} addr
     * @param {number} deviceId
     * @param {Object} message - Encrypted message
     */
    async sendMessage(addr, deviceId, message) {
        return await this.request({
            call: 'messages',
            httpType: 'PUT',
            urlParameters: `/${addr}/${deviceId}`,
            json: message
        });
    }

    /**
     * Download an encrypted attachment.
     *
     * @param {string} id - The remote ID to fetch.
     * @returns {Buffer} - The encrypted attachment.
     */
    async getAttachment(id) {
        // XXX Build in retry handling...
        const response = await this.request({
            call: 'attachment',
            urlParameters: '/' + id,
            validateResponse: {location: 'string'}
        });
        const headers = new fetch.Headers({
            'Content-Type': 'application/octet-stream',
        });
        const attachment = await fetch(response.location, {headers});
        if (!attachment.ok) {
            const msg = await attachment.text();
            console.error("Download attachement error:", msg);
            throw new Error('Download Attachment Error: ' + msg);
        }
        return await attachment.buffer();
    }

    /**
     * Upload an encrypted attachment.
     *
     * @param {Buffer} - Encrypted attachment data.
     * @returns {string} - The ID for this remote attachment.
     */
    async putAttachment(body) {
        // XXX Build in retry handling...
        const ptrResp = await this.request({call: 'attachment'});
        // Extract the id as a string from the location url
        // (workaround for ids too large for Javascript numbers)
        const match = ptrResp.location.match(this.attachment_id_regex);
        if (!match) {
            console.error('Invalid attachment url for outgoing message',
                          ptrResp.location);
            throw new TypeError('Received invalid attachment url');
        }
        const headers = new fetch.Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.byteLength  // See: https://github.com/bitinn/node-fetch/issues/47
        });
        const dataResp = await fetch(ptrResp.location, {
            method: "PUT",
            headers,
            body
        });
        if (!dataResp.ok) {
            const msg = await dataResp.text();
            console.error("Upload attachment error:", msg);
            throw new Error('Upload Attachment Error: ' + msg);
        }
        return match[1];
    }

    getMessageWebSocketURL() {
        return [
            this.url.replace('https://', 'wss://').replace('http://', 'ws://'),
            '/v1/websocket/?login=', encodeURIComponent(this.username),
            '&password=', encodeURIComponent(this.password)].join('');
    }

    getProvisioningWebSocketURL () {
        return this.url.replace('https://', 'wss://').replace('http://', 'ws://') +
                                '/v1/websocket/provisioning/';
    }

    /**
     * The GCM reg ID configures the data needed to wake us up using google cloud messaging
     * service.  No data other than a "wakeup" is sent through this service.
     *
     * @param {string} gcmRegistrationId
     */
    async updateGcmRegistrationId(gcmRegistrationId) {
        return await this.request({
            call: 'accounts',
            httpType: 'PUT',
            urlParameters: '/gcm',
            json: {gcmRegistrationId}
        });
    }
}

module.exports = SignalClient;
