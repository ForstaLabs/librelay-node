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
    const userTag await input("Enter your login (e.g user:org): ");
    const validator = await relay.AtlasClient.authenticate(userTag);
    const code = await input("SMS Verification Code: ");
    const atlasClient = await validator(code);
    await relay.AccountManager.register({jwt});
    await relay.storage.shutdown();
})();
