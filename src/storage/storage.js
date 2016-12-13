/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const helpers = require('../helpers.js');
const models = require('./models');

const LocalStorage = require('node-localstorage').LocalStorage;
const localStorage = new LocalStorage('relay.tuples');

var items = new models.ItemCollection();

function put(key, value) {
    throw new Error("BAD API, use Item directly or some shit");
    if (value === undefined)
        throw new Error("Tried to store undefined");
    console.log('Storage PUT', key, value);
    if (key == 'identityKey') {
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
        console.log("DID IT", key, value);
    }
    localStorage.setItem("" + key, helpers.jsonThing(value)); // XXX . needs to use backbone I guess
    const item = items.add({id: key, value: value}, {merge: true});
    item.save();
    throw new Error("check file results");

}

function get(key, defaultValue) {
    throw new Error("BAD API, use Item directly or some shit");
    console.log('Storage GET', key);
    var item = items.get("" + key);
    console.log('what is item?', item);
    // XXX must use backbone
    //var value = localStorage.getItem("" + key);
    if (item === undefined)
        return defaultValue;
    return item.get('value');
}

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


function remove(key) {
    throw new Error("BAD API, use Item directly or some shit");
    console.log('Storage REMOVE', key);
    // XXX USE backbone only.. remove after validate
    //localStorage.removeItem("" + key);
    var item = items.get("" + key);
    if (item) {
        items.remove(item);
        item.destroy();
    }
}

function remove_item(key) {
    console.log('Storage REMOVE ITEM', key);
    localStorage.removeItem("" + key);
}

// XXX may need to call?
function fetch() {
    throw new Error("BAD API, use Item directly or some shit");
    console.log("XXX items.fetch  figure out proper init for this.");
    return new Promise(function(resolve) {
        items.fetch({reset: true}).fail(function() {
            console.log('Failed to fetch from storage');
        }).always(resolve);
    });
}

module.exports = {
    put,
    get,
    remove,
    fetch,
    put_item,
    get_item,
    put_arraybuffer,
    get_arraybuffer,
    remove_item
}
