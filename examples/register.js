const relay = require('..');
const process = require('process');
const readline = require('readline');

const ORG = 'robots';
const USER = 'bot.1';

var rl = readline.createInterface(process.stdin, process.stdout);
async function input(prompt) {
    return await new Promise(resolve => rl.question(prompt, resolve));
};

(async function() {
    let am;
    const validate = await relay.auth.requestCode(ORG, USER);
    const code = await input("Verification Code: ");
    const auth = await validate(code);
    const jwt = auth.token;
    
    try {
        am = await relay.AccountManager.registerAccount({jwt});
    } catch(e) {
        debugger;
    }
    debugger;
})();

