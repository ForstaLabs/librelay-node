/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');


var TextSecureServer = (function() {

    function validateResponse(response, schema) {
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

    var URL_CALLS = {
        accounts   : "/v1/accounts",
        devices    : "/v1/devices",
        keys       : "/v2/keys",
        messages   : "/v1/messages",
        attachment : "/v1/attachments"
    };

    function TextSecureServer(url, username, password) {
        if (typeof url !== 'string') {
            throw new Error('Invalid server url');
        }
        this._http = axios.create({
            baseURL: url,
            timeout: 30000,
            agent: {
                httpAgent: new http.Agent({keepAlive: true}),
                httpsAgent: new https.Agent({keepAlive: true})
            },
            headers: {
                'Connection': 'keep-alive',
                'Content-Type': 'application/json'
            }
        });
        this.base_url = url;
        if (username !== undefined) {
            this.setUsername(username);
        }
        if (password !== undefined) {
            this.setPassword(password);
        }
        this.attachment_id_regex = RegExp("^https://.*/(\\d+)?");
    }

    TextSecureServer.prototype = {

        constructor: TextSecureServer,

        http: async function(param) {
            if (!param.urlParameters) {
                param.urlParameters = '';
            }
            const config = {
                method: param.httpType,
                url: URL_CALLS[param.call] + param.urlParameters
            };
            console.log(`TextSecureServer Request: ${param.httpType} ${config.url}`);
            if (param.jsonData !== undefined) {
                config.data = param.jsonData;
            }
            if (param.auth !== undefined) {
                config.auth = param.auth;
            }
            const resp = await this._http(config);
            if (param.validateResponse &&
                !validateResponse(resp.data, param.validateResponse)) {
                throw new Error(`Invalid server response for: ${param.call}`);
            }
            return resp.data;
        },

        createAccount: async function(url, authToken, info) {
            const accountInfo = {
                signalingKey: info.signalingKey.toString('base64'),
                supportsSms: false,
                fetchesMessages: true,
                registrationId: info.registrationId,
                name: info.name,
                password: info.password
            };
            const resp = await axios.put(url, {
                headers: {"Authorization": `Token ${authToken}`},
                data: accountInfo
            });
            Object.assign(info, resp.data);
            /* Save the new creds to our instance for future TSS API calls. */
            this.username = info.username = `${info.addr}.${info.deviceId}`;
            this.password = info.password;
            return info;
        },

        setUsername: function(username) {
            if (!this._http.defaults.auth) {
                this._http.defaults.auth = {};
            }
            this._http.defaults.auth.username = username;
            this._username = username;
        },

        setPassword: function(password) {
            if (!this._http.defaults.auth) {
                this._http.defaults.auth = {};
            }
            this._http.defaults.auth.password = password;
            this._password = password;
        },

        getDevices: async function() {
            const data = await this.http({
                call: 'devices',
                httpType: 'GET',
            });
            return data && data.devices;
        },

        registerKeys: function(genKeys) {
            var keys = {};
            keys.identityKey = genKeys.identityKey.toString('base64');
            keys.signedPreKey = {
                keyId: genKeys.signedPreKey.keyId,
                publicKey: genKeys.signedPreKey.publicKey.toString('base64'),
                signature: genKeys.signedPreKey.signature.toString('base64')
            };

            keys.preKeys = [];
            var j = 0;
            for (var i in genKeys.preKeys) {
                keys.preKeys[j++] = {
                    keyId: genKeys.preKeys[i].keyId,
                    publicKey: genKeys.preKeys[i].publicKey.toString('base64')
                };
            }
            // Newer generation servers don't expect this BTW.
            keys.lastResortKey = {
                keyId: genKeys.lastResortKey.keyId,
                publicKey: genKeys.lastResortKey.publicKey.toString('base64')
            };
            return this.http({
                call: 'keys',
                httpType: 'PUT',
                jsonData: keys,
            });
        },

        getMyKeys: async function() {
            const resp = await this.http({
                call: 'keys',
                httpType: 'GET',
                validateResponse: {
                    count: 'number'
                }
            });
            return resp.count;
        },

        getKeysForAddr: async function(addr, deviceId) {
            if (deviceId === undefined) {
                deviceId = "*";
            }
            const res = await this.http({
                call: 'keys',
                httpType: 'GET',
                urlParameters: "/" + addr + "/" + deviceId,
                validateResponse: {identityKey: 'string', devices: 'object'}
            });
            if (res.devices.constructor !== Array) {
                throw new TypeError("Invalid response");
            }
            res.identityKey = Buffer.from(res.identityKey, 'base64');
            res.devices.forEach(device => {
                if (!validateResponse(device, {signedPreKey: 'object', preKey: 'object'}) ||
                    !validateResponse(device.signedPreKey, {publicKey: 'string', signature: 'string'}) ||
                    !validateResponse(device.preKey, {publicKey: 'string'})) {
                    throw new TypeError("Invalid response");
                }
                device.signedPreKey.publicKey = Buffer.from(device.signedPreKey.publicKey, 'base64');
                device.signedPreKey.signature = Buffer.from(device.signedPreKey.signature, 'base64');
                device.preKey.publicKey = Buffer.from(device.preKey.publicKey, 'base64');
            });
            return res;
        },

        sendMessages: function(destination, messageArray, timestamp) {
            var jsonData = { messages: messageArray, timestamp: timestamp};

            return this.http({
                call                : 'messages',
                httpType            : 'PUT',
                urlParameters       : '/' + destination,
                jsonData            : jsonData,
            });
        },

        getAttachment: async function(id) {
            const response = await this.http({
                call: 'attachment',
                httpType: 'GET',
                urlParameters: '/' + id,
                validateResponse: {
                    location: 'string'
                }
            });
            const match = response.location.match(this.attachment_id_regex);
            if (!match) {
                throw new Error(`Invalid attachment URL: ${response.location}`);
            }
            const resp = await axios.get(response.location, {
                responseType: 'arraybuffer', // NOTE: Actually becomes a Buffer.
                headers: {
                    "Content-Type": "application/octet-stream" // XXX suspect..
                }
            });
            return resp.data;
        },

        putAttachment: async function(data) {
            // XXX Build in retry handling...
            const ptrResp = await this.http({call: 'attachment', httpType: 'GET'});
            // Extract the id as a string from the location url
            // (workaround for ids too large for Javascript numbers)
            //  XXX find way around having to know the S3 url.
            const match = ptrResp.location.match(this.attachment_id_regex);
            if (!match) {
                console.error('Invalid attachment url for outgoing message',
                              ptrResp.location);
                throw new TypeError('Received invalid attachment url');
            }
            await axios.put(ptrResp.location, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                },
                data
            });
            return match[1];
        },

        getMessageWebSocketURL: function() {
            return [
                this.base_url.replace('https://', 'wss://').replace('http://', 'ws://'),
                '/v1/websocket/?login=', encodeURIComponent(this._username),
                '&password=', encodeURIComponent(this._password)].join('');
        },

        getProvisioningWebSocketURL: function () {
            return this.base_url.replace('https://', 'wss://').replace('http://', 'ws://') +
                                    '/v1/websocket/provisioning/';
        }
    };

    return TextSecureServer;
})();


exports.TextSecureServer = TextSecureServer;
