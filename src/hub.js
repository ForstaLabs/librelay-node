// vim: ts=4:sw=4:expandtab

'use strict';

const errors = require('./errors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const storage = require('./storage');
const util = require('./util');


let _atlasUrl = 'https://api.forsta.io';

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


class SignalServer {

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
        const path = SIGNAL_URL_CALLS[param.call] + param.urlParameters;
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

function atobJWT(str) {
    /* See: https://github.com/yourkarma/JWT/issues/8 */
    return Buffer.from(str.replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString('binary');
}



async function getAtlasConfig() {
    return await storage.getState('atlasConfig');
}

async function setAtlasConfig(data) {
    await storage.putState('atlasConfig', data);
}

const getAtlasUrl = () => _atlasUrl;

const setAtlasUrl = url => _atlasUrl = url;

function decodeAtlasToken(encoded_token) {
    let token;
    try {
        const parts = encoded_token.split('.').map(atobJWT);
        token = {
            header: JSON.parse(parts[0]),
            payload: JSON.parse(parts[1]),
            secret: parts[2]
        };
    } catch(e) {
        throw new Error('Invalid Token');
    }
    if (!token.payload || !token.payload.exp) {
        throw TypeError("Invalid Token");
    }
    if (token.payload.exp * 1000 <= Date.now()) {
        throw Error("Expired Token");
    }
    return token;
}

async function getEncodedAtlasToken() {
    const config = await getAtlasConfig();
    if (!config || !config.API || !config.API.TOKEN) {
        throw ReferenceError("No Token Found");
    }
    return config.API.TOKEN;
}

async function updateEncodedAtlasToken(encodedToken) {
    const config = await getAtlasConfig();
    if (!config || !config.API || !config.API.TOKEN) {
        throw ReferenceError("No Token Found");
    }
    config.API.TOKEN = encodedToken;
    await setAtlasConfig(config);
}

async function getAtlasToken() {
    return decodeAtlasToken(await getEncodedAtlasToken());
}

async function fetchAtlas(urn, options) {
    options = options || {};
    options.headers = options.headers || new fetch.Headers();
    try {
        const encodedToken = await getEncodedAtlasToken();
        options.headers.set('Authorization', `JWT ${encodedToken}`);
    } catch(e) {
        /* Almost certainly will blow up soon (via 400s), but lets not assume
         * all API access requires auth regardless. */
        console.warn("Auth token missing or invalid", e);
    }
    options.headers.set('Content-Type', 'application/json; charset=utf-8');
    if (options.json) {
        options.body = JSON.stringify(options.json);
    }
    const url = [getAtlasUrl(), urn.replace(/^\//, '')].join('/');
    const resp = await fetch(url, options);
    if (!resp.ok) {
        const msg = urn + ` (${await resp.text()})`;
        let error;
        if (resp.status === 404) {
             error = new ReferenceError(msg);
        } else {
            error = new Error(msg);
        }
        error.code = resp.status;
        throw error;
    }
    return await resp.json();
}

async function maintainAtlasToken(forceRefresh, onRefresh) {
    /* Manage auth token expiration.  This routine will reschedule itself as needed. */
    let token = await getAtlasToken();
    const refreshDelay = t => (t.payload.exp - (Date.now() / 1000)) / 2;
    if (forceRefresh || refreshDelay(token) < 1) {
        const encodedToken = await getEncodedAtlasToken();
        const resp = await fetchAtlas('/v1/api-token-refresh/', {
            method: 'POST',
            json: {token: encodedToken}
        });
        if (!resp || !resp.token) {
            throw new TypeError("Token Refresh Error");
        }
        await updateEncodedAtlasToken(resp.token);
        console.info("Refreshed auth token");
        token = await getAtlasToken();
        if (onRefresh) {
            try {
                await onRefresh(token);
            } catch(e) {
                console.error('onRefresh callback error:', e);
            }
        }
    }
    const nextUpdate = refreshDelay(token);
    console.info('Will recheck auth token in ' + nextUpdate + ' seconds');
    util.sleep(nextUpdate).then(maintainAtlasToken);
}

async function resolveTags(expression) {
    expression = expression && expression.trim();
    if (!expression) {
        console.warn("Empty expression detected");
        // Do this while the server doesn't handle empty queries.
        return {
            universal: '',
            pretty: '',
            includedTagids: [],
            excludedTagids: [],
            userids: [],
            warnings: []
        };
    }
    const q = '?expression=' + encodeURIComponent(expression);
    const results = await fetchAtlas('/v1/directory/user/' + q);
    for (const w of results.warnings) {
        w.context = expression.substring(w.position, w.position + w.length);
    }
    if (results.warnings.length) {
        console.warn("Tag Expression Warning(s):", expression, results.warnings);
    }
    return results;
}

function sanitizeTags(expression) {
    /* Clean up tags a bit. Add @ where needed.
     * NOTE: This does not currently support universal format! */
    const tagSplitRe = /([\s()^&+-]+)/;
    const tags = [];
    for (let tag of expression.trim().split(tagSplitRe)) {
        if (!tag) {
            continue;
        } else if (tag.match(/^[a-zA-Z]/)) {
            tag = '@' + tag;
        }
        tags.push(tag);
    }
    return tags.join(' ');
}

async function getUsers(userIds) {
    const missing = [];
    const users = [];
    await Promise.all(userIds.map(id => (async function() {
        try {
            users.push(await fetchAtlas(`/v1/user/${id}/`));
        } catch(e) {
            if (!(e instanceof ReferenceError)) {
                throw e;
            }
            missing.push(id);
        }
    })()));
    if (missing.length) {
        const query = '?id_in=' + missing.join(',');
        const resp = await fetchAtlas('/v1/directory/user/' + query);
        for (const user of resp.results) {
            users.push(user);
        }
    }
    return users;
}

async function getDevices() {
    try {
        return (await fetchAtlas('/v1/provision/account')).devices;
    } catch(e) {
        if (e instanceof ReferenceError) {
            return undefined;
        } else {
            throw e;
        }
    }
}

module.exports = {
    SignalServer,
    getAtlasConfig,
    setAtlasConfig,
    getAtlasUrl,
    setAtlasUrl,
    decodeAtlasToken,
    getEncodedAtlasToken,
    updateEncodedAtlasToken,
    getAtlasToken,
    fetchAtlas,
    maintainAtlasToken,
    resolveTags,
    sanitizeTags,
    getUsers,
    getDevices,
};
