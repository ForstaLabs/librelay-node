/*
 * Interface for communicating with other Forsta devices.
 * https://docs.google.com/document/d/16vKdrArCmr9QTXCaTNfo69Jp119OB3ipEXJJ0DfskkE
 */

const MessageSender = require('./message_sender');
const MessageReceiver = require('./message_receiver');

const currentVersion = 1;
const ExchangeClasses = {};


exports.decode = function(data, options) {
    const ordered = Array.from(data).sort((a, b) => a.version < b.version ? 1 : -1);
    for (const x of ordered) {
        if (ExchangeClasses.hasOwnProperty(x.version)) {
            const instance = new ExchangeClasses[x.version](options);
            instance.decode(x);
            return instance;
        }
    }
    throw new ReferenceError("No supported exchange versions found");
};


exports.create = function(options) {
    return new ExchangeClasses[currentVersion](options);
};


exports.Exchange = class Exchange {

    constructor(options) {
        options = options || {};
        if (options.messageSender) {
            this._msgSender = options.messageSender;
        }
        if (options.messageReceiver) {
            this._msgReceiver = options.messageReceiver;
        }
    }

    decode() {
        throw new Error("Subclasss impl required");
    }

    encode() {
        throw new Error("Subclasss impl required");
    }

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
        return (await this._getMessageSender()).atlas;
    }

    async reply(options) {
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
        this._attrs = {};
    }

    decode(attrs) {
        Object.assign(this._attrs, attrs);
    }

    encode() {
        return Object.assign({
            version: 1,
        }, this._attrs);
    }

    getBody(options) {
        options = options || {};
        if (this._attrs && this._attrs.data && this._attrs.data.body) {
            const body = this._attrs.data.body;
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
        return this._attrs.sender && this._attrs.sender.userId;
    }

    setSender(value) {
        this._attrs.sender = {userId: value};
    }

    getThreadExpression(value) {
        return this._attrs.distribution.expression;
    }

    setThreadExpression(value) {
        if (!this._attrs.distribution) {
            this._attrs.distribution = {};
        }
        this._attrs.distribution.expression = value;
    }

    getThreadId() {
        return this._attrs.threadId;
    }

    setThreadId(value) {
        this._attrs.threadId = value;
    }

    getThreadType() {
        return this._attrs.threadType;
    }

    setThreadType(value) {
        this._attrs.threadType = value;
    }

    getThreadTitle() {
        return this._attrs.threadTitle;
    }

    setThreadTitle(value) {
        this._attrs.threadTitle = value;
    }

    getMessageId() {
        return this._attrs.messageId;
    }

    setMessageId(value) {
        this._attrs.messageId = value;
    }

    getMessageType() {
        return this._attrs.messageType;
    }

    setMessageType(value) {
        this._attrs.messageType = value;
    }

    getMessageRef() {
        return this._attrs.messageRef;
    }

    setMessageRef(value) {
        this._attrs.messageRef = value;
    }

    getAttachments() {
        return this._attrs.attachments;
    }

    setAttachments(value) {
        this._attrs.attachments = value;
    }

    getUserAgent() {
        return this._attrs.userAgent;
    }

    setUserAgent(value) {
        this._attrs.userAgent = value;
    }

    getDataProperty(key) {
        return this._attrs.data && this._attrs.data[key];
    }

    setDataProperty(key, value) {
        if (!this._attrs.data) {
            this._attrs.data = {};
        }
        this._attrs.data[key] = value;
    }
};
ExchangeClasses[1] = exports.ExchangeV1;
