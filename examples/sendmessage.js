const relay = require('..');
const process = require('process');
const readline = require('readline');

process.on('unhandledRejection', error => {
    console.error(error);
    //process.exit(1);
});

const rl = readline.createInterface(process.stdin, process.stdout);

async function input(prompt) {
    return await new Promise(resolve => rl.question(prompt, resolve));
};

async function onMessage(ev) {
    console.log("Got Message", ev.data);
}

(async function main() {
    const msgReceiver = await relay.MessageReceiver.factory();
    msgReceiver.addEventListener('message', onMessage);
    msgReceiver.connect();
    const msgSender = await relay.MessageSender.factory();
    debugger;
    const bus = await msgSender.sendMessageToAddrs(["76399cf3-0898-4000-a565-0119fd1c2284"], [], [], Date.now());
    bus.on('error', ev => console.error(ev));
    bus.on('sent', ev => console.info('Sent', ev));
    bus.on('deliver', ev => console.info('Delivered', ev));
    debugger;
})();
