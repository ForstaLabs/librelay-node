/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const redis = require('./redis');


async function put_item(key, value) {
    redis.set("" + key, JSON.stringify(value));
}


async function get_item(key, defaultValue) {
    const value = await redis.get("" + key);
    if (value === null) {
        return defaultValue;
    }
    return JSON.parse(value);
}


async function remove(key) {
    await redis.del("" + key);
}


async function keys(glob_pattern) {
    return await redis.keys(glob_pattern);
}


function shutdown() {
    console.warn("Shutting down storage (redis connection)");
    redis.quit();
}


module.exports = {
    get_item,
    put_item,
    remove,
    shutdown,
    keys
}
