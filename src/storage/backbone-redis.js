'use strict';


const Backbone = require('backbone');
const redis = require("./redis");


// Generate four random hex digits.
function S4() {
    return (((1+Math.random())*0x10000)|0).toString(16).substring(1);
}

// Generate a pseudo-GUID by concatenating random hexadecimal.
function guid() {
    return (S4()+S4()+"-"+S4()+"-"+S4()+"-"+S4()+"-"+S4()+S4()+S4());
}


class RedisStorage {

    constructor(name) {
        this.name = name;
        this.redis = redis; // XXX workout more customizable assignment
    }

    encode(value) {
        return JSON.stringify(value);
    }

    decode(data) {
        return JSON.parse(data);
    }

    async create(model) {
        if (!model.id && model.id !== 0) {
            model.id = guid();
            model.set(model.idAttribute, model.id);
        }
        await this.redis.put(this._itemName(model.id),
                             this.serialize(model));
        return await this.find(model);
    }

    async update(model) {
        await this.redis.put(this._itemName(model.id),
                             this.encode(model));
        return await this.find(model);
    }

    async find(model) {
        const data = await this.redis.get(this._itemName(model.id));
        if (data === null) {
            throw new Error(`Record Not Found: ${model.redisStorage.name}:${model.id}`);
        }
        return this.decode(data);
    }

    async findAll() {
        const ids = await this.redis.keys(this._itemName('*'));
        const results = [];
        for (const x of ids) {
            results.push(this.decode(await this.redis.get(x)));
        }
        return results;
    }

    async destroy(model) {
        await this.redis.remove(this._itemName(model.id));
        return model;
    }

    _itemName(id) {
        return `${this.name}-${id}`;
    }
}


/* XXX Monkey patch Backbone. */
Backbone.sync = async function(method, model, options) {
    const store = model.redisStorage || model.collection.redisStorage;
    let resp;
    try {
        if (method === 'read') {
            if (model.id !== undefined) {
                resp = await store.find(model);
            } else {
                resp = await store.findAll();
            }
        } else if (method === 'create') {
            resp = await store.create(model);
        } else if (method === 'update') {
            resp = await store.update(model);
        } else if (method === 'delete') {
            resp = await store.destroy(model);
        }

        if (resp) {
            model.trigger("sync", model, resp, options);
            if (options && options.success)
                options.success(resp);
        }
        return resp;
    } catch(e) {
        if (options && options.error) {
            options.error(e);
        }
        throw e;
    } finally {
        if (options && options.complete) {
            options.complete(resp);
        }
    }
};

Backbone.RedisStorage = RedisStorage;


module.exports = Backbone;
