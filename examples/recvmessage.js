const relay = require('..');

(async function main() {
    function onMessage(ev) {
        const message = ev.data;
        console.info("Got message", message);
    }
    const msgReceiver = await relay.MessageReceiver.factory();
    msgReceiver.addEventListener('message', onMessage);
    msgReceiver.connect();
})();
