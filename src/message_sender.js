// vim: ts=4:sw=4:expandtab

const Event = require('./event');
const EventTarget = require('./event_target');
const OutgoingMessage = require('./outgoing_message');
const crypto = require('./crypto');
const errors = require('./errors.js');
const libsignal = require('libsignal');
const node_crypto = require('crypto');
const protobufs = require('./protobufs');
const queueAsync = require('./queue_async');
const storage = require('./storage');


class Message {

    constructor(options) {
        Object.assign(this, options);
        if (!(this.recipients instanceof Array)) {
            throw new Error('Invalid recipient list');
        }
        if (typeof this.timestamp !== 'number') {
            throw new Error('Invalid timestamp');
        }
        if (this.expiration !== undefined && this.expiration !== null) {
            if (typeof this.expiration !== 'number' || !(this.expiration >= 0)) {
                throw new Error('Invalid expiration');
            }
        }
        if (this.attachments) {
            if (!(this.attachments instanceof Array)) {
                throw new Error('Invalid message attachments');
            }
        }
        if (this.flags !== undefined && typeof this.flags !== 'number') {
            throw new Error('Invalid message flags');
        }
        if ((typeof this.timestamp !== 'number') ||
            (this.body && typeof this.body !== 'string')) {
            throw new Error('Invalid message body');
        }
    }

    isEndSession() {
        return (this.flags & protobufs.DataMessage.Flags.END_SESSION);
    }

    toProto() {
        const content = new protobufs.Content();
        const data = content.dataMessage = new protobufs.DataMessage();
        if (this.body) {
            data.body = this.body;
        }
        if (this.attachmentPointers && this.attachmentPointers.length) {
            data.attachments = this.attachmentPointers;
        }
        if (this.flags) {
            data.flags = this.flags;
        }
        if (this.expiration) {
            data.expireTimer = this.expiration;
        }
        return content;
    }

    toArrayBuffer() {
        return this.toProto().toArrayBuffer();
    }
}

class MessageSender extends EventTarget {

    constructor(server) {
        super();
        this.server = server;
        errors.replay.registerFunction(this.tryMessageAgain.bind(this),
                                       errors.replay.Type.ENCRYPT_MESSAGE);
        errors.replay.registerFunction(this.retransmitMessage.bind(this),
                                       errors.replay.Type.TRANSMIT_MESSAGE);
        errors.replay.registerFunction(this.sendMessage.bind(this),
                                       errors.replay.Type.REBUILD_MESSAGE);
    }

    async makeAttachmentPointer(attachment) {
        if (!attachment) {
            console.warn("Attempt to make attachment pointer from nothing:", attachment);
            return;
        }
        const ptr = new protobufs.AttachmentPointer();
        ptr.key = node_crypto.randomBytes(64);
        const iv = node_crypto.randomBytes(16);
        const encryptedBin = await crypto.encryptAttachment(attachment.data, ptr.key, iv);
        const id = await this.server.putAttachment(encryptedBin);
        ptr.id = id;
        ptr.contentType = attachment.type;
        return ptr;
    }

    retransmitMessage(addr, jsonData, timestamp) {
        var outgoing = new OutgoingMessage(this.server);
        return outgoing.transmitMessage(addr, jsonData, timestamp);
    }

    async tryMessageAgain(addr, encodedMessage, timestamp) {
        const content = new protobufs.Content();
        content.dataMessage = protobufs.DataMessage.decode(encodedMessage);
        return this.sendMessageProto(timestamp, [addr], content);
    }

    async uploadAttachments(message) {
        const attachments = message.attachments;
        if (!attachments || !attachments.length) {
            message.attachmentPointers = [];
            return;
        }
        const upload_jobs = attachments.map(x => this.makeAttachmentPointer(x));
        try {
            message.attachmentPointers = await Promise.all(upload_jobs);
        } catch(e) {
            if (e instanceof errors.ProtocolError) {
                throw new errors.MessageError(message, e);
            } else {
                throw e;
            }
        }
    }

