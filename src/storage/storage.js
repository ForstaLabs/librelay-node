/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const helpers = require('../helpers.js');
const models = require('./models');

const LocalStorage = require('node-localstorage').LocalStorage;
const localStorage = new LocalStorage('relay.tuples');


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
    get_item,
    put_item,
    remove,
}
