/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const storage = require('./storage.js');
const helpers = require('../helpers.js');

const user = {
    setNumberAndDeviceId: async function(number, deviceId, deviceName) {
        await storage.put_item("number_id", number + "." + deviceId);
        if (deviceName) {
            await storage.put_item("device_name", deviceName);
        }
    },

    getNumber: async function(key, defaultValue) {
        var number_id = await storage.get_item("number_id");
        if (number_id === undefined)
            return undefined;
        return helpers.unencodeNumber(number_id)[0];
    },

    getDeviceId: async function(key) {
        var number_id = await storage.get_item("number_id");
        if (number_id === undefined)
            return undefined;
        return helpers.unencodeNumber(number_id)[1];
    },

    getDeviceName: async function(key) {
        return await storage.get_item("device_name");
    }
};

module.exports = user;
