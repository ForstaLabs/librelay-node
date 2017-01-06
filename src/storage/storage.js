/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const redis = require('./redis');


async function put_item(key, value) {
    console.log('Storage PUT ITEM', key, value);
    redis.set("" + key, JSON.stringify(value));
}

async function get_item(key, defaultValue) {
    console.log('Storage GET ITEM', key);
    const value = await redis.get("" + key);
    console.log('Got VALUE:', value);
    if (value === null) {
        return defaultValue;
    }
    return JSON.parse(value);
}

async function remove(key) {
    console.log('Storage REMOVE ITEM', key);
    await redis.del("" + key);
}

module.exports = {
    get_item,
    put_item,
    remove,
}
