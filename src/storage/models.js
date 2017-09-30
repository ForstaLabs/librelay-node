
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


module.exports = {
    PreKey,
    SignedPreKey,
    IdentityKey
};
