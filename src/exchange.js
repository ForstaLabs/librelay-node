// vim: ts=4:sw=4:expandtab
/** @module */

const MessageReceiver = require('./message_receiver');
const MessageSender = require('./message_sender');
const hub = require('./hub');
const protobufs = require('./protobufs');

const currentVersion = 1;
const ExchangeClasses = {};


/**
 * Interface for communicating with other Forsta devices.
 * {@link https://goo.gl/eX7gyC Payload Definition}
 */
class Exchange {

    async _getMessageSender() {
        if (!this._msgSender) {
            this._msgSender = await MessageSender.factory();
        }
        return this._msgSender;
    }

    async _getMessageReceiver() {
        if (!this._msgReceiver) {
            this._msgReceiver = await MessageReceiver.factory();
        }
        return this._msgReceiver;
    }

    async _getAtlasClient() {
        if (!this._atlas) {
            this._atlas = await hub.AtlasClient.factory();
        }
        return this._atlas;
    }

    async _getSignalClient() {
        if (!this._signal) {
            this._signal = await hub.SignalClient.factory();
        }
        return this._signal;
    }

    constructor(options) {
        options = options || {};
        this._msgSender = options.messageSender;
        this._msgReceiver = options.messageReceiver;
        this._atlas = options.atlas;
        this._signal = options.signal;
    }

    decode(dataMessage, payload) {
        this.setExpiration(dataMessage.expireTimer);
        this.setFlags(dataMessage.flags);
        this.decodePayload(payload);
    }

    encode() {
        return protobufs.DataMessage.create({
            flags: this.getFlags(),
            expireTimer: this.getExpiration(),
            body: JSON.stringify([this.encodePayload()])
        });
    }

    /**
     * Send a message to this exchange's thread.
     *
     * @param {SendOptions} options - All standard send options are supported plus...
     * @param {bool} [options.onlySender] - Set to true if you want to send a message to
     *        only the original sender of this exchange object.  Used for private replies
     *        to an individual regardless of the thread distribution.
     */
    async send(options) {
        const atlas = await this._getAtlasClient();
        const distribution = await atlas.resolveTags(this.getThreadExpression());
        const addrs = options.onlySender ? [this.getSender()] : undefined;
        return await (await this._getMessageSender()).send(Object.assign({
            distribution,
            addrs,
            threadId: this.getThreadId(),
            threadType: this.getThreadType(),
            threadTitle: this.getThreadTitle(),
        }, options));
    }

    /**
     * Listen for new message events on pertaining to this exchange's thread.
     *
     * @param {callback} callback
     */
    async addMessageListener(callback) {
        // Add a filtered event listener on the message receiver that only
        // fires events for message events pertaining to our thread ID.
        if (!this._messageListeners) {
            this._messageListeners = [];
        }
        this._messageListeners.push(callback);
        if (!this._messageListener) {
            const threadId = this.getThreadId();
            this._messageListener = async ev => {
                if (ev.data.exchange.getThreadId() === threadId) {
                    for (const cb of this._messageListeners) {
                        await cb(ev);
                    }
                }
            };
            const mr = await this._getMessageReceiver();
            mr.addEventListener('message', this._messageListener);
        }
    }

   /**
     * Remove message event listener added by {@link addMessageListener}.
     *
     * @param {callback} callback
     */
    async removeMessageListener(callback) {
        const idx = this._messageListeners.indexOf(callback);
        if (idx !== -1) {
            this._messageListeners.splice(idx, 1);
            if (!this._messageListeners.length) {
                const mr = await this._getMessageReceiver();
                mr.removeEventListener('message', this._messageListener);
                this._messageListener = null;
            }
        }
    }

