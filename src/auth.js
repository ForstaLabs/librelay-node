// vim: ts=4:sw=4:expandtab

'use strict';

const fetch = require('node-fetch');

const DEFAULT_URL = 'https://ccsm-dev-api.forsta.io';


async function requestCode(org, user, url=DEFAULT_URL) {
    const resp = await fetch(`${url}/v1/login/send/${org}/${user}/`);
    if (!resp.ok) {
        console.error('Request error:', await resp.text());
        throw Error(resp.status);
    }
    return code => validateCode(org, user, code, url);
}

async function validateCode(org, user, code, url=DEFAULT_URL) {
    const resp = await fetch(`${url}/v1/login/authtoken/`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({authtoken: [org, user, code].join(':')})
    });
    if (!resp.ok) {
        console.error('Request error:', await resp.text());
        throw Error(resp.status);
    }
    return await resp.json();
}

module.exports = {
    requestCode,
    validateCode
};
