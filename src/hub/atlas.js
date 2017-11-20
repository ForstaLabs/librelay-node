// vim: ts=4:sw=4:expandtab

'use strict';

const fetch = require('./fetch');
const storage = require('../storage');
const urls = require('./urls');
const util = require('../util');

const credFile = 'atlasCredential';


class AtlasClient {

    constructor({url=urls.atlas, authHeader}) {
        this.url = url;
        this.authHeader = authHeader;
    }

    static async factory() {
        const encodedToken = await this.getEncodedToken();
        const cred = await this.loadCredential();
        return new this({
            url: cred.URL,
            authHeader: `JWT ${encodedToken}`
        });
    }

    static async authenticate(userTag, url=urls.atlas) {
        client = new this({url});
        const [user, org] = client.parseTag(userTag);
        await client.fetch(`/v1/login/send/${org}/${user}/`);
        return async smsCode => {
            const auth = await this.fetch('/v1/login/authtoken/', {
                method: 'POST',
                json: {
                    authtoken: [org, user, smsCode].join(':')
                }
            });
            await this.storeCredential(auth.token);
            
        };
    }

    parseTag(tag) {
        tag = tag.replace(/^@/, '');
        const index = tag.indexOf(':');
        if (index === -1) {
            return [tag, 'forsta'];
        } else {
            return [tag.substring(0, index), tag.substring(index)];
        }
    }

    atobJWT(str) {
        /* See: https://github.com/yourkarma/JWT/issues/8 */
        return Buffer.from(str.replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString('binary');
    }

    async loadCredential() {
        return await storage.getState(credFile);
    }

    async storeCredential(data) {
        await storage.putState(credFile, data);
    }

    decodeToken(encoded_token) {
        let token;
        try {
            const parts = encoded_token.split('.').map(this.atobJWT);
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

    async getEncodedToken() {
        const cred = await this.loadCredential();
        if (!cred || !cred.API || !cred.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        return cred.API.TOKEN;
    }

    async updateEncodedToken(encodedToken) {
        const cred = await this.loadCredential();
        if (!cred || !cred.API || !cred.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        cred.API.TOKEN = encodedToken;
        await this.storeCredential(cred);
        this.authHeader = `JWT ${encodedToken}`;
    }

    async getToken() {
        return this.decodeToken(await this.getEncodedToken());
    }

    async fetch(urn, options) {
        options = options || {};
        options.headers = options.headers || new fetch.Headers();
        if (this.authHeader) {
            options.headers.set('Authorization', this.authHeader);
        }
        const url = [this.url, urn.replace(/^\//, '')].join('/');
        const resp = await fetch(url, options);
        if (!resp.ok) {
            const msg = urn + ` (${await resp.text()})`;
            let error;
            if (resp.status === 404) {
                 error = new ReferenceError(msg);
            } else {
                error = new Error(msg);
            }
            error.code = resp.status;
            throw error;
        }
        return await resp.json();
    }

    async maintainToken(forceRefresh, onRefresh) {
        /* Manage auth token expiration.  This routine will reschedule itself as needed. */
        let token = await this.getToken();
        const refreshDelay = t => (t.payload.exp - (Date.now() / 1000)) / 2;
        if (forceRefresh || refreshDelay(token) < 1) {
            const encodedToken = await this.getEncodedToken();
            const resp = await this.fetch('/v1/api-token-refresh/', {
                method: 'POST',
                json: {token: encodedToken}
            });
            if (!resp || !resp.token) {
                throw new TypeError("Token Refresh Error");
            }
            await this.updateEncodedToken(resp.token);
            console.info("Refreshed auth token");
            token = await this.getToken();
            if (onRefresh) {
                try {
                    await onRefresh(token);
                } catch(e) {
                    console.error('onRefresh callback error:', e);
                }
            }
        }
        const nextUpdate = refreshDelay(token);
        console.info('Will recheck auth token in ' + nextUpdate + ' seconds');
        util.sleep(nextUpdate).then(this.maintainToken.bind(this, undefined, onRefresh));
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

    async getUsers(userIds) {
        const missing = [];
        const users = await Promise.all(userIds.map(async id => {
            try {
                return await this.fetch(`/v1/user/${id}/`);
            } catch(e) {
                if (!(e instanceof ReferenceError)) {
                    throw e;
                }
                missing.push(id);
            }
        }));
        if (missing.length) {
            const query = '?id_in=' + missing.join(',');
            const resp = await this.fetch('/v1/directory/user/' + query);
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
            if (e instanceof ReferenceError) {
                return undefined;
            } else {
                throw e;
            }
        }
    }
}

module.exports = AtlasClient;
