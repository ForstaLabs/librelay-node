// vim: ts=4:sw=4:expandtab

'use strict';

const WebSocketResource = require('./websocket_resource');
const MessageSender = require('./message_sender');
const crypto = require('./crypto');
const eventing = require('./eventing');
const hub = require('./hub');
const libsignal = require('libsignal');
const protobufs = require('./protobufs');
const queueAsync = require('./queue_async');
const storage = require('./storage');


const ENV_TYPES = protobufs.Envelope.lookup('Type').values;
const DATA_FLAGS = protobufs.DataMessage.lookup('Flags').values;


class MessageReceiver extends eventing.EventTarget {

    constructor(signal, addr, deviceId, signalingKey, noWebSocket) {
        super();
        console.assert(signal && addr && deviceId && signalingKey);
        this._sender = new MessageSender(signal, addr);
        this.signal = signal;
        this.addr = addr;
        this.deviceId = deviceId;
        this.signalingKey = signalingKey;
        if (!noWebSocket) {
            const url = this.signal.getMessageWebSocketURL();
            this.wsr = new WebSocketResource(url, {
                handleRequest: request => queueAsync(this, this.handleRequest.bind(this, request)),
                keepalive: {
                    path: '/v1/keepalive',
                    disconnect: true
                }
            });
            this.wsr.addEventListener('close', this.onSocketClose.bind(this));
            this.wsr.addEventListener('error', this.onSocketError.bind(this));
        }
    }

    static async factory(noWebSocket) {
        const signal = await hub.SignalClient.factory();
        const addr = await storage.getState('addr');
        const deviceId = await storage.getState('deviceId');
        const signalingKey = await storage.getState('signalingKey');
        return new this(signal, addr, deviceId, signalingKey, noWebSocket);
    }

    async checkRegistration() {
        try {
            // possible auth or network issue. Make a request to confirm
            await this.signal.getDevices();
        } catch(e) {
            console.error("Invalid network state:", e);
            const ev = new eventing.Event('error');
            ev.error = e;
            await this.dispatchEvent(ev);
        }
    }

    async connect() {
        if (this._closing) {
            throw new Error("Invalid State: Already Closed");
        }
        if (this._connecting) {
            console.warn("Duplicate connect detected");
        } else {
            this._connecting = (async () => {
                let attempts = 0;
                while (!this._closing) {
                    try {
                        await this.wsr.connect();
                        if (attempts) {
                            console.info("Reconnected websocket");
                        }
                        return;
                    } catch(e) {
                        await this.checkRegistration();
                        console.warn(`Connect problem (${attempts++} attempts)`);
                    }
                }
            })();
        }
        await this._connecting;
        this._connecting = null;
    }

    close() {
        this._closing = true;
        this.wsr.close();
    }

    async drain() {
        /* Pop messages directly from the messages API until it's empty. */
        if (this.wsr) {
            throw new TypeError("Fetch is invalid when websocket is in use");
        }
        let more;
        do {
            const data = await this.signal.request({call: 'messages'});
            more = data.more;
            const deleting = [];
            for (const envelope of data.messages) {
                if (envelope.content) {
                    envelope.content = Buffer.from(envelope.content, 'base64');
                }
                if (envelope.message) {
                    envelope.legacyMessage = Buffer.from(envelope.message, 'base64');
                }
                await this.handleEnvelope(envelope);
                deleting.push(this.signal.request({
                    call: 'messages',
                    httpType: 'DELETE',
                    urlParameters: `/${envelope.source}/${envelope.timestamp}`
                }));
            }
            await Promise.all(deleting);
        } while(more);
    }

    onSocketError(ev) {
        console.warn('Message Receiver WebSocket error:', ev);
    }

    async onSocketClose(ev) {
        if (this._closing) {
            return;
        }
        console.warn('Websocket closed:', ev.code, ev.reason || '');
        await this.checkRegistration();
        if (!this._closing) {
            await this.connect();
        }
    }

