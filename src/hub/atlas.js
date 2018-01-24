// vim: ts=4:sw=4:expandtab

'use strict';

const DEFAULT_ATLAS_URL = 'https://atlas-dev.forsta.io';

const fetch = require('./fetch');
const storage = require('../storage');
const util = require('../util');

const credStoreKey = 'atlasCredential';
const urlStoreKey = 'atlasUrl';


function atobJWT(str) {
    /* See: https://github.com/yourkarma/JWT/issues/8 */
    return Buffer.from(str.replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString('binary');
}

function decodeJWT(encoded_token) {
    let token;
    try {
        const parts = encoded_token.split('.').map(atobJWT);
        token = {
            header: JSON.parse(parts[0]),
            payload: JSON.parse(parts[1]),
            secret: parts[2]
        };
    } catch(e) {
        throw new Error('Invalid Token');
    }
    if (!token.payload || !token.payload.exp) {
        throw TypeError("Invalid Token");
    }
    if (token.payload.exp * 1000 <= Date.now()) {
        throw Error("Expired Token");
    }
    return token;
}


class AtlasClient {

    constructor({url=DEFAULT_ATLAS_URL, jwt=null}) {
        this.url = url;
        if (jwt) {
            const jwtDict = decodeJWT(jwt);
            this.userId = jwtDict.payload.user_id;
            this.orgId = jwtDict.payload.org_id;
            this.authHeader = `JWT ${jwt}`;
        }
    }

    static async factory() {
        const url = await storage.getState(urlStoreKey);
        const jwt = await storage.getState(credStoreKey);
        return new this({url, jwt});
    }

    static async authenticateViaToken(userAuthToken, options) {
        const client = new this(options || {});
        const auth = await client.fetch('/v1/login/authtoken/', {
            method: 'POST',
            json: {
                userauthtoken: userAuthToken
            }
        });
        await storage.putState(credStoreKey, auth.token);
        await storage.putState(urlStoreKey, client.url);

        return { 
            url: client.url,
            jwt: auth.token
        };
    }

    static async requestAuthenticationCode(userTag, options) {
        const client = new this(options || {});
        const [user, org] = client.parseTag(userTag);
        await client.fetch(`/v1/login/send/${org}/${user}/`);
        return async smsCode => {
            const auth = await this.authenticateViaCode(userTag, smsCode, options);
            await storage.putState(credStoreKey, auth.token);
            await storage.putState(urlStoreKey, client.url);
        };
    }

    static async authenticateViaCode(userTag, code, options) {
        const client = new this(options || {});
        const [user, org] = client.parseTag(userTag);

        const result = await client.fetch('/v1/login/authtoken/', {
            method: 'POST',
            json: {
                authtoken: [org, user, code].join(':')
            }
        });

        return result;
    }

    parseTag(tag) {
        tag = tag.replace(/^@/, '');
        const index = tag.indexOf(':');
        if (index === -1) {
            return [tag, 'forsta'];
        } else {
            return [tag.substring(0, index), tag.substring(index + 1)];
        }
    }

    async fetch(urn, options) {
        options = options || {};
        options.headers = options.headers || new fetch.Headers();
        if (this.authHeader) {
            options.headers.set('Authorization', this.authHeader);
        }
        const url = [this.url, urn.replace(/^\//, '')].join('/');
        const resp = await fetch(url, options);
        const text = await resp.text();
        let json;
        if ((resp.headers.get('content-type') || '').startsWith('application/json')) {
            json = JSON.parse(text.trim() || '{}')
        } 
        if (!resp.ok) {
            const msg = `${urn} (${text})`;
            throw new util.RequestError(msg, resp, resp.status, text, json);
        }

        return json || text;
    }

    async maintainJWT(forceRefresh, authenticator, onRefresh) {
        /* Manage auth token expiration.  This routine will reschedule itself as needed. */
        let token = decodeJWT(await storage.getState(credStoreKey));
        const refreshDelay = t => (t.payload.exp - (Date.now() / 1000)) / 2;
        if (forceRefresh || refreshDelay(token) < 1) {
            const encodedToken = await storage.getState(credStoreKey);
            const resp = await this.fetch('/v1/api-token-refresh/', {
                method: 'POST',
                json: {token: encodedToken}
            });
            let jwt;
            if (!resp || !resp.token) {
                if (authenticator) {
                    const result = await authenticator();
                    console.info("Reauthenticated user in maintainJWT");
                    jwt = result.jwt;
                } else {
                    throw new TypeError("Unable to reauthenticate in maintainJWT");
                }
            } else {
                jwt = resp.token;
            }
            token = decodeJWT(jwt);
            console.info("Refreshed JWT in maintainJWT");
            await storage.putState(credStoreKey, jwt);
            this.authHeader = `JWT ${jwt}`;
            this.userId = token.payload.user_id;
            if (onRefresh) {
                try {
                    await onRefresh(token);
                } catch(e) {
                    console.error('onRefresh callback error:', e);
                }
            }
        }
        const nextUpdate = refreshDelay(token);
        console.info('maintainJWT will recheck auth token in ' + nextUpdate + ' seconds');
        util.sleep(nextUpdate).then(this.maintainJWT.bind(this, false, authenticator, onRefresh));
    }

    async resolveTags(expression) {
        expression = expression && expression.trim();
        if (!expression) {
            console.warn("Empty expression detected");
            // Do this while the server doesn't handle empty queries.
            return {
                universal: '',
                pretty: '',
                includedTagids: [],
                excludedTagids: [],
                userids: [],
                warnings: []
            };
        }
        const q = '?expression=' + encodeURIComponent(expression);
        const results = await this.fetch('/v1/directory/user/' + q);
        for (const w of results.warnings) {
            w.context = expression.substring(w.position, w.position + w.length);
        }
        if (results.warnings.length) {
            console.warn("Tag Expression Warning(s):", expression, results.warnings);
        }
        return results;
    }

    sanitizeTags(expression) {
        /* Clean up tags a bit. Add @ where needed.
         * NOTE: This does not currently support universal format! */
        const tagSplitRe = /([\s()^&+-]+)/;
        const tags = [];
        for (let tag of expression.trim().split(tagSplitRe)) {
            if (!tag) {
                continue;
            } else if (tag.match(/^[a-zA-Z]/)) {
                tag = '@' + tag;
            }
            tags.push(tag);
        }
        return tags.join(' ');
    }

    async getUsers(userIds, onlyDir) {
        const missing = new Set(userIds);
        const users = [];
        if (!onlyDir) {
            const resp = await this.fetch('/v1/user/?id_in=' + userIds.join());
            for (const user of resp.results) {
                users.push(user);
                missing.delete(user);
            }
        }
        if (missing.size) {
            const resp = await this.fetch('/v1/directory/user/?id_in=' +
                                          Array.from(missing).join());
            for (const user of resp.results) {
                users.push(user);
            }
        }
        return users;
    }

    async getDevices() {
        try {
            return (await this.fetch('/v1/provision/account')).devices;
        } catch(e) {
            if (e instanceof util.RequestError && e.code === 404) {
                return [];
            } else {
                throw e;
            }
        }
    }
}

module.exports = AtlasClient;
