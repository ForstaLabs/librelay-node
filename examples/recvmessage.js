const relay = require('..');
const process = require('process');

process.on('unhandledRejection', error => {
    console.error(error);
});

(async function main() {
    function onMessage(ev) {
        const message = ev.data;
        console.info("Got message", message);
    }
    const msgReceiver = await relay.MessageReceiver.factory();
    msgReceiver.addEventListener('message', onMessage);
    msgReceiver.connect();
})();
