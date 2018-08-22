// vim: ts=4:sw=4:expandtab

const errors = require('./errors.js');
const libsignal = require('libsignal');
const protobufs = require('./protobufs');
const storage = require('./storage');
const util = require('./util');


/**
 * Event indicating that a message was successfully sent to a specific peer.
 * Note that this does not indicate the peer has read or even receieved the
 * message, but instead that the server has indicated that it will enqueue
 * this message for delivery to them.
 *
 * @event OutgoingMessage#sent
 * @property {number} timestamp
 * @property {EncodedUserAddress} addr
 */

/**
 * An error occured while attempting send to a specific peer.
 *
 * @event OutgoingMessage#error
 * @property {number} timestamp
 * @property {Error} error
 */

/**
 * A peers identity key has changed.
 *
 * @event OutgoingMessage#keychange
 */


/**
 * An event bus for activity related to outgoing messages.  These objects
 * are created and returned from the {@link MessageSender}.  Typical interfacing
 * is done via event listeners.
 *
 * @fires OutgoingMessage#sent
 * @fires OutgoingMessage#error
 * @fires OutgoingMessage#keychange
 * @property {Object} message - The message protocol buffer.
 * @property {number} timestamp - The offical sent timestamp for this message.
 * @property {OutgoingMessage#sent[]} sent - Array of {@link OutgoingMessage#sent} events.
 * @property {OutgoingMessage#errors[]} errors - Array of {@link OutgoingMessage#errors} events.
 * @property {number} created - Creation timestamp.
 */
class OutgoingMessage {

    constructor(signal, timestamp, message) {
        this.signal = signal;
        this.timestamp = timestamp;
        this.message = message;
        this.sent = [];
        this.errors = [];
        this.created = Date.now();
        this._listeners = {};
    }

    /**
     * Add event listener.
     *
     * @param {string} event
     * @param {function} callback
     */
    on(event, callback) {
        let handlers = this._listeners[event];
        if (!handlers) {
            handlers = this._listeners[event] = [];
        }
        handlers.push(callback);
    }

    async _getOurAddr() {
        if (this._ourAddr === undefined) {
            this._ourAddr = await storage.getState('addr');
        }
        return this._ourAddr;
    }

    async _getOurDeviceId() {
        if (this._ourDeviceId === undefined) {
            this._ourDeviceId = await storage.getState('deviceId');
        }
        return this._ourDeviceId;
    }

    async _emit(event) {
        const handlers = this._listeners[event];
        if (!handlers) {
            return;
        }
        const args = Array.from(arguments).slice(1);
        for (const callback of handlers) {
            try {
                await callback.apply(this, args);
            } catch(e) {
                console.error("Event callback error:", e);
            }
        }
    }

    async _emitError(addr, reason, error) {
        error.addr = addr;
        error.reason = reason;
        const entry = {
            timestamp: Date.now(),
            error
        };
        this.errors.push(entry);
        await this._emit('error', entry);
    }

    async _emitSent(addr) {
        const entry = {
            timestamp: Date.now(),
            addr
        };
        this.sent.push(entry);
        await this._emit('sent', entry);
    }

    async _handleIdentityKeyError(e, options) {
        options = options || {};
        if (!(e instanceof libsignal.UntrustedIdentityKeyError)) {
            throw new TypeError("UntrustedIdentityKeyError required");
        }
        if (!options.forceThrow) {
            await this._emit('keychange', e);
        }
        if (!e.accepted) {
            throw e;
        }
    }

