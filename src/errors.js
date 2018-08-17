// vim: ts=4:sw=4:expandtab
/** @module */


/**
 * Base class for all librelay errors.
 */
class RelayError extends Error {}


/**
 * Thrown when trying to communicate with an invalid user.
 *
 * @extends {module:errors~RelayError}
 */
class UnregisteredUserError extends RelayError {
    constructor(addr, httpError) {
        super(httpError.message);
        this.name = 'UnregisteredUserError';
        this.addr = addr;
        this.code = httpError.code;
        this.stack = httpError.stack;
    }
}


/**
 * Protocol errors come from the Signal or Atlas service.  They are request problems
 * and not communication issues.
 *
 * @extends {module:errors~RelayError}
 */
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


/**
 * Represents a connectivity issue.
 *
 * @extends {module:errors~RelayError}
 */
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
