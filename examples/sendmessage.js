const relay = require('..');
const process = require('process');
const uuid4 = require('uuid/v4');

process.on('unhandledRejection', error => {
    console.error(error);
});

(async function main() {
    const msgSender = await relay.MessageSender.factory();
    async function send(msg) {
        const threadId = 'ae6a43d4-f0cd-41fc-9457-0d98fd11da36';
        const now = Date.now();
        const bus = await msgSender.sendMessageToAddrs(["76399cf3-0898-4000-a565-0119fd1c2284"], [{
            version: 1,
            threadType: 'conversation',
            threadId,
            messageType: 'content',
            messageId: uuid4(),
            userAgent: 'librelay',
            data: {
                body: [{
                    type: 'text/plain',
                    value: msg
                }]
            },
            sender: {
                userId: await relay.storage.getState('addr')
            },
            distribution: {
                expression: '(<0ceeb1aa-fd9a-4df3-931d-864481574c54>+<cb6eb937-67e2-4cca-849a-d640b88d9eae>)',
            }
        }], [], now);
        await new Promise((resolve, reject) => {
            bus.on('error', ev => reject(ev));
            bus.on('sent', ev => resolve(ev));
        });
        await msgSender.sendSyncMessage(bus.messageBuffer, now, threadId);
    }
    const sendJobs = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        sendJobs.push(send(chunk));
    });
    process.stdin.on('close', () => Promise.all(sendJobs).then(() => process.exit(0)));
})();
