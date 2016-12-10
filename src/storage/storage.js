/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const helpers = require('../helpers.js');

const LocalStorage = require('node-localstorage').LocalStorage;
const localStorage = new LocalStorage('relay.storage');


function put(key, value) {
    if (value === undefined)
        throw new Error("Tried to store undefined");
    localStorage.setItem("" + key, helpers.jsonThing(value));
}

function get(key, defaultValue) {
    var value = localStorage.getItem("" + key);
    if (value === null)
        return defaultValue;
    return JSON.parse(value);
}

function remove(key) {
    localStorage.removeItem("" + key);
}

module.exports = {
    put,
    get,
    remove,
}
