librelay - Forsta Relay Node.js library
========
Signal based Node.js library for end-to-end crypto with Forsta messaging platform.


[![npm](https://img.shields.io/npm/v/librelay.svg)](https://www.npmjs.com/package/librelay)
[![npm](https://img.shields.io/npm/l/librelay.svg)](https://github.com/ForstaLabs/librelay-node)


About
--------
This is a Node.js library used to communicate with the Forsta messaging
platform.  The underlying protocol is based on the Signal end-to-end
crypto system.  The primary differences surround how provisioning is done
and the data payload, which is a custom JSON specification,
<https://goo.gl/eX7gyC>


Installation
--------
Ensure that you are using Node 8 (needs *async/await* support) or higher and
simply install from NPM:

    $ npm install librelay


Storage
--------
Librelay needs a backing store for holding crypto material.  The default
storage backing is `fs` which will store files in your local file-system
under `~/.librelay/storage`.  Redis is also supported by setting
`RELAY_STORAGE_BACKING=redis` in your env or calling
`librelay.storage.setBacking('redis')`.  To support multiple instances of
librelay on a single backing store use
`librelay.storage.setLabel('<something-unique>')` to shard your storage into
a unique namespace.


Provisioning
-------
PREREQUISITE: To use librelay you must first have a valid Forsta account.  You
can sign-up for free at <https://www.forsta.io/sign-up>.  Once you have a valid
Forsta account you need to provision your librelay based application. 

With your Forsta account (e.g. `myusername:myorgname`) you can get started
with the `librelay.AccountManager` class to register with the secure messaging
servers.

```javascript
const relay = require('librelay');
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
    process.exit(0);
})();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/register.js>


Message Receiving
-------
Once your application is provisioned you can participate in the messaging
platform.   The simplest way to get familiar with the platform is to listen
for incoming messages and examine the content sent to your application in a
debugger.   Here is a very simple example of receiving messages.

```javascript
const relay = require('librelay');

function onMessage(ev) {
    const message = ev.data;
    console.info("Got message", message);
}

(async function main() {
    const msgReceiver = await relay.MessageReceiver.factory();
    msgReceiver.addEventListener('message', onMessage);
    msgReceiver.connect();
})();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/recvmessage.js>


Message Sending
-------
Message sending is currently a more complicated prospect as it requires your
application to send messages that are in conformance with the Forsta Message
Exchange format, <https://goo.gl/eX7gyC>.

Here is a contrived example with identifiers suited to a specific environment.
It is an exercise for the reader to ascertain and provide your own identifiers
where noted in the example.

*This example reads text from standard input and forwards to a hard coded
thread.*
```javascript
const relay = require('librelay');
const process = require('process');
const uuid4 = require('uuid/v4');


// Replace this with your thread!
const threadId = 'ae6a43d4-f0cd-41fc-9457-0d98fd11da36';

// Replace this with a valid user id!
const recipientId = '76399cf3-0898-4000-a565-0119fd1c2284';

// This is a very hard value to generate by hand.  It's recomended you use
// The Forsta tag API to generate these.  E.g.
//     <https://api.forsta.io/v1/directory/tag?expression=@user:org+@another.user:another.org>
const distExpression = '(<0ceeb1aa-fd9a-4df3-931d-864481574c54>+<cb6eb937-67e2-4cca-849a-d640b88d9eae>)';


async function send(msg) {
    const now = Date.now();
    const bus = await msgSender.sendMessageToAddrs([recipientId], [{
        version: 1,
        threadId,
        messageId: uuid4(),
        threadType: 'conversation',
        messageType: 'content',
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
            expression: distExpression
        }
    }], [], now);
    await new Promise((resolve, reject) => {
        bus.on('error', ev => reject(ev));
        bus.on('sent', ev => resolve(ev));
    });
    await msgSender.sendSyncMessage(bus.messageBuffer, now, threadId);
}

(async function main() {
    const msgSender = await relay.MessageSender.factory();
    const sendJobs = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        sendJobs.push(send(chunk));
    });
    process.stdin.on('close', () => Promise.all(sendJobs).then(() => process.exit(0)));
})();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/sendmessage.js>


Cryptography Notice
--------
This distribution includes cryptographic software. The country in which you
currently reside may have restrictions on the import, possession, use, and/or
re-export to another country, of encryption software.  BEFORE using any
encryption software, please check your country's laws, regulations and
policies concerning the import, possession, or use, and re-export of
encryption software, to see if this is permitted.  See
<https://www.wassenaar.org/> for more information.

The U.S. Government Department of Commerce, Bureau of Industry and Security
(BIS), has classified this software as Export Commodity Control Number (ECCN)
5D002.C.1, which includes information security software using or performing
cryptographic functions with asymmetric algorithms.  The form and manner of
this distribution makes it eligible for export under the License Exception ENC
Technology Software Unrestricted (TSU) exception (see the BIS Export
Administration Regulations, Section 740.13) for both object code and source code.


License
--------
Licensed under the GPLv3: http://www.gnu.org/licenses/gpl-3.0.html

* Copyright 2014-2016 Open Whisper Systems
* Copyright 2017 Forsta Inc.
