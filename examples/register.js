const relay = require('..');
const process = require('process');
const readline = require('readline');

process.on('unhandledRejection', error => {
    console.error(error);
    process.exit(1);
});

const rl = readline.createInterface(process.stdin, process.stdout);

async function input(prompt) {
    return await new Promise(resolve => rl.question(prompt, resolve));
};

(async function main() {
    const org = await input("Organization: ");
    const user = await input("Username: ");
    const validate = await relay.auth.requestCode(org, user);
    const code = await input("SMS Verification Code: ");
    const auth = await validate(code);
    await relay.AccountManager.register({jwt: auth.token});
    process.exit(0);
})();
