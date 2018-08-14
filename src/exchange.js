/*
 * Interface for communicating with other Forsta devices.
 * https://docs.google.com/document/d/16vKdrArCmr9QTXCaTNfo69Jp119OB3ipEXJJ0DfskkE
 */

const MessageReceiver = require('./message_receiver');
const MessageSender = require('./message_sender');
const hub = require('./hub');
const protobufs = require('./protobufs');

const currentVersion = 1;
const ExchangeClasses = {};


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


exports.create = function(options) {
    return new ExchangeClasses[currentVersion](options);
};


exports.Exchange = class Exchange {

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

    *recvMessages(options) {
        // Yield new message promises for this thread.  If timeout is set
        // the promise will resolve to `null` and the iterator will not yield
        // any more results.
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

    getExpiration() {
        return this._expiration;
    }

    setExpiration(value) {
        this._expiration = value;
    }

    getSource() {
        return this._source;
    }

    setSource(value) {
        this._source = value;
    }

    getSourceDevice() {
        return this._sourceDevice;
    }

    setSourceDevice(value) {
        this._sourceDevice = value;
    }

    getFlags() {
        return this._flags;
    }

    setFlags(value) {
        this._flags = value;
    }

    getTimestamp() {
        return this._timestamp;
    }

    setTimestamp(value) {
        this._timestamp = value;
    }

    decodePayload(payload) {
        throw new Error("Subclasss impl required");
    }

    encodePayload() {
        throw new Error("Subclasss impl required");
    }

    getBody(options) {
        throw new Error("Subclasss impl required");
    }

    setBody(value, options) {
        throw new Error("Subclasss impl required");
    }

    getSender() {
        throw new Error("Subclasss impl required");
    }

    setSender(value) {
        throw new Error("Subclasss impl required");
    }

    getThreadExpression() {
        throw new Error("Subclasss impl required");
    }

    setThreadExpression(value) {
        throw new Error("Subclasss impl required");
    }

    getThreadId() {
        throw new Error("Subclasss impl required");
    }

    setThreadId(value) {
        throw new Error("Subclasss impl required");
    }

    getThreadType() {
        throw new Error("Subclasss impl required");
    }

    setThreadType(value) {
        throw new Error("Subclasss impl required");
    }

    getThreadTitle() {
        throw new Error("Subclasss impl required");
    }

    setThreadTitle(value) {
        throw new Error("Subclasss impl required");
    }

    getMessageId() {
        throw new Error("Subclasss impl required");
    }

    setMessageId(value) {
        throw new Error("Subclasss impl required");
    }

    getMessageType() {
        throw new Error("Subclasss impl required");
    }

    setMessageType(value) {
        throw new Error("Subclasss impl required");
    }

    getMessageRef() {
        throw new Error("Subclasss impl required");
    }

    setMessageRef(value) {
        throw new Error("Subclasss impl required");
    }

    getAttachments() {
        throw new Error("Subclasss impl required");
    }

    setAttachments(value) {
        throw new Error("Subclasss impl required");
    }

    getUserAgent() {
        throw new Error("Subclasss impl required");
    }

    setUserAgent(value) {
        throw new Error("Subclasss impl required");
    }

    getDataProperty(key) {
        throw new Error("Subclasss impl required");
    }

    setDataProperty(key, value) {
        throw new Error("Subclasss impl required");
    }
};


exports.ExchangeV1 = class ExchangeV1 extends exports.Exchange {

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
                userId: this.getSource()  // DEPRECATED but needed for a while.
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
        this._payload.sender = {userId: value};
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
};
ExchangeClasses[1] = exports.ExchangeV1;
