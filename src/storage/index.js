// vim: ts=4:sw=4:expandtab

'use strict';

const storage = require('./storage.js');
for (const x of Object.keys(storage)) {
    module.exports[x] = storage[x];
}

module.exports.protocol = require('./protocol.js');
