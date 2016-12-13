/*
 * vim: ts=4:sw=4:expandtab
 */

const protobufs = require('./protobufs.js');
const libsignal = require('libsignal');
const crypto = require('./crypto.js');
const errors = require('./errors.js');
const storage = require('./storage');
const api = require('./api.js');


function stringToArrayBuffer(str) {
    if (typeof str !== 'string') {
        throw new Error('Passed non-string to stringToArrayBuffer');
    }
    var res = new ArrayBuffer(str.length);
    var uint = new Uint8Array(res);
    for (var i = 0; i < str.length; i++) {
        uint[i] = str.charCodeAt(i);
    }
    return res;
}

function Message(options) {
    this.body        = options.body;
    this.attachments = options.attachments || [];
    this.group       = options.group;
    this.flags       = options.flags;
    this.recipients  = options.recipients;
    this.timestamp   = options.timestamp;
    this.needsSync   = options.needsSync;
    this.expireTimer = options.expireTimer;

    if (!(this.recipients instanceof Array) || this.recipients.length < 1) {
        throw new Error('Invalid recipient list');
    }

    if (!this.group && this.recipients.length > 1) {
        throw new Error('Invalid recipient list for non-group');
    }

    if (typeof this.timestamp !== 'number') {
        throw new Error('Invalid timestamp');
    }

    if (this.expireTimer !== undefined && this.expireTimer !== null) {
        if (typeof this.expireTimer !== 'number' || !(this.expireTimer >= 0)) {
            throw new Error('Invalid expireTimer');
        }
    }

    if (this.attachments) {
        if (!(this.attachments instanceof Array)) {
            throw new Error('Invalid message attachments');
        }
    }
    if (this.flags !== undefined) {
        if (typeof this.flags !== 'number') {
            throw new Error('Invalid message flags');
        }
    }
    if (this.isEndSession()) {
        if (this.body !== null || this.group !== null || this.attachments.length !== 0) {
            throw new Error('Invalid end session message');
        }
    } else {
        if ( (typeof this.timestamp !== 'number') ||
            (this.body && typeof this.body !== 'string') ) {
            throw new Error('Invalid message body');
        }
        if (this.group) {
            if ( (typeof this.group.id !== 'string') ||
                (typeof this.group.type !== 'number') ) {
                throw new Error('Invalid group context');
            }
        }
    }
}

Message.prototype = {
    constructor: Message,
    isEndSession: function() {
        return (this.flags & protobufs.DataMessage.Flags.END_SESSION);
    },
    toProto: function() {
        if (this.dataMessage instanceof protobufs.DataMessage) {
            return this.dataMessage;
        }
        var proto         = new protobufs.DataMessage();
        if (this.body) {
          proto.body        = this.body;
        }
        proto.attachments = this.attachmentPointers;
        if (this.flags) {
            proto.flags = this.flags;
        }
        if (this.group) {
            proto.group      = new protobufs.GroupContext();
            proto.group.id   = stringToArrayBuffer(this.group.id);
            proto.group.type = this.group.type
        }
        if (this.expireTimer) {
            proto.expireTimer = this.expireTimer;
        }

        this.dataMessage = proto;
        return proto;
    },
    toArrayBuffer: function() {
        return this.toProto().toArrayBuffer();
    }
};

function MessageSender(url, username, password, attachment_server_url) {
    this.server = new api.RelayServer(url, username, password, attachment_server_url);
    this.pendingMessages = {};
}

