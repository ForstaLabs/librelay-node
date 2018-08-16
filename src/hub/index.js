// vim: ts=4:sw=4:expandtab

const registration = require('./registration');

module.exports = {
    AtlasClient: require('./atlas'),
    SignalClient: require('./signal'),
    registerAccount: registration.registerAccount,
    registerDevice: registration.registerDevice,
};