    async handleRequest(request) {
        if (request.path === '/api/v1/queue/empty') {
            console.debug("WebSocket queue empty");
            request.respond(200, 'OK');
            return;
        } else if (request.path !== '/api/v1/message' || request.verb !== 'PUT') {
            console.error("Expected PUT /message instead of:", request);
            request.respond(400, 'Invalid Resource');
            throw new Error('Invalid WebSocket resource received');
        }
        let envelope;
        try {
            const data = crypto.decryptWebsocketMessage(Buffer.from(request.body),
                                                        this.signalingKey);
            envelope = protobufs.Envelope.decode(data);
            envelope.timestamp = envelope.timestamp.toNumber();
        } catch(e) {
            console.error("Error handling incoming message:", e);
            request.respond(500, 'Bad encrypted websocket message');
            const ev = new eventing.Event('error');
            ev.error = e;
            await this.dispatchEvent(ev);
            throw e;
        }
        try {
            await this.handleEnvelope(envelope);
        } finally {
            request.respond(200, 'OK');
        }
    }

    async handleEnvelope(envelope, reentrant, forceAcceptKeyChange) {
        if (await storage.isBlocked(envelope.source)) {
            console.warn("Dropping message from blocked address:", envelope.source);
            return;
        }
        let handler;
        if (envelope.type === ENV_TYPES.RECEIPT) {
            handler = this.handleDeliveryReceipt;
        } else if (envelope.content) {
            handler = this.handleContentMessage;
        } else if (envelope.legacyMessage) {
            handler = this.handleLegacyMessage;
        } else {
            throw new Error('Received message with no content and no legacyMessage');
        }
        try {
            await handler.call(this, envelope);
        } catch(e) {
            if (e instanceof libsignal.MessageCounterError) {
                console.warn("Ignoring duplicate message:", envelope);
                return;
            } else if (e instanceof libsignal.UntrustedIdentityKeyError && !reentrant) {
                const keyChangeEvent = new eventing.KeyChangeEvent(e, envelope);
                if (forceAcceptKeyChange) {
                    await keyChangeEvent.accept();
                } else {
                    await this.dispatchEvent(keyChangeEvent);
                }
                if (e.accepted) {
                    envelope.keyChange = true;
                    await this.handleEnvelope(envelope, /*reentrant*/ true);
                }
                return;
            } else if (e instanceof libsignal.SessionError) {
                const fqAddr = `${envelope.source}.${envelope.sourceDevice}`;
                console.error(`Session error for ${fqAddr}:`, e);
                if (e instanceof libsignal.PreKeyError) {
                    console.warn("Refreshing prekeys...");
                    const keys = await this.signal.generateKeys();
                    await this.signal.registerKeys(keys);
                }
                console.warn("Attempting session reset/retransmit for:", envelope.timestamp);
                await this._sender.closeSession(fqAddr, {retransmit: envelope.timestamp});
            }
            const ev = new eventing.Event('error');
            ev.error = e;
            ev.proto = envelope;
            await this.dispatchEvent(ev);
        }
    }

    async handleDeliveryReceipt(envelope) {
        const ev = new eventing.Event('receipt');
        ev.proto = envelope;
        await this.dispatchEvent(ev);
    }

    unpad(buf) {
        for (let i = buf.byteLength - 1; i >= 0; i--) {
            if (buf[i] == 0x80) {
                return buf.slice(0, i);
            } else if (buf[i] !== 0x00) {
                throw new Error('Invalid padding');
            }
        }
        throw new Error("Invalid buffer");
    }

    async decrypt(envelope, ciphertext) {
        const addr = new libsignal.ProtocolAddress(envelope.source, envelope.sourceDevice);
        const sessionCipher = new libsignal.SessionCipher(storage, addr);
        let plainBuf;
        if (envelope.type === ENV_TYPES.CIPHERTEXT) {
            plainBuf = await sessionCipher.decryptWhisperMessage(ciphertext);
        } else if (envelope.type === ENV_TYPES.PREKEY_BUNDLE) {
            plainBuf = await sessionCipher.decryptPreKeyWhisperMessage(ciphertext);
        } else {
            throw new TypeError("Unknown message type");
        }
        return this.unpad(plainBuf);
    }