MessageSender.prototype = {
    constructor: MessageSender,
    makeAttachmentPointer: function(attachment) {
        if (typeof attachment !== 'object' || attachment == null) {
            return Promise.resolve(undefined);
        }
        var proto = new protobufs.AttachmentPointer();
        proto.key = libsignal.crypto.getRandomBytes(64);

        var iv = libsignal.crypto.getRandomBytes(16);
        return crypto.encryptAttachment(attachment.data, proto.key, iv).then(function(encryptedBin) {
            return this.server.putAttachment(encryptedBin).then(function(id) {
                proto.id = id;
                proto.contentType = attachment.contentType;
                return proto;
            });
        }.bind(this));
    },

    retransmitMessage: function(number, jsonData, timestamp) {
        var outgoing = new OutgoingMessage(this.server);
        return outgoing.transmitMessage(number, jsonData, timestamp);
    },

    tryMessageAgain: function(number, encodedMessage, timestamp) {
        var proto = protobufs.DataMessage.decode(encodedMessage);
        return this.sendIndividualProto(number, proto, timestamp);
    },

    queueJobForNumber: function(number, runJob) {
        var runPrevious = this.pendingMessages[number] || Promise.resolve();
        var runCurrent = this.pendingMessages[number] = runPrevious.then(runJob, runJob);
        runCurrent.then(function() {
            if (this.pendingMessages[number] === runCurrent) {
                delete this.pendingMessages[number];
            }
        }.bind(this));
    },

    uploadMedia: function(message) {
        return Promise.all(
            message.attachments.map(this.makeAttachmentPointer.bind(this))
        ).then(function(attachmentPointers) {
            message.attachmentPointers = attachmentPointers;
        }).catch(function(error) {
            if (error instanceof Error && error.name === 'HTTPError') {
                throw new errors.MessageError(message, error);
            } else {
                throw error;
            }
        });
    },

    sendMessage: function(attrs) {
        var message = new Message(attrs);
        return this.uploadMedia(message).then(function() {
            return new Promise(function(resolve, reject) {
                this.sendMessageProto(
                    message.timestamp,
                    message.recipients,
                    message.toProto(),
                    function(res) {
                        res.dataMessage = message.toArrayBuffer();
                        if (res.errors.length > 0) {
                            reject(res);
                        } else {
                            resolve(res);
                        }
                    }
                );
            }.bind(this));
        }.bind(this));
    },
    sendMessageProto: function(timestamp, numbers, message, callback) {
        var outgoing = new OutgoingMessage(this.server, timestamp, numbers, message, callback);

        numbers.forEach(function(number) {
            this.queueJobForNumber(number, function() {
                return outgoing.sendToNumber(number);
            });
        }.bind(this));
    },

    sendIndividualProto: function(number, proto, timestamp) {
        return new Promise(function(resolve, reject) {
            this.sendMessageProto(timestamp, [number], proto, function(res) {
                if (res.errors.length > 0)
                    reject(res);
                else
                    resolve(res);
            });
        }.bind(this));
    },

    sendSyncMessage: function(encodedDataMessage, timestamp, destination, expirationStartTimestamp) {
        var myNumber = storage.user.getNumber();
        var myDevice = storage.user.getDeviceId();
        if (myDevice == 1) {
            return Promise.resolve();
        }

        var dataMessage = protobufs.DataMessage.decode(encodedDataMessage);
        var sentMessage = new protobufs.SyncMessage.Sent();
        sentMessage.timestamp = timestamp;
        sentMessage.message = dataMessage;
        if (destination) {
            sentMessage.destination = destination;
        }
        if (expirationStartTimestamp) {
            sentMessage.expirationStartTimestamp = expirationStartTimestamp;
        }
        var syncMessage = new protobufs.SyncMessage();
        syncMessage.sent = sentMessage;
        var contentMessage = new protobufs.Content();
        contentMessage.syncMessage = syncMessage;
        return this.sendIndividualProto(myNumber, contentMessage, Date.now());
    },

    sendRequestGroupSyncMessage: function() {
        var myNumber = storage.user.getNumber();
        var myDevice = storage.user.getDeviceId();
        if (myDevice != 1) {
            var request = new protobufs.SyncMessage.Request();
            request.type = protobufs.SyncMessage.Request.Type.GROUPS;
            var syncMessage = new protobufs.SyncMessage();
            syncMessage.request = request;
            var contentMessage = new protobufs.Content();
            contentMessage.syncMessage = syncMessage;

            return this.sendIndividualProto(myNumber, contentMessage, Date.now());
        }
    },

    sendRequestContactSyncMessage: function() {
        var myNumber = storage.user.getNumber();
        var myDevice = storage.user.getDeviceId();
        if (myDevice != 1) {
            var request = new protobufs.SyncMessage.Request();
            request.type = protobufs.SyncMessage.Request.Type.CONTACTS;
            var syncMessage = new protobufs.SyncMessage();
            syncMessage.request = request;
            var contentMessage = new protobufs.Content();
            contentMessage.syncMessage = syncMessage;

            return this.sendIndividualProto(myNumber, contentMessage, Date.now());
        }
    },
    syncReadMessages: function(reads) {
        var myNumber = storage.user.getNumber();
        var myDevice = storage.user.getDeviceId();
        if (myDevice != 1) {
            var syncMessage = new protobufs.SyncMessage();
            syncMessage.read = [];
            for (var i = 0; i < reads.length; ++i) {
                var read = new protobufs.SyncMessage.Read();
                read.timestamp = reads[i].timestamp;
                read.sender = reads[i].sender;
                syncMessage.read.push(read);
            }
            var contentMessage = new protobufs.Content();
            contentMessage.syncMessage = syncMessage;

            return this.sendIndividualProto(myNumber, contentMessage, Date.now());
        }
    },

    sendGroupProto: function(numbers, proto, timestamp) {
        timestamp = timestamp || Date.now();
        var me = storage.user.getNumber();
        numbers = numbers.filter(function(number) { return number != me; });
        if (numbers.length === 0) {
            return Promise.reject(new Error('No other members in the group'));
        }

        return new Promise(function(resolve, reject) {
            this.sendMessageProto(timestamp, numbers, proto, function(res) {
                res.dataMessage = proto.toArrayBuffer();
                if (res.errors.length > 0)
                    reject(res);
                else
                    resolve(res);
            }.bind(this));
        }.bind(this));
    },

    sendMessageToNumber: function(number, messageText, attachments, timestamp, expireTimer) {
        return this.sendMessage({
            recipients  : [number],
            body        : messageText,
            timestamp   : timestamp,
            attachments : attachments,
            needsSync   : true,
            expireTimer : expireTimer
        });
    },

    closeSession: function(number, timestamp) {
        console.log('sending end session');
        var proto = new protobufs.DataMessage();
        proto.body = "TERMINATE";
        proto.flags = protobufs.DataMessage.Flags.END_SESSION;
        return this.sendIndividualProto(number, proto, timestamp).then(function(res) {
            return storage.protocol.getDeviceIds(number).then(function(deviceIds) {
                return Promise.all(deviceIds.map(function(deviceId) {
                    var address = new libsignal.SignalProtocolAddress(number, deviceId);
                    console.log('closing session for', address.toString());
                    var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
                    return sessionCipher.closeOpenSessionForDevice();
                })).then(function() {
                    return res;
                });
            });
        });
    },

    sendMessageToGroup: function(groupId, messageText, attachments, timestamp, expireTimer) {
        return storage.groups.getNumbers(groupId).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));

            var me = storage.user.getNumber();
            numbers = numbers.filter(function(number) { return number != me; });
            if (numbers.length === 0) {
                return Promise.reject(new Error('No other members in the group'));
            }

            return this.sendMessage({
                recipients  : numbers,
                body        : messageText,
                timestamp   : timestamp,
                attachments : attachments,
                needsSync   : true,
                expireTimer : expireTimer,
                group: {
                    id: groupId,
                    type: protobufs.GroupContext.Type.DELIVER
                }
            });
        }.bind(this));
    },

    createGroup: function(numbers, name, avatar) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();

        return storage.groups.createNewGroup(numbers).then(function(group) {
            proto.group.id = stringToArrayBuffer(group.id);
            var numbers = group.numbers;

            proto.group.type = protobufs.GroupContext.Type.UPDATE;
            proto.group.members = numbers;
            proto.group.name = name;

            return this.makeAttachmentPointer(avatar).then(function(attachment) {
                proto.group.avatar = attachment;
                return this.sendGroupProto(numbers, proto).then(function() {
                    return proto.group.id;
                });
            }.bind(this));
        }.bind(this));
    },

    updateGroup: function(groupId, name, avatar, numbers) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();

        proto.group.id = stringToArrayBuffer(groupId);
        proto.group.type = protobufs.GroupContext.Type.UPDATE;
        proto.group.name = name;

        return storage.groups.addNumbers(groupId, numbers).then(function(numbers) {
            if (numbers === undefined) {
                return Promise.reject(new Error("Unknown Group"));
            }
            proto.group.members = numbers;

            return this.makeAttachmentPointer(avatar).then(function(attachment) {
                proto.group.avatar = attachment;
                return this.sendGroupProto(numbers, proto).then(function() {
                    return proto.group.id;
                });
            }.bind(this));
        }.bind(this));
    },

    addNumberToGroup: function(groupId, number) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();
        proto.group.id = stringToArrayBuffer(groupId);
        proto.group.type = protobufs.GroupContext.Type.UPDATE;

        return storage.groups.addNumbers(groupId, [number]).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));
            proto.group.members = numbers;

            return this.sendGroupProto(numbers, proto);
        }.bind(this));
    },

    setGroupName: function(groupId, name) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();
        proto.group.id = stringToArrayBuffer(groupId);
        proto.group.type = protobufs.GroupContext.Type.UPDATE;
        proto.group.name = name;

        return storage.groups.getNumbers(groupId).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));
            proto.group.members = numbers;

            return this.sendGroupProto(numbers, proto);
        }.bind(this));
    },

    setGroupAvatar: function(groupId, avatar) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();
        proto.group.id = stringToArrayBuffer(groupId);
        proto.group.type = protobufs.GroupContext.Type.UPDATE;

        return storage.groups.getNumbers(groupId).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));
            proto.group.members = numbers;

            return this.makeAttachmentPointer(avatar).then(function(attachment) {
                proto.group.avatar = attachment;
                return this.sendGroupProto(numbers, proto);
            }.bind(this));
        }.bind(this));
    },

    leaveGroup: function(groupId) {
        var proto = new protobufs.DataMessage();
        proto.group = new protobufs.GroupContext();
        proto.group.id = stringToArrayBuffer(groupId);
        proto.group.type = protobufs.GroupContext.Type.QUIT;

        return storage.groups.getNumbers(groupId).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));
            return storage.groups.deleteGroup(groupId).then(function() {
                return this.sendGroupProto(numbers, proto);
            }.bind(this));
        });
    },
    sendExpirationTimerUpdateToGroup: function(groupId, expireTimer, timestamp) {
        return storage.groups.getNumbers(groupId).then(function(numbers) {
            if (numbers === undefined)
                return Promise.reject(new Error("Unknown Group"));

            var me = storage.user.getNumber();
            numbers = numbers.filter(function(number) { return number != me; });
            if (numbers.length === 0) {
                return Promise.reject(new Error('No other members in the group'));
            }
            return this.sendMessage({
                recipients  : numbers,
                timestamp   : timestamp,
                needsSync   : true,
                expireTimer : expireTimer,
                flags       : protobufs.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
                group: {
                    id: groupId,
                    type: protobufs.GroupContext.Type.DELIVER
                }
            });
        }.bind(this));
    },
    sendExpirationTimerUpdateToNumber: function(number, expireTimer, timestamp) {
        var proto = new protobufs.DataMessage();
        return this.sendMessage({
            recipients  : [number],
            timestamp   : timestamp,
            needsSync   : true,
            expireTimer : expireTimer,
            flags       : protobufs.DataMessage.Flags.EXPIRATION_TIMER_UPDATE
        });
    }
};

