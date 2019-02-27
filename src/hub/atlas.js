// vim: ts=4:sw=4:expandtab

const errors = require('../errors');
const fetch = require('./fetch');
const storage = require('../storage');
const util = require('../util');

const defaultUrl = 'https://atlas.forsta.io';
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


/**
 * A tag is of the form, "@label:org".  They can be used for describing users or groups.
 *
 * @typedef {string} Tag
 */

/**
 * Response from an authentication request indicating the type
 * of auth challenge required to complete.
 *
 * @typedef {Object} AuthenticationRequestChallenge
 * @property {string} type - The authentication type.  E.g. "password", "totp", etc..
 * @property {function} authenticate - Handler function to be called with challenge response.
 */

/**
 * Tag expression are informal arrangement of {@link Tag}s using set operators like
 * "-" (minus) "+" (plus).  Paranthesis can be used to create logical groups too.
 * For example "@joe + @brunchgroup" would respresent all users in the @brunchgroup
 * as well as @joe (assuming he was not already in @brunchgroup).  You can exclude
 * specific users with "-", ie. "@brunchgroup - @cindy" or even,
 * "@brunchgroup - (@joe + @cindy)".
 *
 * @typedef {string} TagExpression
 */

/**
 * A resolved tag expression is the computed set of data for a given {@link TagExpression}.
 * It represents a snapshot of the current state of membership for a tag expression.
 * The values can be cached for short periods but should avoid being stored permanently
 * as membership changes can occur behind the scenes.
 *
 * @typedef {Object} ResolvedTagExpression
 * @property {string[]} userids - Array of UUIDs belonging to this tag expression.
 * @property {string} universal - The universal (stable) representation of this tag expression
 *                                This value should be used when managing Thread.expression
 *                                values.
 * @property {string} pretty - A human readable version of the tag expression.  Still valid
 *                             syntax but should only be used for viewing.
 * @property {Array} warnings - Any warnings associated with the input expression.
 * @property {string[]} includedTagids - A list of tag UUIDs which are positively mentioned and
 *                                       as such have affected the final membership.
 * @property {string[]} excludedTagids - A list of tag UUIDs which are negatively mentioned and
 *                                       as such are NOT in the final membership.
 */

/**
 * Interface for the Forsta Atlas service.  Atlas provides user and tag managment.
 */
class AtlasClient {

    constructor({url=defaultUrl, jwt=null}) {
        this.url = url;
        if (jwt) {
            this.setJWT(jwt);
        }
    }

    setJWT(jwt) {
        const jwtDict = decodeJWT(jwt);
        this.userId = jwtDict.payload.user_id;
        this.orgId = jwtDict.payload.org_id;
        this.authHeader = `JWT ${jwt}`;
    }

    /**
     * Produce a default instance.
     * @returns {AtlasClient}
     */
    static async factory() {
        const url = await storage.getState(urlStoreKey);
        const jwt = await storage.getState(credStoreKey);
        return new this({url, jwt});
    }

    /**
     * Begin authentication process with Atlas server.
     *
     * @param {Tag} userTag
     * @param {Object} [options] - Options to be fed to {@link 
     * @returns {AuthenticationRequestChallenge}
     */
    static async requestAuthentication(userTag, options) {
        const client = new this(options || {});
        const [user, org] = client.parseTag(userTag);
        try {
            await client.fetch(`/v1/login/send/${org}/${user}/`);
        } catch(e) {
            if (e.code === 409) {
                if (e.response.non_field_errors.includes('totp auth required')) {
                    return {
                        type: "totp",
                        authenticate: (pw, otp) => this.authenticateViaPasswordOtp(userTag, pw, otp, options)
                    };
                } else {
                    return {
                        type: "password",
                        authenticate: pw => this.authenticateViaPassword(userTag, pw, options)
                    };
                }
            }
            throw e;
        }
        return {
            type: "sms",
            authenticate: code => this.authenticateViaCode(userTag, code, options)
        };
    }

    static async requestAuthenticationCode(userTag, options) {
        // DEPRECATED: Use `requestAuthentication` instead.
        const client = new this(options || {});
        const [user, org] = client.parseTag(userTag);
        await client.fetch(`/v1/login/send/${org}/${user}/`);
        return smsCode => this.authenticateViaCode(userTag, smsCode, options);
    }

