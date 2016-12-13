/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const helpers = require('../helpers.js');
const models = require('./models');

const LocalStorage = require('node-localstorage').LocalStorage;
const localStorage = new LocalStorage('relay.tuples');

function put_arraybuffer(key, value) {
    console.log('Storage PUT ARRAYBUFFER', key, value);
    if (!(value instanceof ArrayBuffer)) {
        throw new Error(`Invalid type: ${key} ${value}`);
    }
    const buf = new Buffer(new Uint8Array(value));
    localStorage.setItem("" + key, buf.toString('binary'));
}

function get_arraybuffer(key) {
    console.log('Storage GET ARRAYBUFFER', key);
    const value = localStorage.getItem("" + key);
    const buf = new Buffer(value, 'binary');
    return (new Uint8Array(buf)).buffer;
}

function put_item(key, value) {
    console.log('Storage PUT ITEM', key, value);
    localStorage.setItem("" + key, JSON.stringify(value));
}

function get_item(key, defaultValue) {
    console.log('Storage GET ITEM', key);
    const value = localStorage.getItem("" + key);
    if (value === null)
        return defaultValue;
    return JSON.parse(value);
}

function remove_item(key) {
    console.log('Storage REMOVE ITEM', key);
    localStorage.removeItem("" + key);
}

module.exports = {
    put_item,
    get_item,
    put_arraybuffer,
    get_arraybuffer,
    remove_item
}
