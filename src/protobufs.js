'use strict';

const ByteBuffer = require('bytebuffer');
const ProtoBuf = require('protobufjs');

function loadProtoBufs(filename) {
    const b = ProtoBuf.loadProtoFile('./protos/' + filename);
    return b.build('textsecure');
}

const proto_files = [
    'IncomingPushMessageSignal.proto',
    'SubProtocol.proto',
    'DeviceMessages.proto'
];

for (const f of proto_files) {
    const p = loadProtoBufs(f);
    for (const message in p) {
        exports[message] = p[message];
    }
}