    async _getKeysForAddr(addr, updateDevices, reentrant) {
        const _this = this;
        const isSelf = addr === await this._getOurAddr();
        const ourDeviceId = isSelf ? await this._getOurDeviceId() : null;
        async function handleResult(response) {
            await Promise.all(response.devices.map(async device => {
                if (isSelf && device.deviceId === ourDeviceId) {
                    console.debug("Skipping prekey processing for self");
                    return;
                }
                device.identityKey = response.identityKey;
                const address = new libsignal.ProtocolAddress(addr, device.deviceId);
                const builder = new libsignal.SessionBuilder(storage, address);
                try {
                    await builder.initOutgoing(device);
                } catch(e) {
                    if (e instanceof libsignal.UntrustedIdentityKeyError) {
                        await _this._handleIdentityKeyError(e, {forceThrow: reentrant});
                        await _this._getKeysForAddr(addr, updateDevices, /*reentrant*/ true);
                    } else {
                        throw e;
                    }
                }
            }));
        }
        if (!updateDevices) {
            try {
                await handleResult(await this.signal.getKeysForAddr(addr));
            } catch(e) {
                if (e instanceof errors.ProtocolError && e.code === 404) {
                    console.warn("Unregistered address (no devices):", addr);
                    await this._removeDeviceIdsForAddr(addr);
                } else {
                    throw e;
                }
            }
        } else {
            await Promise.all(updateDevices.map(async device => {
                try {
                    await handleResult(await _this.signal.getKeysForAddr(addr, device));
                } catch(e) {
                    if (e instanceof errors.ProtocolError && e.code === 404) {
                        console.warn("Unregistered device:", device);
                        await this._removeDeviceIdsForAddr(addr, [device]);
                    } else {
                        throw e;
                    }
                }
            }));
        }
    }

    async _sendMessages(addr, messages, timestamp) {
        try {
            return await this.signal.sendMessages(addr, messages, timestamp);
        } catch(e) {
            if (e instanceof errors.ProtocolError && e.code === 404) {
                throw new errors.UnregisteredUserError(addr, e);
            }
            throw e;
        }
    }

    _getPaddedMessageLength(messageLength) {
        const messageLengthWithTerminator = messageLength + 1;
        let messagePartCount = Math.floor(messageLengthWithTerminator / 160);
        if (messageLengthWithTerminator % 160 !== 0) {
            messagePartCount++;
        }
        return messagePartCount * 160;
    }

    _getPaddedMessageBuffer() {
        let mBuf = protobufs.Content.encode(this.message).finish();
        const padded = new Buffer(this._getPaddedMessageLength(mBuf.byteLength + 1) - 1);
        padded.set(mBuf);
        padded[mBuf.byteLength] = 0x80;
        return padded;
    }

    async _sendToAddr(addr, recurse) {
        const deviceIds = await storage.getDeviceIds(addr);
        const paddedMessage = this._getPaddedMessageBuffer();
        let messages;
        let attempts = 0;
        const ciphers = {};
        do {
            try {
                messages = await Promise.all(deviceIds.map(async id => {
                    const address = new libsignal.ProtocolAddress(addr, id);
                    const sessionCipher = new libsignal.SessionCipher(storage, address);
                    ciphers[address.deviceId] = sessionCipher;
                    return this._toJSON(address, await sessionCipher.encrypt(paddedMessage));
                }));
            } catch(e) {
                if (e instanceof libsignal.UntrustedIdentityKeyError) {
                    await this._handleIdentityKeyError(e, {forceThrow: !!attempts});
                } else {
                    this._emitError(addr, "Failed to create message", e);
                    return;
                }
            }
        } while(!messages && !attempts++);
        try {
            await this._sendMessages(addr, messages, this.timestamp);
        } catch(e) {
            if (e instanceof errors.ProtocolError && (e.code === 410 || e.code === 409)) {
                if (!recurse) {
                    this._emitError(addr, "Hit retry limit attempting to reload device list", e);
                    return;
                }
                if (e.code === 409) {
                    await this._removeDeviceIdsForAddr(addr, e.response.extraDevices);
                } else {
                    await Promise.all(e.response.staleDevices.map(x => ciphers[x].closeOpenSession()));
                }
                const resetDevices = e.code === 410 ? e.response.staleDevices :
                                                      e.response.missingDevices;
                // Optimize first-contact key lookup (just get them all at once).
                const updateDevices = messages.length ? resetDevices : undefined;
                await this._getKeysForAddr(addr, updateDevices);
                await this._sendToAddr(addr, /*recurse*/ (e.code === 409));
            } else if (e.code === 401 || e.code === 403) {
                throw e;
            } else {
                this._emitError(addr, "Failed to send message", e);
                return;
            }
        }
        this._emitSent(addr);
    }

