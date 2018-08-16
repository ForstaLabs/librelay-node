// vim: ts=4:sw=4:expandtab
/** @module */


/** @class */
class RelayError extends Error {}


/** @class */
class UnregisteredUserError extends RelayError {
    constructor(addr, httpError) {
        super(httpError.message);
        this.name = 'UnregisteredUserError';
        this.addr = addr;
        this.code = httpError.code;
        this.stack = httpError.stack;
    }
}


/** @class */
class ProtocolError extends RelayError {
    constructor(code, response) {
        super();
        this.name = 'ProtocolError';
        if (code > 999 || code < 100) {
            code = -1;
        }
        this.code = code;
        this.response = response;
    }
}


/** @class */
class NetworkError extends RelayError {
    constructor(a, b, c) {
        super(a, b, c);
        this.name = 'NetworkError';
    }
}


module.exports = {
    RelayError,
    UnregisteredUserError,
    ProtocolError,
    NetworkError,
};
