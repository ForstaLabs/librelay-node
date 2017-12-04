const process = require('process');
const readline = require('readline');
const relay = require('..');

const threadId = '00000000-1111-2222-3333-444444444444';

async function input(prompt) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    try {
        return await new Promise(resolve => rl.question(prompt, resolve));
    } finally {
        rl.close();
    }
}

async function main() {
    const sender = await relay.MessageSender.factory();
    const to = await input("To: (e.g. @sometag) ") || '@mayfield:forsta.io';
    while (true) {
        const attachment = await input("File Attachment: ");
        const attachments = [];
        if (attachment) {
            attachments.push(relay.Attachment.fromFile(attachment)); 
        }
        sender.send({
            to,
            text: await input("Message: "),
            threadId, // Static value prevents creating a new convo for each message
            attachments
        });
    }
}

main();
