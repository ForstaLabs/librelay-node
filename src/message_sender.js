// vim: ts=4:sw=4:expandtab

const Attachment = require('./attachment');
const OutgoingMessage = require('./outgoing_message');
const crypto = require('./crypto');
const eventing = require('./eventing');
const exchange = require('./exchange');
const hub = require('./hub');
const libsignal = require('libsignal');
const node_crypto = require('crypto');
const protobufs = require('./protobufs');
const queueAsync = require('./queue_async');
const storage = require('./storage');
const util = require('./util');
const uuid4 = require('uuid/v4');


/** @class */
class MessageSender extends eventing.EventTarget {

    /**
     * @param {Object} options
     * @param {string} options.addr - Your signal address (e.g. your account UUID)
     * @param {SignalClient} options.signal
     * @param {AtlasClient} options.atlas
     */
    constructor({addr, signal, atlas}) {
        super();
        this.addr = addr;
        this.signal = signal;
        this.atlas = atlas;
    }

    /**
     * Return a default instance.
     * @returns {MessageSender}
     */
    static async factory() {
        const addr = await storage.getState('addr');
        const signal = await hub.SignalClient.factory();
        const atlas = await hub.AtlasClient.factory();
        return new this({addr, signal, atlas});
    }

    async _makeAttachmentPointer(attachment) {
        if (!(attachment instanceof Attachment)) {
            throw TypeError("Expected `Attachment` type");
        }
        const key = node_crypto.randomBytes(64);
        const ptr = protobufs.AttachmentPointer.create({
            key,
            contentType: attachment.type
        });
        const iv = node_crypto.randomBytes(16);
        const encryptedBin = await crypto.encryptAttachment(attachment.buffer, key, iv);
        ptr.id = await this.signal.putAttachment(encryptedBin);
        return ptr;
    }

    /**
     * Send a message
     *
     * @param {Object} options
     * @param {string} options.to - Tag notation to send to. @example @jerry.lewis:supercorp
     * @param {Object} options.distribution - Distribution object produced by {@link module:hub.resolveTags}
     */
    async send({
        to=null, distribution=null,
        addrs=null,
        text=null, html=null,
        data={},
        threadId=uuid4(),
        threadType='conversation',
        threadTitle=undefined,
        messageType='content',
        messageId=uuid4(),
        messageRef=undefined,
        expiration=undefined,
        attachments=undefined,
        flags=undefined,
        userAgent='librelay',
        noSync=false,
        actions=undefined
    }) {
        const ex = exchange.create();
        if (!distribution) {
            if (!to) {
                throw TypeError("`to` or `distribution` required");
            }
            distribution = await this.atlas.resolveTags(to);
        }
        ex.setThreadExpression(distribution.universal);
        if (text) {
            ex.setBody(text);
        }
        if (html) {
            ex.setBody(html, {html: true});
        }
        ex.setThreadId(threadId);
        ex.setThreadType(threadType);
        ex.setThreadTitle(threadTitle);
        ex.setMessageType(messageType);
        ex.setMessageId(messageId);
        ex.setMessageRef(messageRef);
        ex.setUserAgent(userAgent);
        ex.setSource(this.addr.id);
        ex.setSourceDevice(this.addr.deviceId);
        ex.setExpiration(expiration);
        ex.setFlags(flags);
        if (actions && actions.length) {
            ex.setDataProperty('actions', actions);
        }
        for (const [k, v] of Object.entries(data)) {
            ex.setDataProperty(k, v);
        }
        if (attachments && attachments.length) {
            // TODO Port to exchange interfaces (TBD)
            ex.setAttachments(attachments.map(x => x.getMeta()));
        }
        const dataMessage = ex.encode();
        if (attachments) {
            // TODO Port to exchange interfaces (TBD)
            dataMessage.attachments = await Promise.all(attachments.map(x =>
                this._makeAttachmentPointer(x)));
        }
        const content = protobufs.Content.create({dataMessage});
        const ts = Date.now();
        if (!noSync) {
            await this._sendSync(content, ts, threadId, expiration && Date.now());
        }
        return this._send(content, ts, this._scrubSelf(addrs || distribution.userids));
    }

    _send(content, timestamp, addrs) {
        console.assert(addrs instanceof Array);
        const outmsg = new OutgoingMessage(this.signal, timestamp, content);
        outmsg.on('keychange', this._onKeyChange.bind(this));
        for (const addr of addrs) {
            queueAsync('message-send-job-' + addr, () =>
                outmsg.sendToAddr(addr).catch(this._onError.bind(this)));
        }
        return outmsg;
    }

    async _onError(e) {
        const ev = new eventing.Event('error');
        ev.error = e;
        await this.dispatchEvent(ev);
    }

    async _onKeyChange(e) {
        await this.dispatchEvent(new eventing.KeyChangeEvent(e));
    }

    async _sendSync(content, timestamp, threadId, expirationStartTimestamp) {
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
        return this._send(syncContent, timestamp, [this.addr]);
    }

    async syncReadMessages(reads) {
        if (!reads.length) {
            console.warn("No reads to sync");
        }
        const read = reads.map(r => protobufs.SyncMessage.Read.create({
            timestamp: r.timestamp,
            sender: r.sender
        }));
        const syncMessage = protobufs.SyncMessage.create({read});
        const content = protobufs.Content.create({syncMessage});
        return this._send(content, Date.now(), [this.addr]);
    }

    _scrubSelf(addrs) {
        const nset = new Set(addrs);
        nset.delete(this.addr);
        return Array.from(nset);
    }

    async closeSession(encodedAddr, options) {
        const [addr, deviceId] = util.unencodeAddr(encodedAddr);
        const deviceIds = deviceId ? [deviceId] :  await storage.getDeviceIds(addr);

        async function _closeOpenSessions() {
            await Promise.all(deviceIds.map(deviceId => {
                const address = new libsignal.ProtocolAddress(addr, deviceId);
                const sessionCipher = new libsignal.SessionCipher(storage, address);
                return sessionCipher.closeOpenSession();
            }));
        }

        await _closeOpenSessions();  // Clear before so endsession is a prekey bundle
        const outmsg = await this.send({
            addrs: [encodedAddr],
            noSync: true,
            flags: protobufs.DataMessage.Flags.END_SESSION,
            messageType: 'control',
            data: {
                control: 'closeSession',
                retransmit: options.retransmit
            }
        });
        try {
            await new Promise((resolve, reject) => {
                outmsg.on('sent', resolve);
                outmsg.on('error', reject);
            });
        } finally {
            await _closeOpenSessions();  // Clear after so don't use the reopened session from the end msg
        }
    }
}

module.exports = MessageSender;
