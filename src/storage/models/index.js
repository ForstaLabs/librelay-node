
const Backbone = require('../backbone-localstorage.js');


const PreKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("preKeys")
});

const SignedPreKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("signedPreKeys")
});

const Session = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("sessions")
});

const SessionCollection = Backbone.Collection.extend({
    localStorage: new Backbone.LocalStorage("sessions"),
    model: Session,
    fetchSessionsForNumber: function(number) {
        return this.fetch({range: [number + '.1', number + '.' + ':']});
    }
});

const IdentityKey = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("identityKeys")
});

const Group = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("groups")
});

const Item = Backbone.Model.extend({
    localStorage: new Backbone.LocalStorage("items")
});

const ItemCollection = Backbone.Collection.extend({
    model: Item,
    localStorage: new Backbone.LocalStorage("items")
});

module.exports = {
    PreKey,
    SignedPreKey,
    Session,
    SessionCollection,
    IdentityKey,
    Group,
    Item,
    ItemCollection
};
