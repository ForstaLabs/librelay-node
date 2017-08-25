/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const EventEmitter = require('events');
const WebSocket = require('websocket').w3cwebsocket;
const WebSocketResource = require('./websocket-resources');
const api = require('./api');
const crypto = require('./crypto');
const errors = require('./errors');
const libsignal = require('libsignal');
const protobufs = require('./protobufs');
const storage = require('./storage');

const ENV_TYPES = protobufs.Envelope.lookup('Type').values;
const GROUPCTX_TYPES = protobufs.GroupContext.lookup('Type').values;
const DATA_FLAGS = protobufs.DataMessage.lookup('Flags').values;


class MessageReceiver extends EventEmitter {

    constructor(url, username, password, signalingKey, attachment_server_url) {
        super();
        this.url = url;
        this.signalingKey = signalingKey;
        this.username = username;
        this.password = password;
        this.server = new api.RelayServer(url, username, password, attachment_server_url);

        var address = libsignal.SignalProtocolAddress.fromString(username);
        this.number = address.getName();
        this.deviceId = address.getDeviceId();
        errors.replay.registerFunction(this.tryMessageAgain.bind(this),
                                       errors.replay.Type.INIT_SESSION);
        this._wait = new Promise(function(resolve, reject) {
            this._wait_resolve = resolve;
            this._wait_reject = reject;
        }.bind(this));
    }

