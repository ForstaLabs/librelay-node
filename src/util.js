// vim: ts=4:sw=4:expandtab

/**
 * @module
 */
const readline = require('readline');

function unencodeAddr(addr) {
    const tuple = addr.split(".");
    if (tuple.length > 2) {
        throw new TypeError("Invalid address format");
    }
    if (tuple[1]) {
        tuple[1] = parseInt(tuple[1]);
    }
    return tuple;
}


const _maxTimeout = 0x7fffffff;  // `setTimeout` max valid value.
/**
 * Sleep for N seconds.
 *
 * @param {number} seconds
 */
async function sleep(seconds) {
    let ms = seconds * 1000;
    while (ms > _maxTimeout) {
        // Support sleeping longer than the javascript max setTimeout...
        await new Promise(resolve => setTimeout(resolve, _maxTimeout));
        ms -= _maxTimeout;
    }
    return await new Promise(resolve => setTimeout(resolve, ms, seconds));
}


/**
 * Never resolve
 */
async function never() {
    return await new Promise(() => null);
}


/**
 * Interactive prompt for string input on the console/tty.
 * @param {string} prompt - Message to display to user as prompt.
 * @returns {string} User inputted text.
 */
async function consoleInput(prompt) {
    /* This simplifies authentication for a lot of use cases. */
    const rl = readline.createInterface(process.stdin, process.stdout);
    try { 
         return await new Promise(resolve => rl.question(prompt, resolve));
    } finally {
        rl.close();
    }   
}   


module.exports = {
    unencodeAddr,
    sleep,
    never,
    consoleInput
};
