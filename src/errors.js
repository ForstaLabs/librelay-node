/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

var registeredFunctions = {};
var Type = {
    ENCRYPT_MESSAGE: 1,
    INIT_SESSION: 2,
    TRANSMIT_MESSAGE: 3,
    REBUILD_MESSAGE: 4,
};
exports.replay = {
    Type: Type,
    registerFunction: function(func, functionCode) {
        registeredFunctions[functionCode] = func;
    }
};

function ReplayableError(options) {
    options = options || {};
    this.name         = options.name || 'ReplayableError';
    this.functionCode = options.functionCode;
    this.args         = options.args;
}
ReplayableError.prototype = new Error();
ReplayableError.prototype.constructor = ReplayableError;

ReplayableError.prototype.replay = function() {
    return registeredFunctions[this.functionCode].apply(null, this.args);
};

function IncomingIdentityKeyError(addr, message, key) {
    ReplayableError.call(this, {
        functionCode : Type.INIT_SESSION,
        args         : [addr, message]

    });
    this.addr = addr.split('.')[0];
    this.name = 'IncomingIdentityKeyError';
    this.message = "The identity of " + this.addr + " has changed.";
    this.identityKey = key;
}
IncomingIdentityKeyError.prototype = new ReplayableError();
IncomingIdentityKeyError.prototype.constructor = IncomingIdentityKeyError;

function OutgoingIdentityKeyError(addr, message, timestamp, identityKey) {
    ReplayableError.call(this, {
        functionCode : Type.ENCRYPT_MESSAGE,
        args         : [addr, message, timestamp]
    });
    this.addr = addr.split('.')[0];
    this.name = 'OutgoingIdentityKeyError';
    this.message = "The identity of " + this.addr + " has changed.";
    this.identityKey = identityKey;
}
OutgoingIdentityKeyError.prototype = new ReplayableError();
OutgoingIdentityKeyError.prototype.constructor = OutgoingIdentityKeyError;

function OutgoingMessageError(addr, message, timestamp, httpError) {
    ReplayableError.call(this, {
        functionCode : Type.ENCRYPT_MESSAGE,
        args         : [addr, message, timestamp]
    });
    this.name = 'OutgoingMessageError';
    if (httpError) {
        this.code = httpError.code;
        this.message = httpError.message;
        this.stack = httpError.stack;
    }
}
OutgoingMessageError.prototype = new ReplayableError();
OutgoingMessageError.prototype.constructor = OutgoingMessageError;

function SendMessageNetworkError(addr, jsonData, httpError, timestamp) {
    ReplayableError.call(this, {
        functionCode : Type.TRANSMIT_MESSAGE,
        args         : [addr, jsonData, timestamp]
    });
    this.name = 'SendMessageNetworkError';
    this.addr = addr;
    this.code = httpError.code;
    this.message = httpError.message;
    this.stack = httpError.stack;
}
SendMessageNetworkError.prototype = new ReplayableError();
SendMessageNetworkError.prototype.constructor = SendMessageNetworkError;

function MessageError(message, httpError) {
    ReplayableError.call(this, {
        functionCode : Type.REBUILD_MESSAGE,
        args         : [message]
    });
    this.name = 'MessageError';
    this.code = httpError.code;
    this.message = httpError.message;
    this.stack = httpError.stack;
}
MessageError.prototype = new ReplayableError();
MessageError.prototype.constructor = MessageError;

function UnregisteredUserError(addr, httpError) {
    this.name = 'UnregisteredUserError';
    this.addr = addr;
    this.code = httpError.code;
    this.message = httpError.message;
    this.stack = httpError.stack;
}
UnregisteredUserError.prototype = new Error();
UnregisteredUserError.prototype.constructor = UnregisteredUserError;

exports.UnregisteredUserError = UnregisteredUserError;
exports.SendMessageNetworkError = SendMessageNetworkError;
exports.IncomingIdentityKeyError = IncomingIdentityKeyError;
exports.OutgoingIdentityKeyError = OutgoingIdentityKeyError;
exports.ReplayableError = ReplayableError;
exports.OutgoingMessageError = OutgoingMessageError;
exports.MessageError = MessageError;
