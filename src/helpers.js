/*
 * vim: ts=4:sw=4:expandtab
 */

/*********************************
 *** Type conversion utilities ***
 *********************************/
// Strings/arrays
//TODO: Throw all this shit in favor of consistent types

const ByteBuffer = require('bytebuffer');

const StaticByteBufferProto = new ByteBuffer().__proto__;
const StaticArrayBufferProto = new ArrayBuffer().__proto__;
const StaticUint8ArrayProto = new Uint8Array().__proto__;

function getString(thing) {
    if (thing === Object(thing)) {
        if (thing.__proto__ == StaticUint8ArrayProto) {
            return String.fromCharCode.apply(null, thing);
        } else if (thing.__proto__ == StaticArrayBufferProto) {
            return getString(new Uint8Array(thing));
        } else if (thing.__proto__ == StaticByteBufferProto) {
            return thing.toString("binary");
        }
    }
    return thing;
}

function getStringable(thing) {
    return (typeof thing == "string" || typeof thing == "number" || typeof thing == "boolean" ||
            (thing === Object(thing) &&
                (thing.__proto__ == StaticArrayBufferProto ||
                thing.__proto__ == StaticUint8ArrayProto ||
                thing.__proto__ == StaticByteBufferProto)));
}

/**************************
 *** JSON'ing Utilities ***
 **************************/
function ensureStringed(thing) {
    if (getStringable(thing))
        return getString(thing);
    else if (thing instanceof Array) {
        var res = [];
        for (var i = 0; i < thing.length; i++)
            res[i] = ensureStringed(thing[i]);
        return res;
    } else if (thing === Object(thing)) {
        var res = {};
        for (var key in thing)
            res[key] = ensureStringed(thing[key]);
        return res;
    } else if (thing === null) {
        return null;
    }
    throw new Error("unsure of how to jsonify object of type " + typeof thing);
}

// Number formatting utils
module.exports = {
    unencodeNumber: function(number) {
        return number.split(".");
    },

    isNumberSane: function(number) {
        return number[0] == "+" &&
            /^[0-9]+$/.test(number.substring(1));
    },

    jsonThing: function(thing) {
        return JSON.stringify(ensureStringed(thing));
    },

    getString,

    getStringable
};

