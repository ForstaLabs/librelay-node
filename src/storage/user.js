/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const storage = require('./storage.js');
const helpers = require('../helpers.js');

const user = {
    setNumberAndDeviceId: function(number, deviceId, deviceName) {
        storage.put("number_id", number + "." + deviceId);
        if (deviceName) {
            storage.put("device_name", deviceName);
        }
    },

    getNumber: function(key, defaultValue) {
        var number_id = storage.get("number_id");
        if (number_id === undefined)
            return undefined;
        return helpers.unencodeNumber(number_id)[0];
    },

    getDeviceId: function(key) {
        var number_id = storage.get("number_id");
        if (number_id === undefined)
            return undefined;
        return helpers.unencodeNumber(number_id)[1];
    },

    getDeviceName: function(key) {
        return storage.get("device_name");
    }
};

module.exports = user;
