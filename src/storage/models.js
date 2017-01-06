
const Backbone = require('./backbone-redis');


const PreKey = Backbone.Model.extend({
    redisStorage: new Backbone.RedisStorage("preKeys")
});

const SignedPreKey = Backbone.Model.extend({
    redisStorage: new Backbone.RedisStorage("signedPreKeys")
});

const IdentityKey = Backbone.Model.extend({
    redisStorage: new Backbone.RedisStorage("identityKeys")
});

const Group = Backbone.Model.extend({
    redisStorage: new Backbone.RedisStorage("groups")
});


module.exports = {
    PreKey,
    SignedPreKey,
    IdentityKey,
    Group
};
