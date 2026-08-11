import 'server-only';
import { gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { rollUpUsage, type UsageRow, type UsageTotals } from './usage-rollup';

/** Usage recorded since local midnight. The arithmetic lives in usage-rollup so
 *  the dashboard and AKIRA can never disagree about it. */
export async function getUsageToday(): Promise<UsageTotals> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      agentId: messages.agent_id,
      tokensIn: messages.token_count_in,
      tokensOut: messages.token_count_out,
      cacheReadTokens: messages.cache_read_tokens,
      cacheCreationTokens: messages.cache_creation_tokens,
      costUsd: messages.cost_usd,
    })
    .from(messages)
    .where(gte(messages.created_at, since));
  return rollUpUsage(rows as UsageRow[]);
}
