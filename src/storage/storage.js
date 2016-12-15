/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const helpers = require('../helpers.js');
const models = require('./models');

const LocalStorage = require('node-localstorage').LocalStorage;
const localStorage = new LocalStorage('relay.tuples');


function array_buffer_encode(value, codec) {
    throw new Error("DEPRECATED");
    console.warn("XXX: ARRAY BUFFERS ARE DANGEROUS!");
    if (!(value instanceof ArrayBuffer)) {
        throw new Error(`Invalid type for: ${value}`);
    }
    const buf = new Buffer(new Uint8Array(value));
    return buf.toString(codec || 'binary');
}

function array_buffer_decode(raw, codec) {
    throw new Error("DEPRECATED");
    console.warn("XXX: ARRAY BUFFERS ARE DANGEROUS!");
    const buf = new Buffer(raw, codec || 'binary');
    return Uint8Array.from(buf).buffer;
}


function put_arraybuffer(key, value) {
    throw new Error("DEPRECATED");
    console.log('Storage PUT ARRAYBUFFER', key, value);
    localStorage.setItem("" + key, array_buffer_encode(value));
}

function get_arraybuffer(key) {
    throw new Error("DEPRECATED");
    console.log('Storage GET ARRAYBUFFER', key);
    const raw = localStorage.getItem("" + key);
    return array_buffer_decode(raw);
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

function remove(key) {
    console.log('Storage REMOVE ITEM', key);
    localStorage.removeItem("" + key);
}

module.exports = {
    array_buffer_decode,
    array_buffer_encode,
    get_arraybuffer,
    get_item,
    put_arraybuffer,
    put_item,
    remove,
}
