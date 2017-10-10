// vim: ts=4:sw=4:expandtab

const Event = require('./event');
const EventTarget = require('./event_target');
const OutgoingMessage = require('./outgoing_message');
const TextSecureServer = require('./textsecure_server');
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
        const dataMessage = protobufs.DataMessage.create();
        if (this.body) {
            dataMessage.body = this.body;
        }
        if (this.attachmentPointers && this.attachmentPointers.length) {
            dataMessage.attachments = this.attachmentPointers;
        }
        if (this.flags) {
            dataMessage.flags = this.flags;
        }
        if (this.expiration) {
            dataMessage.expireTimer = this.expiration;
        }
        return protobufs.Content.encode(protobufs.Content.create({dataMessage})).finish();
    }
}

class MessageSender extends EventTarget {

    constructor(tss, addr) {
        super();
        console.assert(tss && addr);
        this.tss = tss;
        this.addr = addr;
    }

    static async factory() {
        const tss = await TextSecureServer.factory();
        const addr = await storage.getState('addr');
        return new this(tss, addr);
    }

    async makeAttachmentPointer(attachment) {
        if (!attachment) {
            console.warn("Attempt to make attachment pointer from nothing:", attachment);
            return;
        }
        const key = node_crypto.randomBytes(64);
        const ptr = protobufs.AttachmentPointer.create({
            key,
            contentType: attachment.type
        });
        const iv = node_crypto.randomBytes(16);
        const encryptedBin = await crypto.encryptAttachment(attachment.data, key, iv);
        ptr.id = await this.tss.putAttachment(encryptedBin);
        return ptr;
    }

    retransmitMessage(addr, jsonData, timestamp) {
        var outgoing = new OutgoingMessage(this.tss);
        return outgoing.transmitMessage(addr, jsonData, timestamp);
    }

    async tryMessageAgain(addr, encodedMessage, timestamp) {
        const content = protobufs.Content.create({
            dataMessage: protobufs.DataMessage.decode(encodedMessage)
        });
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

    sendMessageProto(timestamp, addrs, msgProto) {
        console.assert(addrs instanceof Array);
        const outmsg = new OutgoingMessage(this.tss, timestamp, msgProto);
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

    async sendSyncMessage(contentBuffer, timestamp, threadId, expirationStartTimestamp) {
        if (!(contentBuffer instanceof Buffer)) {
            throw TypeError("Expected Buffer for content");
        }
        const content = protobufs.Content.decode(contentBuffer);
        const sentMessage = protobufs.SyncMessage.Sent.create({
            timestamp,
            message: content.dataMessage
        });
        if (threadId) {
            sentMessage.destination = threadId;
        }
        if (expirationStartTimestamp) {
            sentMessage.expirationStartTimestamp = expirationStartTimestamp;
        }
        const syncMessage = protobufs.SyncMessage.create({sent: sentMessage});
        const syncContent = protobufs.Content.create({syncMessage});
        // Originally this sent the sync message with a unique timestamp on the envelope but this
        // led to consistency problems with Android clients that were using that timestamp for delivery
        // receipts.  It's hard to say what the correct behavior is given that sync messages could
        // be cataloged separately and might want their own timestamps (which are the index for receipts).
        return this.sendMessageProto(timestamp, [this.addr], syncContent);
        //return this.sendMessageProto(Date.now(), [this.addr], syncContent);
    }

    async syncReadMessages(reads) {
        const read = reads.map(r => protobufs.SyncMessage.Read.create({
            timestamp: r.timestamp,
            sender: r.sender
        }));
        const syncMessage = protobufs.SyncMessage.create({read});
        const content = protobufs.Content.create({syncMessage});
        return this.sendMessageProto(Date.now(), [this.addr], content);
    }

    scrubSelf(addrs) {
        const nset = new Set(addrs);
        nset.delete(this.addr);
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
        const dataMessage = protobufs.DataMessage.create({
            flags: protobufs.DataMessage.Flags.END_SESSION
        });
        const content = protobufs.Content.create({dataMessage});
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