    async sendMessage(attrs) {
        const m = new Message(attrs);
        await this.uploadAttachments(m);
        return this.sendMessageProto(m.timestamp, m.recipients, m.toProto());
    }

    sendMessageProto(timestamp, addrs, msgproto) {
        console.assert(addrs instanceof Array);
        const outmsg = new OutgoingMessage(this.server, timestamp, msgproto);
        outmsg.on('keychange', this.onKeyChange.bind(this));
        for (const addr of addrs) {
            queueAsync('message-send-job-' + addr, () => outmsg.sendToAddr(addr));
        }
        return outmsg;
    }

    async onKeyChange(addr, key) {
        const ev = new Event('keychange');
        ev.addr = addr;
        ev.identityKey = key;
        await this.dispatchEvent(ev);
    }

    async sendSyncMessage(content, timestamp, threadId, expirationStartTimestamp) {
        if (!(content instanceof protobufs.Content)) {
            content = protobufs.Content.decode(content);
        }
        const sentMessage = new protobufs.SyncMessage.Sent();
        sentMessage.timestamp = timestamp;
        sentMessage.message = content.dataMessage;
        if (threadId) {
            sentMessage.destination = threadId;
        }
        if (expirationStartTimestamp) {
            sentMessage.expirationStartTimestamp = expirationStartTimestamp;
        }
        const syncMessage = new protobufs.SyncMessage();
        syncMessage.sent = sentMessage;
        const syncContent = new protobufs.Content();
        syncContent.syncMessage = syncMessage;
        // Originally this sent the sync message with a unique timestamp on the envelope but this
        // led to consistency problems with Android clients that were using that timestamp for delivery
        // receipts.  It's hard to say what the correct behavior is given that sync messages could
        // be cataloged separately and might want their own timestamps (which are the index for receipts).
        return this.sendMessageProto(timestamp, [this.server.addr], syncContent);
        //return this.sendMessageProto(Date.now(), [this.server.addr], syncContent);
    }

    async _sendRequestSyncMessage(type) {
        const request = new protobufs.SyncMessage.Request();
        request.type = type;
        const syncMessage = new protobufs.SyncMessage();
        syncMessage.request = request;
        const content = new protobufs.Content();
        content.syncMessage = syncMessage;
        return this.sendMessageProto(Date.now(), [this.server.addr], content);
    }

    async syncReadMessages(reads) {
        const syncMessage = new protobufs.SyncMessage();
        syncMessage.read = reads.map(r => {
            const read = new protobufs.SyncMessage.Read();
            read.timestamp = r.timestamp;
            read.sender = r.sender;
            return read;
        });
        const content = new protobufs.Content();
        content.syncMessage = syncMessage;
        return this.sendMessageProto(Date.now(), [this.server.addr], content);
    }

    scrubSelf(addrs) {
        const nset = new Set(addrs);
        nset.delete(this.server.addr);
        return Array.from(nset);
    }

    async sendMessageToAddrs(addrs, body, attachments, timestamp, expiration, flags) {
        console.assert(body instanceof Array);
        return await this.sendMessage({
            recipients: this.scrubSelf(addrs),
            body: JSON.stringify(body),
            timestamp,
            attachments,
            expiration,
            flags
        });
    }

    async closeSession(addr, timestamp) {
        const content = new protobufs.Content();
        const data = content.dataMessage = new protobufs.DataMessage();
        data.flags = protobufs.DataMessage.Flags.END_SESSION;
        const outmsg = this.sendMessageProto(timestamp, [addr], content);
        const deviceIds = await storage.getDeviceIds(addr);
        await new Promise(resolve => {
            outmsg.on('complete', resolve);
            outmsg.on('error', resolve);
        });
        await Promise.all(deviceIds.map(deviceId => {
            const address = new libsignal.SignalProtocolAddress(addr, deviceId);
            const sessionCipher = new libsignal.SessionCipher(storage, address);
            return sessionCipher.closeOpenSessionForDevice();
        }));
    }
}

module.exports = MessageSender;
