// vim: ts=4:sw=4:expandtab

'use strict';

const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const errors = require('./errors');
const storage = require('./storage');

const URL_CALLS = {
    accounts: "/v1/accounts",
    devices: "/v1/devices",
    keys: "/v2/keys",
    messages: "/v1/messages",
    attachment: "/v1/attachments"
};

const HTTP_MESSAGES = {
    401: "Invalid authentication or invalidated registration",
    403: "Invalid code",
    404: "Address is not registered",
    413: "Server rate limit exceeded",
    417: "Address already registered"
};


class TextSecureServer {

    constructor(url, username, password) {
        if (typeof url !== 'string') {
            throw new TypeError("Invalid URL: " + url);
        }
        if (url.startsWith('https://')) {
            this._httpAgent = new https.Agent({keepAlive: true});
        } else if (url.startsWith('http://')) {
            this._httpAgent = new http.Agent({keepAlive: true});
        } else {
            throw new TypeError("Invalid URL: " + url);
        }
        this.url = url;
        this.username = username;
        this.password = password;
        this.attachment_id_regex = RegExp("^https://.*/(\\d+)?");
    }

    static async factory() {
        const url = await storage.getState('serverUrl');
        const username = await storage.getState('username');
        const password = await storage.getState('password');
        return new this(url, username, password);
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
        const path = URL_CALLS[param.call] + param.urlParameters;
        const headers = new fetch.Headers();
        if (param.username && param.password) {
            headers.set('Authorization', this.authHeader(param.username, param.password));
        }
        let resp;
        try {
            resp = await this.fetch(path, {
                method: param.httpType || 'GET',
                json: param.jsonData,
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
            if (HTTP_MESSAGES.hasOwnProperty(e.code)) {
                e.message = HTTP_MESSAGES[e.code];
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

    async fetch(urn, options) {
        /* Thin wrapper around global.fetch to augment json and auth support. */
        options = options || {};
        options.headers = options.headers || new fetch.Headers();
        options.headers.set('Connection', 'keep-alive');
        options.agent = this._httpAgent;
        if (!options.headers.has('Authorization')) {
            if (this.username && this.password) {
                options.headers.set('Authorization', this.authHeader(this.username, this.password));
            }
        }
        const body = options.json && JSON.stringify(options.json);
        if (body) {
            options.headers.set('Content-Type', 'application/json; charset=utf-8');
            options.body = body;
        }
        return await fetch(`${this.url}/${urn.replace(/^\//, '')}`, options);
    }

    async getDevices() {
        const data = await this.request({call: 'devices'});
        return data && data.devices;
    }

    async registerKeys(genKeys) {
        var jsonData = {};
        jsonData.identityKey = genKeys.identityKey.toString('base64');
        jsonData.signedPreKey = {
            keyId: genKeys.signedPreKey.keyId,
            publicKey: genKeys.signedPreKey.publicKey.toString('base64'),
            signature: genKeys.signedPreKey.signature.toString('base64')
        };
        jsonData.preKeys = [];
        var j = 0;
        for (var i in genKeys.preKeys) {
            jsonData.preKeys[j++] = {
                keyId: genKeys.preKeys[i].keyId,
                publicKey: genKeys.preKeys[i].publicKey.toString('base64')
            };
        }
        // Newer generation servers don't expect this BTW.
        jsonData.lastResortKey = {
            keyId: genKeys.lastResortKey.keyId,
            publicKey: genKeys.lastResortKey.publicKey.toString('base64')
        };
        return await this.request({
            call: 'keys',
            httpType: 'PUT',
            jsonData
        });
    }

    async getMyKeys() {
        const res = await this.request({
            call: 'keys',
            validateResponse: {count: 'number'}
        });
        return res.count;
    }

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
        res.devices.forEach(device => {
            if (!this.validateResponse(device, {signedPreKey: 'object', preKey: 'object'}) ||
                !this.validateResponse(device.signedPreKey, {publicKey: 'string', signature: 'string'}) ||
                !this.validateResponse(device.preKey, {publicKey: 'string'})) {
                throw new TypeError("Invalid response");
            }
            device.signedPreKey.publicKey = Buffer.from(device.signedPreKey.publicKey, 'base64');
            device.signedPreKey.signature = Buffer.from(device.signedPreKey.signature, 'base64');
            device.preKey.publicKey = Buffer.from(device.preKey.publicKey, 'base64');
        });
        return res;
    }

    async sendMessages(destination, messages, timestamp) {
        return await this.request({
            call: 'messages',
            httpType: 'PUT',
            urlParameters: '/' + destination,
            jsonData: {messages, timestamp}
        });
    }

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

    async putAttachment(body) {
        // XXX Build in retry handling...
        const ptrResp = await this.request({call: 'attachment'});
        // Extract the id as a string from the location url
        // (workaround for ids too large for Javascript numbers)
        //  XXX find way around having to know the S3 url.
        const match = ptrResp.location.match(this.attachment_id_regex);
        if (!match) {
            console.error('Invalid attachment url for outgoing message',
                          ptrResp.location);
            throw new TypeError('Received invalid attachment url');
        }
        const headers = new fetch.Headers({
            'Content-Type': 'application/octet-stream',
        });
        const dataResp = await fetch(ptrResp.location, {
            method: "PUT",
            headers,
            body
        });
        if (!dataResp.ok) {
            const msg = await dataResp.text();
            console.error("Upload attachement error:", msg);
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

    async getLinkDeviceVerificationCode() {
        const data = await this.request({
            call: 'devices',
            urlParameters: '/provisioning/code'
        });
        return data && data.verificationCode;
    }

    /* The GCM reg ID configures the data needed for the PushServer to wake us up
     * if this page is not active.  I.e. from our ServiceWorker. */
    async updateGcmRegistrationId(gcm_reg_id) {
        return await this.request({
            call: 'accounts',
            httpType: 'PUT',
            urlParameters: '/gcm',
            jsonData: {
                gcmRegistrationId: gcm_reg_id
            }
        });
    }
}

module.exports = TextSecureServer;