    async handleSentMessage(sent, envelope) {
        if (sent.message.flags & DATA_FLAGS.END_SESSION) {
            console.error("Unsupported syncMessage end-session sent by device:", envelope.sourceDevice);
            return;
        }
        await this.processDecrypted(sent.message, this.addr);
        const ev = new eventing.Event('sent');
        ev.data = {
            source: envelope.source,
            sourceDevice: envelope.sourceDevice,
            timestamp: sent.timestamp.toNumber(),
            destination: sent.destination,
            message: sent.message
        };
        if (sent.expirationStartTimestamp) {
          ev.data.expirationStartTimestamp = sent.expirationStartTimestamp.toNumber();
        }
        await this.dispatchEvent(ev);
    }

    async handleDataMessage(message, envelope, content) {
        if (message.flags & DATA_FLAGS.END_SESSION) {
            await this.handleEndSession(envelope.source);
        }
        await this.processDecrypted(message, envelope.source);
        const ev = new eventing.Event('message');
        ev.data = {
            timestamp: envelope.timestamp,
            source: envelope.source,
            sourceDevice: envelope.sourceDevice,
            message,
            keyChange: envelope.keyChange
        };
        await this.dispatchEvent(ev);
    }

    async handleLegacyMessage(envelope) {
        const data = await this.decrypt(envelope, envelope.legacyMessage);
        await this.handleDataMessage(protobufs.DataMessage.decode(data), envelope);
    }

    async handleContentMessage(envelope) {
        const data = await this.decrypt(envelope, envelope.content);
        const content = protobufs.Content.decode(data);
        if (content.syncMessage) {
            await this.handleSyncMessage(content.syncMessage, envelope, content);
        } else if (content.dataMessage) {
            await this.handleDataMessage(content.dataMessage, envelope, content);
        } else {
            throw new TypeError('Got content message with no dataMessage or syncMessage');
        }
    }

    async handleSyncMessage(message, envelope, content) {
        if (envelope.source !== this.addr) {
            throw new ReferenceError('Received sync message from another addr');
        }
        if (envelope.sourceDevice == this.deviceId) {
            throw new ReferenceError('Received sync message from our own device');
        }
        if (message.sent) {
            await this.handleSentMessage(message.sent, envelope);
        } else if (message.read && message.read.length) {
            await this.handleRead(message.read, envelope);
        } else if (message.contacts) {
            console.error("Deprecated contact sync message:", message, envelope, content);
            throw new TypeError('Deprecated contact sync message');
        } else if (message.groups) {
            console.error("Deprecated group sync message:", message, envelope, content);
            throw new TypeError('Deprecated group sync message');
        } else if (message.blocked) {
            this.handleBlocked(message.blocked, envelope);
        } else if (message.request) {
            console.error("Deprecated group request sync message:", message, envelope, content);
            throw new TypeError('Deprecated group request sync message');
        } else {
            console.error("Empty sync message:", message, envelope, content);
        }
    }

    async handleRead(read, envelope) {
        for (const x of read) {
            const ev = new eventing.Event('read');
            ev.timestamp = envelope.timestamp;
            ev.read = {
                timestamp: x.timestamp.toNumber(),
                sender: x.sender,
                source: envelope.source,
                sourceDevice: envelope.sourceDevice
            };
            await this.dispatchEvent(ev);
        }
    }

    handleBlocked(blocked) {
        throw new Error("UNSUPPORTRED");
    }

    async fetchAttachment(attachment) {
        const encData = await this.signal.getAttachment(attachment.id.toString());
        return await crypto.decryptAttachment(encData, attachment.key);
    }

    async handleEndSession(addr, deviceId) {
        const deviceIds = deviceId == null ? (await storage.getDeviceIds(addr)) : [deviceId];
        console.warn(`Handle end-session for: ${addr}.${deviceId || "*"}`);
        await Promise.all(deviceIds.map(deviceId => {
            const address = new libsignal.ProtocolAddress(addr, deviceId);
            const sessionCipher = new libsignal.SessionCipher(storage, address);
            return sessionCipher.closeOpenSession();
        }));
    }

    async processDecrypted(msg, source) {
        // Now that its decrypted, validate the message and clean it up for consumer processing
        // Note that messages may (generally) only perform one action and we ignore remaining fields
        // after the first action.
        if (msg.flags === null) {
            msg.flags = 0;
        }
        if (msg.expireTimer === null) {
            msg.expireTimer = 0;
        }
        if (msg.group) {
            throw new Error("Legacy group message");
        }
        return msg;
    }
}

module.exports = MessageReceiver;
