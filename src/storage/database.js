/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

const convos = require('./models/conversations.js');

exports.id = 'superman';

exports.migrations = [{
    version: "1.0",
    migrate: function(transaction, next) {
        console.log('migration 1.0');
        console.log('creating object stores');
        var messages = transaction.db.createObjectStore("messages");
        messages.createIndex("conversation", ["conversationId", "received_at"], { unique: false });
        messages.createIndex("receipt", "sent_at", { unique: false });

        var conversations = transaction.db.createObjectStore("conversations");
        conversations.createIndex("inbox", "active_at", { unique: false });
        conversations.createIndex("group", "members", { unique: false, multiEntry: true });
        conversations.createIndex("type", "type", { unique: false });

        var groups = transaction.db.createObjectStore('groups');

        var sessions = transaction.db.createObjectStore('sessions');
        var identityKeys = transaction.db.createObjectStore('identityKeys');

        var preKeys = transaction.db.createObjectStore("preKeys");
        var signedPreKeys = transaction.db.createObjectStore("signedPreKeys");

        var items = transaction.db.createObjectStore("items");
        next();
    }
}, {
    version: "2.0",
    migrate: function(transaction, next) {
        console.log('migration 2.0');
        var conversations = transaction.objectStore("conversations");
        conversations.createIndex("search", "tokens", { unique: false, multiEntry: true });

        console.log('migrating search tokens');
        var all = new convos.ConversationCollection();
        all.fetch().then(function() {
            all.each(function(model) {
                model.updateTokens();
                model.save();
            });
        });
        next();
    }
}, {
    version: "3.0",
    migrate: function(transaction, next) {
        console.log('migration 3.0');
        var conversations = transaction.objectStore("items");

        console.log('migrating unread count');
        var all = new convos.ConversationCollection();
        all.fetch().then(function() {
            var unreadCount = all.reduce(function(total, model) {
                var count = model.get('unreadCount');
                if (count === undefined) {
                    count = 0;
                }
                return total + count;
            }, 0);
            storage.remove('unreadCount');
            storage.put('unreadCount', unreadCount);
        });
        next();
    }
}, {
    version: "4.0",
    migrate: function(transaction, next) {
        console.log('migration 4.0');
        console.log('migrating search tokens');
        var all = new convos.ConversationCollection();
        all.fetch().then(function() {
            all.each(function(c) {
                c.updateTokens();
                c.save();
            });
        });
        next();
    }
}, {
    version: "5.0",
    migrate: function(transaction, next) {
        console.log('migration 5.0');
        console.log('migrating registration flags');
        if (storage.get("browserRegistrationDone") === "") {
            storage.put("browserRegistrationDoneEver", "");
        }
        next();
    }
}, {
    version: "6.0",
    migrate: function(transaction, next) {
        console.log('migration 6.0');
        console.log('migrating registration flags');
        storage.onready(function() {
            if (storage.get("browserRegistrationDone") === "") {
                storage.put("browserRegistrationDoneEver", "");
                next();
            }
        });
        next();
    }
}, {
    version: "7.0",
    migrate: function(transaction, next) {
        console.log('migration 7.0');
        console.log('creating debug log');
        transaction.db.createObjectStore("debug");
        next();
    }
}, {
    version: "8.0",
    migrate: function(transaction, next) {
        console.log('migration 8.0');
        console.log('creating unread message index');
        var conversations = transaction.objectStore('messages');
        conversations.createIndex('unread', ['conversationId', 'unread'], { unique: false });
        next();
    }
}, {
    version: "9.0",
    migrate: function(transaction, next) {
        console.log('migration 9.0');
        console.log('marking contacts and groups active');
        var all = new convos.ConversationCollection();
        var myNumber = textsecure.storage.user.getNumber();
        all.fetch().then(function() {
            var inactive = all.filter(function(model) {
                return !model.get('active_at') && model.id !== myNumber;
            });
            inactive.sort(function(m1, m2) {
                var title1 = m1.getTitle().toLowerCase();
                var title2 = m2.getTitle().toLowerCase();
                if (title1 ===  title2) {
                    return 0;
                }
                if (title1 < title2) {
                    return -1;
                }
                if (title1 > title2) {
                    return 1;
                }
            });
            inactive.forEach(function(model) {
                if (model.isPrivate() || !model.get('left')) {
                    model.save({ active_at: 1 });
                }
            });
        });
        next();
    }
}, {
    version: "10.0",
    migrate: function(transaction, next) {
        console.log('migration 10.0');
        console.log('creating expiring message index');
        var messages = transaction.objectStore('messages');
        messages.createIndex('expire', 'expireTimer', { unique: false });
        next();
    }
}, {
    version: "13",
    migrate: function(transaction, next) {
        console.log('migration 13');
        console.log('change chromium to browser');
        storage.onready(function() {
            [
                ["chromiumRegistrationDoneEver", "browserRegistrationDoneEver"],
                ["chromiumRegistrationDone", "browserRegistrationDone"],
            ].forEach(function(tuple) {
                var v = storage.get(from);
                var from = tuple[0];
                var to = tuple[0];
                if (v !== undefined) {
                    storage.put(to, v);
                    storage.remove(from);
                }
            });
            next();
        })
    }
}];