    /**
     * Authentication challenge response for SMS-code based users.  You probably don't need to call
     * this method directly as it will be associated with
     * {@link AuthenticationRequestChallenge.authenticate} in most cases.
     *
     * @param {Tag} userTag
     * @param {string} code - The 6 digit SMS code you received
     * @param {Object} [options] - Constructor options for {@link AtlasClient}
     * @returns {AtlasClient}
     */
    static async authenticateViaCode(userTag, code, options) {
        const client = new this(options || {});
        const [user, org] = client.parseTag(userTag);
        const authtoken = `${org}:${user}:${code}`;
        await client.authenticate({authtoken});
        return client;
    }

    /**
     * Authentication challenge response for API token users.   Typically used by bots.
     *
     * @param {string} userauthtoken - The secret auth token for this user.
     * @param {Object} [options] - Constructor options for {@link AtlasClient}
     * @returns {AtlasClient}
     */
    static async authenticateViaToken(userauthtoken, options) {
        const client = new this(options || {});
        await client.authenticate({userauthtoken});
        return client;
    }

    /**
     * Authentication challenge response for password based users.  You probably don't need to call
     * this method directly as it will be associated with
     * {@link AuthenticationRequestChallenge.authenticate} in most cases.
     *
     * @param {Tag} userTag
     * @param {string} password
     * @param {Object} [options] - Constructor options for {@link AtlasClient}
     * @returns {AtlasClient}
     */
    static async authenticateViaPassword(fq_tag, password, options) {
        const client = new this(options || {});
        await client.authenticate({fq_tag, password});
        return client;
    }

    /**
     * Authentication challenge response for password+otp (two-factor auth) based users.
     * You probably don't need to call this method directly as it will be associated with
     * {@link AuthenticationRequestChallenge.authenticate} in most cases.
     *
     * @param {Tag} userTag
     * @param {string} password
     * @param {string} otp - 2FA code
     * @param {Object} [options] - Constructor options for {@link AtlasClient}
     * @returns {AtlasClient}
     */
    static async authenticateViaPasswordOtp(fq_tag, password, otp, options) {
        const client = new this(options || {});
        await client.authenticate({fq_tag, password, otp});
        return client;
    }

