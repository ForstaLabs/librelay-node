/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');
const helpers = require('./helpers.js');
const WebSocket = require('websocket').w3cwebsocket;


var RelayServer = (function() {

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

    function HTTPError(code, response, stack) {
        if (code > 999 || code < 100) {
            code = -1;
        }
        var e = new Error();
        e.name     = 'HTTPError';
        e.code     = code;
        e.stack    = stack;
        if (response) {
            e.response = response;
        }
        return e;
    }

    var URL_CALLS = {
        accounts   : "/v1/accounts",
        devices    : "/v1/devices",
        keys       : "/v2/keys",
        messages   : "/v1/messages",
        attachment : "/v1/attachments"
    };

    function RelayServer(url, username, password, attachment_server_url) {
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
        if (username !== undefined)
            this.setUsername(username);
        if (password !== undefined)
            this.setPassword(password);
        this.attachment_id_regex = RegExp("^https:\/\/.*\/(\\d+)\?");
        if (attachment_server_url) {
            // strip trailing /
            attachment_server_url = attachment_server_url.replace(/\/$/,'');
            // and escape
            attachment_server_url = attachment_server_url.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            this.attachment_id_regex = RegExp( "^" + attachment_server_url + "\/(\\d+)\?");
        }
    }

    RelayServer.prototype = {

        constructor: RelayServer,

        http: async function(param) {
            if (!param.urlParameters) {
                param.urlParameters = '';
            }
            const config = {
                method: param.httpType,
                url: URL_CALLS[param.call] + param.urlParameters
            };
            console.log(`RelayServer Request: ${param.httpType} ${config.url}`);
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

        requestVerificationSMS: function(number) {
            return this.http({
                call: 'accounts',
                httpType: 'GET',
                urlParameters: '/sms/code/' + number,
            });
        },

        requestVerificationVoice: function(number) {
            return this.http({
                call: 'accounts',
                httpType: 'GET',
                urlParameters: '/voice/code/' + number,
            });
        },

        confirmCode: function(number, code, password, signaling_key, registrationId, deviceName) {
            var jsonData = {
                signalingKey: signaling_key.toString('base64'),
                supportsSms: false,
                fetchesMessages: true,
                registrationId: registrationId,
            };

            var call, urlPrefix, schema;
            if (deviceName) {
                jsonData.name = deviceName;
                call = 'devices';
                urlPrefix = '/';
                schema = { deviceId: 'number' };
            } else {
                call = 'accounts';
                urlPrefix = '/code/';
            }

            const auth = {
                username: number,
                password
            };
            return this.http({
                auth,
                call: call,
                httpType: 'PUT',
                urlParameters: urlPrefix + code,
                jsonData: jsonData,
                validateResponse: schema
            });
        },

        getDevices: function(number) {
            return this.http({
                call: 'devices',
                httpType: 'GET',
            });
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

            // This is just to make the server happy
            // (v2 clients should choke on publicKey)
            keys.lastResortKey = {
                keyId: 0x7fffFFFF,
                publicKey: Buffer.from("42").toString('base64')
            };

            return this.http({
                call: 'keys',
                httpType: 'PUT',
                jsonData: keys,
            });
        },

        getMyKeys: async function(number, deviceId) {
            const resp = await this.http({
                call: 'keys',
                httpType: 'GET',
                validateResponse: {
                    count: 'number'
                }
            });
            return resp.count;
        },

        getKeysForNumber: function(number, deviceId) {
            if (deviceId === undefined)
                deviceId = "*";
            throw new Error("not ported!");

            return this.http({
                call: 'keys',
                httpType: 'GET',
                urlParameters: "/" + number + "/" + deviceId,
                validateResponse: {
                    identityKey: 'string',
                    devices: 'object'
                }
            }).then(function(res) {
                if (res.devices.constructor !== Array) {
                    throw new Error("Invalid response");
                }
                // XXX I don't think we need a lib for this.
                res.identityKey = StringView.base64ToBytes(res.identityKey);
                res.devices.forEach(function(device) {
                    if ( !validateResponse(device, {signedPreKey: 'object', preKey: 'object'}) ||
                         !validateResponse(device.signedPreKey, {publicKey: 'string', signature: 'string'}) ||
                         !validateResponse(device.preKey, {publicKey: 'string'})) {
                        throw new Error("Invalid response");
                    }
                    device.signedPreKey.publicKey = StringView.base64ToBytes(device.signedPreKey.publicKey);
                    device.signedPreKey.signature = StringView.base64ToBytes(device.signedPreKey.signature);
                    device.preKey.publicKey       = StringView.base64ToBytes(device.preKey.publicKey);
                });
                return res;
            });
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

        // XXX Probably not...
        getAttachment: function(id) {
            return this.http({
                call                : 'attachment',
                httpType            : 'GET',
                urlParameters       : '/' + id,
                validateResponse    : {location: 'string'}
            }).then(function(response) {
                var match = response.location.match(this.attachment_id_regex);
                if (!match) {
                    console.log('Invalid attachment url for incoming message', response.location);
                    throw new Error('Received invalid attachment url');
                }
                // XXX not implemented
                return ajax(response.location, {
                    type: "GET",
                    responseType: "arraybuffer",
                    contentType: "application/octet-stream"
                });
            }.bind(this));
        },

        // XXX Probably not...
        putAttachment: function(encryptedBin) {
            return this.http({
                call     : 'attachment',
                httpType : 'GET',
            }).then(function(response) {
                // Extract the id as a string from the location url
                // (workaround for ids too large for Javascript numbers)
                var match = response.location.match(this.attachment_id_regex);
                if (!match) {
                    console.log('Invalid attachment url for outgoing message', response.location);
                    throw new Error('Received invalid attachment url');
                }
                return ajax(response.location, {
                    type: "PUT",
                    contentType: "application/octet-stream",
                    data: encryptedBin,
                    processData: false,
                }).then(function() {
                    return match[1];
                }.bind(this));
            }.bind(this));
        },

        getMessageSocket: function() {
            console.log('Opening message websocket:', this.base_url);
            const url = this.base_url.replace('https://', 'wss://').replace('http://', 'ws://')
                    + '/v1/websocket/?login=' + encodeURIComponent(this._username)
                    + '&password=' + encodeURIComponent(this._password)
                    + '&agent=OWD';
            return new WebSocket(url);
        },

        getProvisioningSocket: function () {
            console.log('Opening provisioning websocket:', this.url);
            return new WebSocket(
                this.base_url.replace('https://', 'wss://').replace('http://', 'ws://')
                    + '/v1/websocket/provisioning/?agent=OWD'
            );
        }
    };

    return RelayServer;
})();


exports.RelayServer = RelayServer;