    async _sendToDevice(addr, deviceId, recurse) {
        const protoAddr = new libsignal.ProtocolAddress(addr, deviceId);
        const sessionCipher = new libsignal.SessionCipher(storage, protoAddr);
        if (!(await sessionCipher.hasOpenSession())) {
            await this._getKeysForAddr(addr, [deviceId]);
        }
        let encryptedMessage;
        let attempts = 0;
        do {
            try {
                encryptedMessage = await sessionCipher.encrypt(this._getPaddedMessageBuffer());
            } catch(e) {
                if (e instanceof libsignal.UntrustedIdentityKeyError) {
                    await this._handleIdentityKeyError(e, {forceThrow: !!attempts});
                } else {
                    this._emitError(addr, "Failed to create message", e);
                    return;
                }
            }
        } while(!encryptedMessage && !attempts++);
        const messageBundle = this._toJSON(protoAddr, encryptedMessage, this.timestamp);
        try {
            await this.signal.sendMessage(addr, deviceId, messageBundle);
        } catch(e) {
            if (e instanceof errors.ProtocolError && e.code === 410) {
                sessionCipher.closeOpenSession();  // Force getKeysForAddr on next call.
                await this._sendToDevice(addr, /*recurse*/ false);
            } else if (e.code === 401 || e.code === 403) {
                throw e;
            } else {
                this._emitError(addr, "Failed to send message", e);
                return;
            }
        }
        this._emitSent(addr);
    }

    _toJSON(address, encryptedMsg, timestamp) {
        return {
            type: encryptedMsg.type,
            destinationDeviceId: address.deviceId,
            destinationRegistrationId: encryptedMsg.registrationId,
            content: encryptedMsg.body.toString('base64'),
            timestamp
        };
    }

    async _initSessions(encodedAddr) {
        // Scan the address for devices that have closed sessions and fetch
        // new key material for said devices so we can encrypt messages for
        // them.
        const [addr, deviceId] = util.unencodeAddr(encodedAddr);
        const deviceIds = deviceId ? [deviceId] : await storage.getDeviceIds(addr);
        if (!deviceIds.length) {
            return;
        }
        const stale = (await Promise.all(deviceIds.map(async id => {
            const address = new libsignal.ProtocolAddress(addr, id);
            const sessionCipher = new libsignal.SessionCipher(storage, address);
            return !(await sessionCipher.hasOpenSession()) ? id : null;
        }))).filter(x => x !== null);
        if (stale.length === deviceIds.length) {
            await this._getKeysForAddr(addr);  // Get them all at once.
        } else if (stale.length) {
            await this._getKeysForAddr(addr, stale);
        }
    }

    async _removeDeviceIdsForAddr(addr, deviceIdsToRemove) {
        if (!deviceIdsToRemove) {
            await storage.removeAllSessions(addr);
        } else {
            for (const id of deviceIdsToRemove) {
                const encodedAddr = addr + "." + id;
                await storage.removeSession(encodedAddr);
            }
        }
    }

    /**
     * Send this message to a specific peer or even a specific device of a given peer if
     * the {@link encodedAddr} param is fully qualified.
     *
     * @param {EncodedUserAddress} encodedAddr
     */
    async sendToAddr(encodedAddr) {
        try {
            await this._initSessions(encodedAddr);
        } catch(e) {
            this._emitError(addr, "Failed to init sessions for: " + encodedAddr, e);
            throw e;
        }
        const [addr, deviceId] = util.unencodeAddr(encodedAddr);
        try {
            if (deviceId) {
                await this._sendToDevice(addr, deviceId, /*recurse*/ true);
            } else {
                await this._sendToAddr(addr, /*recurse*/ true);
            }
        } catch(e) {
            this._emitError(encodedAddr, "Failed to send to address " + encodedAddr, e);
            throw e;
        }
    }
}

module.exports = OutgoingMessage;
