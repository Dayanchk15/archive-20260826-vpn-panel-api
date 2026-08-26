import { getActiveClients } from '/app/lib/active-users.js';
process.stdout.write(JSON.stringify(await getActiveClients()));
