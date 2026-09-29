// Gestione utenti da riga di comando:
//   npm run user -- list
//   npm run user -- add <nome> [--admin] [--name "Nome visualizzato"]
//   npm run user -- passwd <nome>
//   npm run user -- enable|disable <nome>
//   npm run user -- promote|demote <nome>
//   npm run user -- delete <nome>
// La password viene chiesta in modo interattivo, oppure letta da stdin con --password-stdin
// o dalla variabile JULIANIFY_PASSWORD.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { createUser, setUserPassword, toUser, validatePassword, type UserRow } from './auth.js';
import { loadConfig, dataPaths } from './config.js';
import { deleteUserWithContent } from './content.js';
import type { AppContext } from './context.js';
import { Database } from './db.js';
import { Storage } from './storage.js';

function usage(): never {
  console.log(`Uso: julianify-user <comando> [argomenti]

Comandi:
  list                              elenca gli utenti
  add <nome> [--admin] [--name N]   crea un utente
  passwd <nome>                     imposta una nuova password
  enable <nome> | disable <nome>    abilita/disabilita l'accesso
  promote <nome> | demote <nome>    concede/toglie i permessi di amministratore
  delete <nome>                     elimina l'utente e tutti i suoi spartiti

Opzioni password: --password-stdin oppure variabile JULIANIFY_PASSWORD`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(question);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  muted = false;
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function askPassword(args: string[]): Promise<string> {
  if (args.includes('--password-stdin')) return readStdin();
  if (process.env.JULIANIFY_PASSWORD) return process.env.JULIANIFY_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('Nessun terminale: usa --password-stdin o JULIANIFY_PASSWORD');
  const first = await promptHidden('Password: ');
  const error = validatePassword(first);
  if (error) throw new Error(error);
  const second = await promptHidden('Ripeti password: ');
  if (first !== second) throw new Error('Le password non coincidono');
  return first;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, username, ...rest] = process.argv.slice(2);
  if (!command) usage();
  const config = loadConfig();
  const paths = dataPaths(config);
  const db = new Database(paths.dbFile);
  const findUser = (name: string | undefined): UserRow => {
    if (!name) usage();
    const row = db.get<UserRow>('SELECT * FROM users WHERE username = ?', name);
    if (!row) throw new Error(`Utente "${name}" non trovato`);
    return row;
  };

  try {
    switch (command) {
      case 'list': {
        const users = db.all<UserRow>('SELECT * FROM users ORDER BY username COLLATE NOCASE').map(toUser);
        if (users.length === 0) console.log('Nessun utente.');
        for (const u of users) {
          const flags = [u.isAdmin ? 'admin' : null, u.isEnabled ? null : 'disabilitato'].filter(Boolean).join(', ');
          console.log(`${u.username}${u.displayName ? ` (${u.displayName})` : ''}${flags ? ` [${flags}]` : ''}`);
        }
        break;
      }
      case 'add': {
        if (!username) usage();
        const password = await askPassword(rest);
        const user = await createUser(db, {
          username,
          password,
          isAdmin: rest.includes('--admin'),
          displayName: optionValue(rest, '--name') ?? null,
        });
        console.log(`Creato l'utente "${user.username}"${user.isAdmin ? ' (amministratore)' : ''}.`);
        break;
      }
      case 'passwd': {
        const user = findUser(username);
        await setUserPassword(db, user.id, await askPassword(rest));
        db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
        console.log(`Password aggiornata per "${user.username}".`);
        break;
      }
      case 'enable':
      case 'disable': {
        const user = findUser(username);
        db.run('UPDATE users SET is_enabled = ? WHERE id = ?', command === 'enable' ? 1 : 0, user.id);
        if (command === 'disable') db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
        console.log(`Utente "${user.username}" ${command === 'enable' ? 'abilitato' : 'disabilitato'}.`);
        break;
      }
      case 'promote':
      case 'demote': {
        const user = findUser(username);
        db.run('UPDATE users SET is_admin = ? WHERE id = ?', command === 'promote' ? 1 : 0, user.id);
        console.log(`Utente "${user.username}" ${command === 'promote' ? 'ora è amministratore' : 'non è più amministratore'}.`);
        break;
      }
      case 'delete': {
        const user = findUser(username);
        const storage = new Storage(paths);
        await storage.init();
        const ctx = { config, db, storage } as AppContext;
        await deleteUserWithContent(ctx, user.id);
        console.log(`Utente "${user.username}" eliminato.`);
        break;
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main().catch((err: Error) => {
  console.error(`Errore: ${err.message}`);
  process.exit(1);
});
