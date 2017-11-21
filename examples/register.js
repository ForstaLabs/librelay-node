const relay = require('..');
const process = require('process');
const readline = require('readline');

const url = 'https://ccsm-dev-api.forsta.io';

async function input(prompt) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    try {
        return await new Promise(resolve => rl.question(prompt, resolve));
    } finally {
        rl.close();
    }
}

(async function main() {
    //const userTag = await input("Enter your login (e.g user:org): ") || 'test.user:mayfieldtest';
    //const validator = await relay.AtlasClient.authenticate(userTag, {url});
    //await validator(await input("SMS Verification Code: "));
    //await relay.registerAccount();
    const iface = await relay.registerDevice({
        setProvisioningUrl: x => console.log(x),
    });
    await iface.done;
})().catch(e => console.error(e));