    async authenticate(creds) {
        /* Creds should be an object of these supported forms..
         * 1. Password auth:
         *    {
         *      fq_tag: "@foo:bar",
         *      password: "secret"
         *    }
         * 1.5 Password+TOTP auth:
         *    {
         *      fq_tag: "@foo:bar",
         *      password: "secret"
         *      otp: "code"
         *    }
         * 2. SMS auth: {
         *      authtoken: "123456",
         *    }
         * 3. Token auth: {
         *      userauthtoken: "APITOKEN",
         *    }
         */
        const auth = await this.fetch('/v1/login/', {
            method: 'POST',
            json: creds
        });
        this.setJWT(auth.token);
        await storage.putState(credStoreKey, auth.token);
        await storage.putState(urlStoreKey, this.url);
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

    /**
     * Perform an authenticated HTTP fetch to the Atlas service.
     *
     * @param {string} urn - The URN of the resource being requested.
     * @param {Object} [options] - Standard fetch options.
     * @returns {Object} - The response object (decoded JSON).
     */
    async fetch(urn, options) {
        options = options || {};
        options.headers = options.headers || new fetch.Headers();
        if (this.authHeader) {
            options.headers.set('Authorization', this.authHeader);
        }
        const url = [this.url, urn.replace(/^\//, '')].join('/');
        const resp = await fetch(url, options);
        const text = await resp.text();
        let respContent;
        if ((resp.headers.get('content-type') || '').startsWith('application/json') && text.trim()) {
            respContent = JSON.parse(text);
        } else {
            respContent = text;
        }
        if (!resp.ok) {
            const e = new errors.ProtocolError(resp.status, respContent);
            e.message = `${urn} (${text})`;
            throw e;
        }
        return respContent;
    }

    /**
     * A background task that will keep a sessions JWT fresh.
     *
     * @param {boolean} forceRefresh - Perform an immediate refresh.
     * @param {function} authenticator - Auth handler used for doing JWT refresh.
     * @param {function} [onRefresh] - Callback fired when refresh takes place.
     */
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

    /**
     * Take a tag expression (i.e "@foo + @bar - (@joe + @sarah)") and parse it into the
     * current user membership.
     *
     * @param {TagExpression} expression 
     * @returns {ResolvedTagExpression}
     */
    async resolveTags(expression) {
        return (await this.resolveTagsBatch([expression]))[0];
    }

    /**
     * Like {@link resolveTags} but performs a batched fetch with an array
     * of expressions.  The results are in the same order as the input array
     * and invalid response will be set to undefined.
     *
     * @param {TagExpression[]} expression
     * @returns {ResolvedTagExpression[]}
     */
    async resolveTagsBatch(expressions) {
        if (!expressions.length) {
            return [];
        }
        const resp = await this.fetch('/v1/tagmath/', {
            method: 'POST',
            json: {expressions}
        });
        /* Enhance the warnings a bit. */
        for (let i = 0; i < resp.results.length; i++) {
            const res = resp.results[i];
            const expr = expressions[i];
            for (const w of res.warnings) {
                w.context = expr.substr(w.position, w.length);
            }
        }
        return resp.results;
    }

    /**
     * Clean up tags a bit. Add @ where needed.
     * NOTE: This does not currently support universal format!
     *
     * @param {string} expression
     * @returns {string} Cleaned expression
     */
    sanitizeTags(expression) {
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

    /**
     * Get user objects based on a list of user IDs.
     *
     * @param {string[]} userIds - Array of user UUIDs to lookup.
     * @param {boolean} [onlyDir] - Only use the Forsta public directory. E.g. only
     *                              return lightweight user objects.
     * @returns {Object[]} User objects.
     */
    async getUsers(userIds, onlyDir) {
        const missing = new Set(userIds);
        const users = [];
        if (!onlyDir) {
            const resp = await this.fetch('/v1/user/?id_in=' + userIds.join());
            for (const user of resp.results) {
                users.push(user);
                missing.delete(user.id);
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

    /**
     * Update an existing users data
     *
     * @param {Object} data - A user data object as specified for the v1/user/ endpoint PATCH method
     * 
     * @returns {Boolean} indicates whether the patch was successful or not
     */
    async patchUser(data) {
        const op = { method: "PATCH", body: { ...data } };
        try{
            await this.fetch("/v1/user/" + data.id, op);
            return true;
        }catch (err){
            console.log(err);
            return false;
        }
    }

    /**
     * Add a new user to the existing user set
     *
     * @param {Object} data - A user data object as specified for the v1/user/ endpoint POST method
     * 
     * @returns {Boolean} indicates whether the post was successful or not
     */
    async postUser(data) {
        const op = { method: "POST", body: { ...data } };
        try{
            await this.fetch("/v1/user/", op);
            return true;
        }catch (err){
            console.log(err);
            return false;
        }
    }

    /**
     * Register a new user with atlas
     *
     * @param {Object} body - A user data object in the form:
     *  {   
     *      captcha, 
     *      phone, 
     *      email, 
     *      fullname, 
     *      tag_slug, 
     *      password, 
     *      org_name, 
     *      org_slug 
     * }
     * All fields are required except phone
     * 
     * Use the site key 6Lcr4JMUAAAAAOljN5puqdFrcVeCyexMNHlWtWHX as the seed
     * for your recaptcha token.
     * 
     * @returns {Object} - {nametag, orgslug, jwt}
     */
    async postJoin(body) {
        try{
            const result = await this.fetch("/v1/join/", { method: "POST", body });
            return result;
        }catch (err){
            console.log(err);
            return null;
        }
    }

    /**
     *The current set of known devices for your account.
     *
     * @returns {Object[]} Device info objects.
     */
    async getDevices() {
        try {
            return (await this.fetch('/v1/provision/account')).devices;
        } catch(e) {
            if (e instanceof errors.ProtocolError && e.code === 404) {
                return [];
            } else {
                throw e;
            }
        }
    }
}

module.exports = AtlasClient;
