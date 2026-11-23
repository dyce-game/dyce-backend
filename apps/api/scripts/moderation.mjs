#!/usr/bin/env node
// A command-line client for the moderation API (ADR-039). JSON in, JSON out, no UI.
//
//   DYCE_API=https://api.example.com DYCE_ADMIN_TOKEN=<token> node scripts/moderation.mjs <command> [args]
//
//   queue                              what needs a person: pending reports, flagged signals, held payouts
//   reports [status]                   pending (default) | open | reviewing | actioned | dismissed
//   report <id>                        one report with the conversation snapshot
//   report-act <id> <review|warn|mute|suspend|dismiss> [note] [--hours N]
//   signals [status]                   flagged signals (default status: open)
//   signal-review <id> <reviewing|actioned|dismissed> [note]
//   holds [status]                     held (default) | released | voided | disqualified
//   hold <id> <release|void|disqualify> [note] [--user <userId>]
//   disputes
//   dispute <id> <reviewing|upheld|reversed> [note] [--txn <ledgerTxnId>]
//   user <id>
//   sanction <userId> <warning|mute|suspension> [note] [--hours N] [--report <id>] [--signal <id>]
//   lift <sanctionId> [note]
//   audit [--user <userId>] [--limit N]
//
// The token's name (from the API's ADMIN_TOKENS) is what the audit log records as the moderator.

const API = (process.env.DYCE_API ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.DYCE_ADMIN_TOKEN;

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    'usage: node scripts/moderation.mjs queue | reports | report | report-act | signals | signal-review |\n' +
      '       holds | hold | disputes | dispute | user | sanction | lift | audit   (see the header of this file)',
  );
  process.exit(2);
}

/** Splits `--flag value` pairs from positional arguments. */
function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function call(method, path, body) {
  const res = await fetch(`${API}/admin/moderation${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, ...json }, null, 2));
    process.exit(1);
  }
  return json;
}

const out = (value) => console.log(JSON.stringify(value, null, 2));
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const num = (v) => (v === undefined ? undefined : Number(v));

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();
if (!TOKEN) usage("Set DYCE_ADMIN_TOKEN (a token from the API's ADMIN_TOKENS).");
const { positional: p, flags } = parse(rest);

switch (command) {
  case 'queue':
    out({
      reports: await call('GET', '/reports?status=pending'),
      signals: await call('GET', '/signals?flagged=true&status=open'),
      holds: await call('GET', '/holds?status=held'),
      disputes: await call('GET', '/disputes'),
    });
    break;
  case 'reports':
    out(await call('GET', `/reports?status=${p[0] ?? 'pending'}`));
    break;
  case 'report':
    if (!p[0]) usage('report needs an id');
    out(await call('GET', `/reports/${p[0]}`));
    break;
  case 'report-act':
    if (!p[0] || !p[1]) usage('report-act needs an id and an action');
    out(
      await call(
        'POST',
        `/reports/${p[0]}/action`,
        compact({ action: p[1], note: p[2], hours: num(flags.hours) }),
      ),
    );
    break;
  case 'signals':
    out(await call('GET', `/signals?flagged=true&status=${p[0] ?? 'open'}`));
    break;
  case 'signal-review':
    if (!p[0] || !p[1]) usage('signal-review needs an id and a status');
    out(await call('POST', `/signals/${p[0]}/review`, compact({ status: p[1], note: p[2] })));
    break;
  case 'holds':
    out(await call('GET', `/holds?status=${p[0] ?? 'held'}`));
    break;
  case 'hold':
    if (!p[0] || !p[1]) usage('hold needs an id and a decision');
    out(
      await call(
        'POST',
        `/holds/${p[0]}/resolve`,
        compact({ decision: p[1], note: p[2], userId: flags.user }),
      ),
    );
    break;
  case 'disputes':
    out(await call('GET', '/disputes'));
    break;
  case 'dispute':
    if (!p[0] || !p[1]) usage('dispute needs an id and a status');
    out(
      await call(
        'POST',
        `/disputes/${p[0]}/resolve`,
        compact({ status: p[1], note: p[2], txnId: flags.txn }),
      ),
    );
    break;
  case 'user':
    if (!p[0]) usage('user needs an id');
    out(await call('GET', `/users/${p[0]}`));
    break;
  case 'sanction':
    if (!p[0] || !p[1]) usage('sanction needs a user id and a kind');
    out(
      await call(
        'POST',
        `/users/${p[0]}/sanction`,
        compact({
          kind: p[1],
          note: p[2],
          hours: num(flags.hours),
          reportId: flags.report,
          signalId: flags.signal,
        }),
      ),
    );
    break;
  case 'lift':
    if (!p[0]) usage('lift needs a sanction id');
    out(await call('POST', `/sanctions/${p[0]}/lift`, compact({ note: p[1] })));
    break;
  case 'audit': {
    const q = new URLSearchParams(compact({ userId: flags.user, limit: flags.limit }));
    out(await call('GET', `/audit${q.size ? `?${q}` : ''}`));
    break;
  }
  default:
    usage(`unknown command: ${command}`);
}
