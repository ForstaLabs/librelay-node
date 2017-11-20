
const hub = require('./hub');

module.exports = {
    MessageReceiver: require('./src/message_receiver.js'),
    MessageSender: require('./src/message_sender.js'),
    AtlasClient: hub.AtlasClient,
    SignalClient: hub.SignalClient,
    registerAccount: hub.registerAccount,
    registerDevice: hub.registerDevice,
    storage: require('./src/storage')
};
