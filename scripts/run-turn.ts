import 'dotenv/config';
import { runSessionTurn } from '@/lib/run-turn';

// One concise line per turn event so the operator can watch a headless run.
function logLine(e: { type: string; [k: string]: unknown }) {
  switch (e.type) {
    case 'worktree':
      console.log(`[worktree] ${e.path} (${e.branch})`);
      break;
    case 'worktree_error':
      console.log(`[worktree_error] ${e.message}`);
      break;
    case 'activity':
      console.log(`[activity] ${e.agent_id} ${e.tool}`);
      break;
    case 'dispatch_activity':
      console.log(`[dispatch] ${e.agent_id} ${e.tool}`);
      break;
    case 'token':
      process.stdout.write(String(e.content ?? ''));
      break;
    case 'done':
      console.log(`\n[done] cost=$${e.costUsd ?? 0}`);
      break;
    case 'persisted':
      console.log('[persisted]');
      break;
    case 'skipped':
      console.log(`[skipped] ${e.reason ?? ''}`);
      break;
    case 'error':
      console.error(`[error] ${e.message ?? ''}`);
      break;
    default:
      break;
  }
}

async function main() {
  const sessionId = process.argv[2];
  const instruction = process.argv[3]; // optional self-initiated prompt
  if (!sessionId) {
    console.error('usage: pnpm run:turn <sessionId> ["instruction"]');
    process.exit(2);
  }
  const result = await runSessionTurn(sessionId, { instruction, emit: logLine });
  console.log(`\nturn ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
