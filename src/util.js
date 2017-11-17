/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

function unencodeAddr(number) {
    return number.split(".");
}

const _maxTimeout = 0x7fffffff;  // `setTimeout` max valid value.
async function sleep(seconds) {
    let ms = seconds * 1000;
    while (ms > _maxTimeout) {
        // Support sleeping longer than the javascript max setTimeout...
        await new Promise(resolve => setTimeout(resolve, _maxTimeout));
        ms -= _maxTimeout;
    }
    return await new Promise(resolve => setTimeout(resolve, ms, seconds));
}

async function never() {
    return await new Promise(() => null);
}


module.exports = {
    unencodeAddr,
    sleep,
    never
};

