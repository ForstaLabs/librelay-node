'use strict';

const protobuf = require('protobufjs');


const proto_files = [
    'IncomingPushMessageSignal.proto',
    'SubProtocol.proto',
    'DeviceMessages.proto'
];

for (const f of proto_files) {
    const p = protobuf.loadSync(`./protos/${f}`).lookup('textsecure');
    for (const message in p.nested) {
        exports[message] = p.lookup(message);
    }
}
