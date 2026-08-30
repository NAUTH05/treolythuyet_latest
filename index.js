const yargs = require('yargs');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { BotSession } = require('./bot');
const fbService = require('./firebase-service');
const { SerializedStateSync, readStateDocument } = require('./stateSync');

// ============================================================
//  CLI MODE - Chay tu command line
//  Dung chung bot engine voi web interface
// ============================================================

const argv = yargs
  .usage('Usage: node index.js --url <lesson_url> [options]')
  .option('url', {
    alias: 'u',
    describe: 'Link bai hoc can treo',
    type: 'string',
    demandOption: true,
  })
  .option('time', {
    alias: 't',
    describe: 'Thoi gian treo (phut)',
    type: 'number',
    default: 240,
  })
  .option('account', {
    alias: 'a',
    describe: 'Chi dinh account (so thu tu hoac "all")',
    type: 'string',
    default: '1',
  })
  .option('headless', {
    describe: 'Chay an trinh duyet',
    type: 'boolean',
    default: true,
  })
  .option('stealth-interval', {
    alias: 's',
    describe: 'Khoang cach gia lap hanh vi (giay)',
    type: 'number',
    default: 30,
  })
  .option('refresh-interval', {
    alias: 'r',
    describe: 'Auto F5 moi X phut (0 = tat)',
    type: 'number',
    default: 30,
  })
  .example('node index.js --url <link> --time 240')
  .example('node index.js -u <link> -t 120 -a all -r 20')
  .example('node index.js -u <link> -a 2 --no-headless')
  .help('h')
  .alias('h', 'help')
  .argv;

async function loadAccounts() {
  const p = path.join(__dirname, 'accounts.json');
  const local = readStateDocument(p, 'accounts');
  const accountsSync = new SerializedStateSync({
    label: 'accounts',
    filePath: p,
    arrayKey: 'accounts',
    collection: 'system_accounts',
    documentId: 'list',
    loadConfig: fbService.getFirebaseAdminConfiguration,
    syncRemote: fbService.syncToFirebase,
    fetchRemote: fbService.fetchFirebaseDocument,
    initialRevision: local.revision,
  });
  await accountsSync.reconcile();
  if (!fs.existsSync(p)) {
    console.error(chalk.red('Khong tim thay accounts.json va khong the khoi phuc tu Firebase!'));
    process.exit(1);
  }
  const restored = readStateDocument(p, 'accounts');
  if (!restored.available) {
    console.error(chalk.red('accounts.json khong hop le va Firebase khong co ban khoi phuc!'));
    process.exit(1);
  }
  return restored.data;
}

function getSelectedAccounts(accounts, selector) {
  if (selector === 'all') return accounts;
  const indices = selector.split(',').map(s => parseInt(s.trim()) - 1);
  const selected = [];
  for (const idx of indices) {
    if (idx >= 0 && idx < accounts.length) {
      selected.push(accounts[idx]);
    } else {
      console.log(chalk.yellow(`Account #${idx + 1} khong ton tai, bo qua.`));
    }
  }
  if (selected.length === 0) {
    console.error(chalk.red('Khong co account hop le!'));
    process.exit(1);
  }
  return selected;
}

async function main() {
  console.log(chalk.bold.cyan('\n=== TREO HOC LY THUYET LAI XE - CLI Mode ===\n'));

  const accounts = await loadAccounts();
  const selectedAccounts = getSelectedAccounts(accounts, argv.account);

  console.log(chalk.white('Cau hinh:'));
  console.log(chalk.white(`  Bai hoc  : ${argv.url}`));
  console.log(chalk.white(`  Thoi gian: ${argv.time} phut (${(argv.time / 60).toFixed(1)} tieng)`));
  console.log(chalk.white(`  Auto F5  : moi ${argv['refresh-interval']} phut`));
  console.log(chalk.white(`  Accounts : ${selectedAccounts.map(a => a.name).join(', ')}`));
  console.log(chalk.white(`  Headless : ${argv.headless}`));
  console.log(chalk.white(`  Stealth  : moi ${argv['stealth-interval']}s`));
  console.log('');

  const promises = selectedAccounts.map((acc, i) => {
    const session = new BotSession(`cli_${i}`, acc, argv.url, {
      headless: argv.headless,
      durationMinutes: argv.time,
      stealthInterval: argv['stealth-interval'],
      refreshInterval: argv['refresh-interval'],
    });

    session.on('log', (entry) => {
      const colorFn = {
        success: chalk.green,
        warn: chalk.yellow,
        error: chalk.red,
        info: chalk.white,
      }[entry.level] || chalk.white;
      console.log(
        chalk.gray(`[${entry.timestamp}]`) + ' ' +
        chalk.bold.cyan(`[${entry.account}]`) + ' ' +
        colorFn(entry.msg)
      );
    });

    return session.start();
  });

  await Promise.all(promises);
  console.log(chalk.bold.green('\nTat ca accounts da hoan thanh!\n'));
}

main().catch(err => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exitCode = 1;
}).finally(() => fbService.shutdownFirebaseAdmin());