    connect() {
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            this.socket.close();
        }
        this.socket = this.server.getMessageSocket();
        this.socket.onclose = this.onclose.bind(this);
        this.socket.onerror = this.onerror.bind(this);
        this.wsr = new WebSocketResource(this.socket, {
            handleRequest: this.handleRequest.bind(this),
            keepalive: { path: '/v1/keepalive', disconnect: true }
        });
    }

    close() {
        this.socket.close(3000, 'called close');
    }

    onerror(error) {
        console.log('websocket error', error);
        this._wait_reject(error);
    }

    async onclose(ev) {
        console.warn('Websocket closed:', ev.code, ev.reason || '');
        if (ev.code === 3000) {
            return;
        }
        // possible 403 or network issue. Make a request to confirm
        try {
            await this.server.getDevices();
        } catch(e) {
            this._wait_reject(e);
            return;
        }
        this.connect();
    }

    /* Wait until error or close. */
    async wait() {
        await this._wait;
    }

    handleRequest(request) {
        let envbuf;
        try {
            envbuf = crypto.decryptWebsocketMessage(Buffer.from(request.body),
                                                    this.signalingKey);
        } catch(e) {
            request.respond(500, 'Bad encrypted websocket message');
            throw e;
        }
        request.respond(200, 'OK');
        const envelope = protobufs.Envelope.decode(envbuf);
        if (envelope.type === ENV_TYPES.RECEIPT) {
            this.emit('receipt', envelope);
        }
        if (envelope.content.byteLength) {
            return this.handleContentMessage(envelope);
        } else if (envelope.legacyMessage.byteLength) {
            return this.handleLegacyMessage(envelope);
        } else {
            throw new Error('Received message with no content and no legacyMessage');
        }
    }

    getStatus() {
        if (this.socket) {
            return this.socket.readyState;
        } else {
            return -1;
        }
    }

    unpad(buf) {
        for (let i = buf.byteLength - 1; i >= 0; i--) {
            if (buf[i] == 0x80) {
                return buf.slice(0, i);
            } else if (buf[i] !== 0x00) {
                throw new Error('Invalid padding');
            }
        }
        return buf // empty
    }

    async decrypt(envelope, ciphertext) {
        const address = new libsignal.SignalProtocolAddress(envelope.source,
                                                            envelope.sourceDevice);
        const sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
        if (envelope.type === ENV_TYPES.CIPHERTEXT) {
            console.warn(envelope, ciphertext);
            throw new Error('UNTESTED');
            return this.unpad(await sessionCipher.decryptWhisperMessage(ciphertext));
        } else if (envelope.type === ENV_TYPES.PREKEY_BUNDLE) {
            return await this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher);
        }
        throw new Error("Unknown message type");
    }

    async decryptPreKeyWhisperMessage(ciphertext, sessionCipher) {
        return this.unpad(await sessionCipher.decryptPreKeyWhisperMessage(ciphertext));
    }

    async handleSentMessage(destination, timestamp, msgbuf, expire) {
        if ((msgbuf.flags & DATA_FLAGS.END_SESSION) == DATA_FLAGS.END_SESSION) {
            await this.handleEndSession(destination);
        }
        const message = await this.processDecrypted(msgbuf, this.number);
        this.emit('sent', {
            destination,
            timestamp: timestamp.toNumber(),
            message,
            expirationStartTimestamp: expire && expire.toNumber()
        });
    }

    async handleDataMessage(envelope, msgbuf) {
        var encodedNumber = envelope.source + '.' + envelope.sourceDevice;
        if ((msgbuf.flags & DATA_FLAGS.END_SESSION) == DATA_FLAGS.END_SESSION) {
            await this.handleEndSession(envelope.source);
        }
        const message = await this.processDecrypted(msgbuf, envelope.source);
        this.emit('message', {
            source: envelope.source,
            timestamp: envelope.timestamp.toNumber(),
            message
        });
    }

    async handleLegacyMessage(envelope) {
        const plaintext = await this.decrypt(envelope, envelope.legacyMessage);
        var message = protobufs.DataMessage.decode(plaintext);
        return await this.handleDataMessage(envelope, message);
    }

    async handleContentMessage(envelope) {
        const plaintext = await this.decrypt(envelope, envelope.content);
        var content = protobufs.Content.decode(plaintext);
        if (content.syncMessage) {
            return await this.handleSyncMessage(envelope, content.syncMessage);
        } else if (content.dataMessage) {
            return await this.handleDataMessage(envelope, content.dataMessage);
        } else {
            throw new Error('Got Content message with no dataMessage and no syncMessage');
        }
    }

    async handleSyncMessage(envelope, syncMessage) {
        if (envelope.source !== this.number) {
            throw new Error('Received sync message from another number');
        }
        if (envelope.sourceDevice == this.deviceId) {
            throw new Error('Received sync message from our own device');
        }
        if (syncMessage.sent) {
            var sentMessage = syncMessage.sent;
            console.log('sent message to',
                    sentMessage.destination,
                    sentMessage.timestamp.toNumber(),
                    'from', envelope.source + '.' + envelope.sourceDevice
            );
            return await this.handleSentMessage(
                    sentMessage.destination,
                    sentMessage.timestamp,
                    sentMessage.message,
                    sentMessage.expirationStartTimestamp
            );
        } else if (syncMessage.contacts) {
            throw new Error("Not Implemented");
            await this.handleContacts(syncMessage.contacts);
        } else if (syncMessage.groups) {
            await this.handleGroups(syncMessage.groups);
        } else if (syncMessage.blocked) {
            throw new Error("blocked handling not implemented");
        } else if (syncMessage.request) {
            console.log('Got SyncMessage Request');
        } else if (syncMessage.read) {
            console.log('read messages',
                    'from', envelope.source + '.' + envelope.sourceDevice);
            this.handleRead(syncMessage.read, envelope.timestamp);
        } else {
            throw new Error('Got empty SyncMessage');
        }
    }

    handleRead(read, timestamp) {
        for (var i = 0; i < read.length; ++i) {
            this.emit('read', {
                timestamp: timestamp.toNumber(),
                read: {
                    timestamp : read[i].timestamp.toNumber(),
                    sender    : read[i].sender
                }
            });
        }
    }

    async handleContacts(contacts) {
        console.log('contact sync');
        const attachmentPointer = contacts.blob;
        await this.handleAttachment(attachmentPointer);
        const contactBuffer = new ContactBuffer(attachmentPointer.data);
        let contactDetails = contactBuffer.next();
        while (contactDetails !== undefined) {
            this.emit('contact', contactDetails);
            contactDetails = contactBuffer.next();
        }
        this.emit('contactsync');
    }

    handleGroups(groups) {
        console.log('group sync');
        var attachmentPointer = groups.blob;
        return this.handleAttachment(attachmentPointer).then(function() {
            var groupBuffer = new GroupBuffer(attachmentPointer.data);
            var groupDetails = groupBuffer.next();
            var promises = [];
            while (groupDetails !== undefined) {
                var promise = (function(groupDetails) {
                    groupDetails.id = groupDetails.id.toString('binary');
                    if (groupDetails.active) {
                        return storage.groups.getGroup(groupDetails.id).
                            then(function(existingGroup) {
                                if (existingGroup === undefined) {
                                    return storage.groups.createNewGroup(
                                        groupDetails.members, groupDetails.id
                                    );
                                } else {
                                    return storage.groups.updateNumbers(
                                        groupDetails.id, groupDetails.members
                                    );
                                }
                            }).then(function() { return groupDetails });
                    } else {
                        return Promise.resolve(groupDetails);
                    }
                })(groupDetails).then(function(groupDetails) {
                    this.emit('group', groupDetails);
                }).catch(function(e) {
                    console.log('error processing group', e);
                });
                groupDetails = groupBuffer.next();
                promises.push(promise);
            }
            Promise.all(promises).then(function() {
                this.emit('groupsync');
            });
        });
    }

    async handleAttachment(attachment) {
        const encrypted = await this.server.getAttachment(attachment.id.toString());
        attachment.data = await crypto.decryptAttachment(encrypted, attachment.key);
    }

    tryMessageAgain(from, ciphertext) {
        var address = libsignal.SignalProtocolAddress.fromString(from);
        var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
        console.log('retrying prekey whisper message');
        const plaintext = this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address);
        var finalMessage = protobufs.DataMessage.decode(plaintext);

        var p = Promise.resolve();
        if ((finalMessage.flags & DATA_FLAGS.END_SESSION) == DATA_FLAGS.END_SESSION &&
            finalMessage.sync !== null) {
            p = this.handleEndSession(address.getName());
        }

        return p.then(function() {
            return this.processDecrypted(finalMessage);
        }.bind(this));
    }

    async handleEndSession(number) {
        for (const deviceId of await storage.protocol.getDeviceIds(number)) {
            var address = new libsignal.SignalProtocolAddress(number, deviceId);
            var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
            console.log('closing session for', address.toString());
            await sessionCipher.closeOpenSessionForDevice();
        }
    }

    processDecrypted(decrypted, source) {
        // Now that its decrypted, validate the message and clean it up for consumer processing
        // Note that messages may (generally) only perform one action and we ignore remaining fields
        // after the first action.

        if (decrypted.flags == null) {
            decrypted.flags = 0;
        }
        if (decrypted.expireTimer == null) {
            decrypted.expireTimer = 0;
        }

        if (decrypted.flags & DATA_FLAGS.END_SESSION) {
            decrypted.body = null;
            decrypted.attachments = [];
            decrypted.group = null;
            return Promise.resolve(decrypted);
        } else if (decrypted.flags & DATA_FLAGS.EXPIRATION_TIMER_UPDATE) {
            decrypted.body = null;
            decrypted.attachments = [];
        } else if (decrypted.flags != 0) {
            throw new Error("Unknown flags in message");
        }

        var promises = [];

        if (decrypted.group !== null) {
            decrypted.group.id = decrypted.group.id.toString('binary');

            if (decrypted.group.type == GROUPCTX_TYPES.UPDATE) {
                if (decrypted.group.avatar !== null) {
                    promises.push(this.handleAttachment(decrypted.group.avatar));
                }
            }

            promises.push(storage.groups.getNumbers(decrypted.group.id).then(function(existingGroup) {
                if (existingGroup === undefined) {
                    if (decrypted.group.type != GROUPCTX_TYPES.UPDATE) {
                        decrypted.group.members = [source];
                        console.log("Got message for unknown group");
                    }
                    return storage.groups.createNewGroup(decrypted.group.members, decrypted.group.id);
                } else {
                    var fromIndex = existingGroup.indexOf(source);

                    if (fromIndex < 0) {
                        //TODO: This could be indication of a race...
                        console.log("Sender was not a member of the group they were sending from");
                    }

                    switch(decrypted.group.type) {
                    case GROUPCTX_TYPES.UPDATE:
                        return storage.groups.updateNumbers(
                            decrypted.group.id, decrypted.group.members
                        ).then(function(added) {
                            decrypted.group.added = added;

                            if (decrypted.group.avatar === null &&
                                decrypted.group.added.length == 0 &&
                                decrypted.group.name === null) {
                                return;
                            }

                            decrypted.body = null;
                            decrypted.attachments = [];
                        });

                        break;
                    case GROUPCTX_TYPES.QUIT:
                        decrypted.body = null;
                        decrypted.attachments = [];
                        if (source === this.number) {
                            return storage.groups.deleteGroup(decrypted.group.id);
                        } else {
                            return storage.groups.removeNumber(decrypted.group.id, source);
                        }
                    case GROUPCTX_TYPES.DELIVER:
                        decrypted.group.name = null;
                        decrypted.group.members = [];
                        decrypted.group.avatar = null;

                        break;
                    default:
                        throw new Error("Unknown group message type");
                    }
                }
            }.bind(this)));
        }

        for (var i in decrypted.attachments) {
            promises.push(this.handleAttachment(decrypted.attachments[i]));
        }
        return Promise.all(promises).then(function() {
            return decrypted;
        });
    }
}


module.exports = MessageReceiver;
