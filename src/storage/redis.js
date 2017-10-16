const redis = require('redis');
const process = require('process');
const unifyOptions = require('redis/lib/createClient');


/* A proper async redis client */
class AsyncRedisClient extends redis.RedisClient {

    static createClient(...args) {
        const options = unifyOptions.apply(null, args);
        return new this(options);
    }

    _async(func, ...args) {
        return new Promise((resolve, reject) => {
            try {
                args.push((err, reply) => {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve(reply);
                    }
                });
                func.apply(this, args);
            } catch(e) {
                reject(e);
            }
        });
    }

    async get(ns, key) {
        return await this._async(super.hget, ns, key);
    }

    async set(ns, key, value) {
        return await this._async(super.hset, ns, key, value);
    }

    async keys(ns) {
        return await this._async(super.hkeys, ns);
    }

    async del(ns, key) {
        return await this._async(super.hdel, ns, key);
    }

    async exists(ns, key) {
        return await this._async(super.hexists, ns, key);
    }
}


const client = AsyncRedisClient.createClient(process.env.REDIS_URL);

async function set(ns, key, value) {
    if (value === undefined) {
        throw new Error("Tried to store undefined");
    }
    await client.set(ns, key, value);
}

async function get(ns, key, defaultValue) {
    if (await client.exists(ns, key)) {
        return await client.get(ns, key);
    } else {
        return defaultValue;
    }
}

async function has(ns, key) {
    return await client.exists(ns, key);
}

async function remove(ns, key) {
    await client.del(ns, key);
}

async function keys(ns, regex) {
    const keys = await client.keys(ns);
    return regex ? keys.filter(x => x.match(regex)) : keys;
}

function shutdown() {
    return client.quit();
}

module.exports = {
    set,
    get,
    has,
    remove,
    keys,
    shutdown
};