const _MessageSender = function(url, username, password, attachment_server_url) {
    var sender = new MessageSender(url, username, password, attachment_server_url);
    errors.replay.registerFunction(sender.tryMessageAgain.bind(sender), errors.replay.Type.ENCRYPT_MESSAGE);
    errors.replay.registerFunction(sender.retransmitMessage.bind(sender), errors.replay.Type.TRANSMIT_MESSAGE);
    errors.replay.registerFunction(sender.sendMessage.bind(sender), errors.replay.Type.REBUILD_MESSAGE);

    this.sendExpirationTimerUpdateToNumber = sender.sendExpirationTimerUpdateToNumber.bind(sender);
    this.sendExpirationTimerUpdateToGroup  = sender.sendExpirationTimerUpdateToGroup .bind(sender);
    this.sendRequestGroupSyncMessage       = sender.sendRequestGroupSyncMessage      .bind(sender);
    this.sendRequestContactSyncMessage     = sender.sendRequestContactSyncMessage    .bind(sender);
    this.sendMessageToNumber               = sender.sendMessageToNumber              .bind(sender);
    this.closeSession                      = sender.closeSession                     .bind(sender);
    this.sendMessageToGroup                = sender.sendMessageToGroup               .bind(sender);
    this.createGroup                       = sender.createGroup                      .bind(sender);
    this.updateGroup                       = sender.updateGroup                      .bind(sender);
    this.addNumberToGroup                  = sender.addNumberToGroup                 .bind(sender);
    this.setGroupName                      = sender.setGroupName                     .bind(sender);
    this.setGroupAvatar                    = sender.setGroupAvatar                   .bind(sender);
    this.leaveGroup                        = sender.leaveGroup                       .bind(sender);
    this.sendSyncMessage                   = sender.sendSyncMessage                  .bind(sender);
    this.syncReadMessages                  = sender.syncReadMessages                 .bind(sender);
};

_MessageSender.prototype = {
    constructor: MessageSender
};

module.exports = _MessageSender;
