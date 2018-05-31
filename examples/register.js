const relay = require('..');

async function main(secondary) {
    const userTag = await relay.util.consoleInput("Enter your login (e.g user:org): ");
    const resp = await relay.AtlasClient.requestAuthentication(userTag);
    const prompt = resp.type === 'sms' ? 'SMS Code: ' : 'Password: ';
    const secret = await relay.util.consoleInput(prompt);
    await resp.authenticate(secret);
    if (secondary) {
        const registration = await relay.registerDevice();
        console.info("Awaiting auto-registration response...");
        await registration.done;
        console.info("Successfully registered new device");
    } else {
        await relay.registerAccount();
        console.info("Successfully registered account");
    }
}

main(false).catch(e => console.error(e));
