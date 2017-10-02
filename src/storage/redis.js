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

    async get(key) {
        return await this._async(super.get, key);
    }

    async set(key, value) {
        return await this._async(super.set, key, value);
    }

    async keys(pattern) {
        return await this._async(super.keys, pattern);
    }

    async del(key) {
        return await this._async(super.del, key);
    }

    async exists(key) {
        return await this._async(super.exists, key);
    }
}


const client = AsyncRedisClient.createClient(process.env.REDIS_URL);
const cache = new Map();

function encode(data) {
    const o = {};
    if (data instanceof Buffer) {
        o.type = 'buffer';
        o.data = data.toString('base64');
    } else if (data instanceof ArrayBuffer) {
        throw TypeError("ArrayBuffer not supported");
    } else if (data instanceof Uint8Array) {
        o.type = 'uint8array';
        o.data = Buffer.from(data).toString('base64');
    } else {
        o.data = data;
    }
    return JSON.stringify(o);
}

function decode(obj) {
    const o = JSON.parse(obj);
    if (o.type) {
        if (o.type === 'buffer') {
            return Buffer.from(o.data, 'base64');
        } else if (o.type === 'uint8array') {
            return Uint8Array.from(Buffer.from(o.data, 'base64'));
        } else {
            throw TypeError("Unsupported type: " + o.type);
        }
    } else {
        return o.data;
    }
}


async function put(key, value) {
    if (value === undefined) {
        throw new Error("Tried to store undefined");
    }
    await client.set(key, encode(value));
    cache.set(key, value);
}

async function putDict(dict) {
    const saves = [];
    for (const x of Object.entries(dict)) {
        cache.set(x[0], x[1]);
        saves.push(client.set(x[0], encode(x[1])).catch(() => cache.delete(x[0])));
    }
    await Promise.all(saves);
}

async function get(key, defaultValue) {
    if (cache.has(key)) {
        return cache.get(key);
    }
    if (await client.exists(key)) {
        const value = decode(await client.get(key));
        cache.set(key, value);
        return value;
    } else {
        return defaultValue;
    }
}

async function getDict(keys) {
    const values = await Promise.all(keys.map(k => client.get(k)));
    const dict = {};
    for (let i = 0; i < keys.length; i++) {
        dict[keys[i]] = decode(values[i]);
    }
    return dict;
}

async function remove(key) {
    await client.del(key);
    cache.delete(key);
}

async function keys(glob_pattern) {
    return await client.keys(glob_pattern);
}

module.exports = {
    put,
    putDict,
    get,
    getDict,
    remove,
    keys
};
