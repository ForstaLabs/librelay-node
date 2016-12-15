/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';


module.exports = {
    unencodeNumber: function(number) {
        return number.split(".");
    },

    isNumberSane: function(number) {
        return number[0] == "+" && /^[0-9]+$/.test(number.substring(1));
    }
};

