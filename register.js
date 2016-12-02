const sqlite3 = require('sqlite3');
const indexeddb = require('indexeddb-js');
const engine    = new sqlite3.Database(':memory:');
const indexedDB = new indexeddb.indexedDB('sqlite3', engine);
//const components = require('./js/components.js');
require('./js/database.js');
require('./js/signal_protocol_store.js');
//require('./js/libtextsecure.js');

//require('./js/libphonenumber-util.js');
require('./js/models/messages.js');
require('./js/models/conversations.js');

require('./js/conversation_controller.js');

require('./js/registration.js');

require('./js/foundation.js');
require('./js/register.js');
