import { buildApp } from './app.js';
import { createUser } from './auth.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, ctx } = await buildApp(config);

// Primo avvio: crea l'amministratore indicato dalle variabili d'ambiente.
const userCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
if (userCount === 0) {
  if (config.adminUser && config.adminPassword) {
    const user = await createUser(ctx.db, { username: config.adminUser, password: config.adminPassword, isAdmin: true });
    app.log.info(`Creato l'utente amministratore "${user.username}"`);
  } else {
    app.log.warn(
      'Nessun utente configurato: crea il primo amministratore con "npm run user -- add <nome> --admin" ' +
        'oppure imposta JULIANIFY_ADMIN_USER e JULIANIFY_ADMIN_PASSWORD.',
    );
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`Ricevuto ${signal}, arresto in corso...`);
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`Julianify ${ctx.version} in ascolto su http://${config.host}:${config.port} (dati: ${config.dataDir})`);
if (ctx.library) app.log.info(`Libreria musicale: ${ctx.library.root}`);
