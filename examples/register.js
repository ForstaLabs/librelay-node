const relay = require('..');
const process = require('process');
const readline = require('readline');

async function input(prompt) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    try {
        return await new Promise(resolve => rl.question(prompt, resolve));
    } finally {
        rl.close();
    }
}

(async function main() {
    const [user, org] = (await input("Enter your login (e.g user:org): ")).split(':');
    const validateCallback = await relay.auth.requestCode(org, user);
    const code = await input("SMS Verification Code: ");
    const jwt = (await validateCallback(code)).jwt;
    await relay.AccountManager.register({jwt});
    await relay.storage.shutdown();
})();
