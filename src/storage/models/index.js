
const Backbone = require('../backbone-localstorage.js');


const PreKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("preKeys")
});

const SignedPreKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("signedPreKeys")
});

const IdentityKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("identityKeys")
});

const Group = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("groups")
});


module.exports = {
    PreKey,
    SignedPreKey,
    IdentityKey,
    Group
};