    /**
     * Generator for receiving new messages on this exchange's thread.
     *
     * @param {Object} options
     * @param {number} [options.timeout] - Timeout in milliseconds
     * @yields {Promise} exchangePromise - Promise that resolves to the next available message or 
     *                                     undefined if timeout is reached.
     */
    *recvMessages(options) {
        options = options || {};
        const timeout = options.timeout;
        const queue = [];
        let waiter;
        let timeoutId;
        const callback = ev => {
            if (waiter) {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                waiter(ev.data.exchange);
                waiter = null;
            } else {
                queue.push(ev.data.exchange);
            }
        };
        this.addMessageListener(callback);
        let active = true;
        try {
            while (active) {
                if (queue.length) {
                    yield Promise.resolve(queue.shift());
                } else if (waiter) {
                    throw new Error("Prior promise was not awaited");
                } else {
                    yield new Promise(resolve => {
                        waiter = resolve;
                        if (timeout) {
                            timeoutId = setTimeout(() => {
                                active = false;
                                resolve(null);
                            }, timeout);
                        }
                    });
                }
            }
        } finally {
            this.removeMessageListener(callback);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * @returns {number} Expiration time for messages on this thread.
     */
    getExpiration() {
        return this._expiration;
    }

    /**
     * @param {number} value - Expiration time for messages on this thread.
     */
    setExpiration(value) {
        this._expiration = value;
    }

    /**
     * @returns {string} UUID for user that sent or is sending this message.
     */
    getSource() {
        return this._source;
    }

    /** 
     * @param {string} UUID of user sending this message.
     */
    setSource(value) {
        this._source = value;
    }

    /**
     * @returns {number} device ID of source user.
     */
    getSourceDevice() {
        return this._sourceDevice;
    }

    /**
     * @param {number} value - Device ID of source user.
     */
    setSourceDevice(value) {
        this._sourceDevice = value;
    }

    /**
     * @returns {number} Signal flags associated with this message.
     */
    getFlags() {
        return this._flags;
    }

    /**
     * @param {number} value - Signal flags associated with this message.
     */
    setFlags(value) {
        this._flags = value;
    }

    /**
     * Every message has a global and non-secret timestamp that is used to'
     * cross reference things like read-receipts and session retransmits.
     *
     * @returns {number} Milliseconds since 1970.
     */
    getTimestamp() {
        return this._timestamp;
    }

    /**
     * @param {number} value - Timestamp of this message in milliseconds since 1970.
     */
    setTimestamp(value) {
        this._timestamp = value;
    }

    /**
     * Time this message spent waiting for delivery on the Signal server.
     *
     * @returns {number} Milliseconds
     */
    getAge() {
        return this._age;
    }

    /**
     * @param {number} value - Milliseconds this message spent waiting for delivery (set by server).
     */
    setAge(value) {
        this._age = value;
    }

    /**
     * @abstract
     * @protected
     * @param {Object} payload - Version specific payload object.
     */
    decodePayload(payload) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @protected
     */
    encodePayload() {
        throw new Error("Subclasss impl required");
    }

    /**
     * Get the message body.  E.g. the localized text for this message.
     *
     * @abstract
     * @param {Object} options
     */
    getBody(options) {
        throw new Error("Subclasss impl required");
    }

    /**
     * Set the message body.  E.g. the localized text for this message.
     *
     * @abstract
     * @param {string} value - The body contents. E.g. text or html.
     * @param {Object} [options]
     */
    setBody(value, options) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     */
    getSender() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - The sender's UUID.
     */
    setSender(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {number} device ID of sender.
     */
    getSenderDevice() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {number} value - Device ID of sender.
     */
    setSenderDevice(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {string} The universal tag expression for this exchange's thread. 
     */
    getThreadExpression() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - The universal tag expression for this exchange's thread.
     */
    setThreadExpression(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {string} The UUID for this exhcange's thread.
     */
    getThreadId() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - The thread UUID for this exchange.
     */
    setThreadId(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {('converstaion'|'announcement')} The thread type for this message.
     */
    getThreadType() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {('conversation'|'announcement')} value - The thread type for this exchange.
     */
    setThreadType(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {?string} The optional thread title.
     */
    getThreadTitle() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {?string} value - Localized thread title text.
     */
    setThreadTitle(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {string} The UUID for this message.
     */
    getMessageId() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - UUID for this message.
     */
    setMessageId(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {string} The message type.
     */
    getMessageType() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - The message type. E.g. "content", "control", ...
     */
    setMessageType(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {?string} The optional message reference.  E.g. the UUID of a prior
     *                    message that this message refers/replies to. 
     */
    getMessageRef() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} value - Message UUID to reference.  E.g. the replied to UUID.
     */
    setMessageRef(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {?Attachment[]} Attachments for this message.
     */
    getAttachments() {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {Attachment[]} value - Attachments array for this message. 
     */
    setAttachments(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @returns {string} The device user agent string.
     */
    getUserAgent() {
        throw new Error("Subclasss impl required");
    }

    /**
      * @abstract
      * @param {string} value - The user agent string for this message.
      */
    setUserAgent(value) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} key - The data key to get.
     * @returns {Object} The natively typed value for this data property.
     */
    getDataProperty(key) {
        throw new Error("Subclasss impl required");
    }

    /**
     * @abstract
     * @param {string} key - The data key to set.
     * @param {Object} value - The natively typed value for this data property.
     */
    setDataProperty(key, value) {
        throw new Error("Subclasss impl required");
    }
}
exports.Exchange = Exchange;


/**
 * @version 1
 * @extends module:exchange~Exchange
 */
class ExchangeV1 extends Exchange {

    constructor(options) {
        super(options);
        this._payload = {};
    }

    decodePayload(payload) {
        Object.assign(this._payload, payload);
    }

    encodePayload() {
        return Object.assign({
            version: 1,
            sender: {
                userId: this.getSender() || this.getSource(),
                device: this.getSenderDevice() || this.getSourceDevice()
            }
        }, this._payload);
    }

    getBody(options) {
        options = options || {};
        if (this._payload && this._payload.data && this._payload.data.body) {
            const body = this._payload.data.body;
            if (!body.length) {
                return;
            }
            let entry;
            if (options.html) {
                entry = body.find(x => x.type === 'text/html');
            }
            if (!entry) {
                entry = body.find(x => x.type === 'text/plain');
            }
            if (!entry) {
                entry = body[0];
                console.warn("Unexpected type:", entry.type);
            }
            return entry.value;
        }
    }

    setBody(value, options) {
        options = options || {};
        let body = this.getDataProperty('body');
        if (!body) {
            body = [];
            this.setDataProperty('body', body);
        }
        body.push({
            type: options.html ? 'text/html' : 'text/plain',
            value
        });
    }

    getSender() {
        return this._payload.sender && this._payload.sender.userId;
    }

    setSender(value) {
        if (!this._payload.sender) {
            this._payload.sender = {};
        }
        this._payload.sender.userId = value;
    }

    getSenderDevice() {
        return this._payload.sender && this._payload.sender.device;
    }

    setSenderDevice(value) {
        if (!this._payload.sender) {
            this._payload.sender = {};
        }
        this._payload.sender.device = value;
    }

    getThreadExpression(value) {
        return this._payload.distribution && this._payload.distribution.expression;
    }

    setThreadExpression(value) {
        if (!this._payload.distribution) {
            this._payload.distribution = {};
        }
        this._payload.distribution.expression = value;
    }

    getThreadId() {
        return this._payload.threadId;
    }

    setThreadId(value) {
        this._payload.threadId = value;
    }

    getThreadType() {
        return this._payload.threadType;
    }

    setThreadType(value) {
        this._payload.threadType = value;
    }

    getThreadTitle() {
        return this._payload.threadTitle;
    }

    setThreadTitle(value) {
        this._payload.threadTitle = value;
    }

    getMessageId() {
        return this._payload.messageId;
    }

    setMessageId(value) {
        this._payload.messageId = value;
    }

    getMessageType() {
        return this._payload.messageType;
    }

    setMessageType(value) {
        this._payload.messageType = value;
    }

    getMessageRef() {
        return this._payload.messageRef;
    }

    setMessageRef(value) {
        this._payload.messageRef = value;
    }

    getAttachments() {
        return this._payload.attachments;
    }

    setAttachments(value) {
        this._payload.attachments = value;
    }

    getUserAgent() {
        return this._payload.userAgent;
    }

    setUserAgent(value) {
        this._payload.userAgent = value;
    }

    getDataProperty(key) {
        return this._payload.data && this._payload.data[key];
    }

    setDataProperty(key, value) {
        if (!this._payload.data) {
            this._payload.data = {};
        }
        this._payload.data[key] = value;
    }
}
exports.ExchangeV1 = ExchangeClasses[1] = ExchangeV1;

/**
 * Return a versioned Exchange instance based on the protocol buffer argument.
 *
 * @param {protobufs.DataMessage} dataMessage The protocol buffer to decode.
 * @param {Object} [options] Options to pass into the Exchange constructor.
 * @returns {module:exchange~Exchange}
 */
exports.decode = function(dataMessage, options) {
    if (!(dataMessage instanceof protobufs.DataMessage.ctor)) {
        throw new TypeError("DataMessage argument required");
    }
    const payload = JSON.parse(dataMessage.body);
    const ordered = Array.from(payload).sort((a, b) => a.version < b.version ? 1 : -1);
    for (const x of ordered) {
        if (ExchangeClasses.hasOwnProperty(x.version)) {
            const instance = new ExchangeClasses[x.version](options);
            instance.decode(dataMessage, x);
            return instance;
        }
    }
    throw new ReferenceError("No supported exchange versions found");
};


/**
 * Build a new Exchange object with our most current exchange version.
 *
 * @param {Object} [options] Constructor options.
 * @returns {module:exchange~Exchange}
 */
exports.create = function(options) {
    return new ExchangeClasses[currentVersion](options);
};

