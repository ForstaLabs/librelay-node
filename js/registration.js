/*
 * vim: ts=4:sw=4:expandtab
 */
'use strict';

exports.Registration = {
    markDone: function () {
        storage.put('browserRegistrationDoneEver', '');
        storage.put('browserRegistrationDone', '');
    },
    isDone: function () {
        return storage.get('browserRegistrationDone') === '';
    },
    everDone: function() {
        return storage.get('browserRegistrationDoneEver') === '' ||
               storage.get('browserRegistrationDone') === '';
    },
    remove: function() {
        storage.remove('browserRegistrationDone');
    }
};
