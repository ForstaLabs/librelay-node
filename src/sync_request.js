/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const EventTarget = require('./event_target.js');
const MessageSender = require('./message_sender.js');
const MessageReceiver = require('./message_receiver.js');


function SyncRequest(sender, receiver) {
    if (!(sender instanceof MessageSender) || !(receiver instanceof MessageReceiver)) {
        throw new Error('Tried to construct a SyncRequest without MessageSender and MessageReceiver');
    }
    this.receiver = receiver;

    this.oncontact = this.onContactSyncComplete.bind(this);
    receiver.addEventListener('contactsync', this.oncontact);

    this.ongroup = this.onGroupSyncComplete.bind(this);
    receiver.addEventListener('groupsync', this.ongroup);

    sender.sendRequestContactSyncMessage().then(function() {
        sender.sendRequestGroupSyncMessage();
    });
    this.timeout = setTimeout(this.onTimeout.bind(this), 60000);
}

SyncRequest.prototype = new EventTarget();

SyncRequest.prototype.extend({

    constructor: SyncRequest,

    onContactSyncComplete: function() {
        this.contactSync = true;
        this.update();
    },

    onGroupSyncComplete: function() {
        this.groupSync = true;
        this.update();
    },

    update: function() {
        if (this.contactSync && this.groupSync) {
            this.dispatchEvent(new Event('success'));
            this.cleanup();
        }
    },

    onTimeout: function() {
        if (this.contactSync || this.groupSync) {
            this.dispatchEvent(new Event('success'));
        } else {
            this.dispatchEvent(new Event('timeout'));
        }
        this.cleanup();
    },

    cleanup: function() {
        clearTimeout(this.timeout);
        this.receiver.removeEventListener('contactsync', this.oncontact);
        this.receiver.removeEventListener('groupSync', this.ongroup);
        delete this.listeners;
    }
});

const _SyncRequest = function(sender, receiver) {
    var syncRequest = new SyncRequest(sender, receiver);
    this.addEventListener    = syncRequest.addEventListener.bind(syncRequest);
    this.removeEventListener = syncRequest.removeEventListener.bind(syncRequest);
};

_SyncRequest.prototype = {
    constructor: SyncRequest
};

module.exports = _SyncRequest;
