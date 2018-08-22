
if (!console.debug) {
    console.debug = function nodebug() {};
}

const hub = require('./hub');

module.exports = {
    AtlasClient: hub.AtlasClient,
    Attachment: require('./attachment'),
    MessageReceiver: require('./message_receiver.js'),
    MessageSender: require('./message_sender.js'),
    SignalClient: hub.SignalClient,
    registerAccount: hub.registerAccount,
    registerDevice: hub.registerDevice,
    storage: require('./storage'),
    util: require('./util'),
    exchange: require('./exchange'),
    errors: require('./errors')
};

/*
 * Global jsdoc typedefs...
 */

/**
 * @typedef KeyPair
 * @type {Object}
 * @property {Buffer} pubKey
 * @property {Buffer} privKey
 */


/**
 * String encoding of a fully qualified user address.  The value should be of the form
 * UUID[.DEVICE_ID], where the UUID is the hex formatted UUID for a given user and the
 * DEVICE_ID is the integer number representing the device of that user.
 *
 * @typedef EncodedUserAddress
 * @type {string}
 * @example be1cfd18-d7e9-4689-8870-e9d2773e364d.1000
 */
