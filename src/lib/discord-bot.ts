import 'server-only';
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  type Interaction,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { parseAllowedIds, isAllowed } from './discord-allow';
import {
  getBinding,
  setBinding,
  removeBinding,
  findProjectByName,
} from './discord-bindings';
import { getActiveSessionId } from './discord-session';
import { createDiscordSink } from './discord-sink';
import { runSessionTurn } from './run-turn';
import { mergeWorktree, discardWorktree } from './worktree';
import { parseActionId, proposalResultEmbed } from './discord-format';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { eq } from 'drizzle-orm';

let readyClient: Client | null = null;
export function getReadyClient(): Client | null {
  return readyClient;
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('mc')
    .setDescription('Mission Control')
    .addSubcommand((s) =>
      s
        .setName('bind')
        .setDescription('Bind this channel to a project')
        .addStringOption((o) =>
          o.setName('project').setDescription('Project name').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('unbind').setDescription('Unbind this channel'))
    .addSubcommand((s) => s.setName('status').setDescription("Show this channel's binding"))
    .toJSON(),
];

async function registerCommands(appId: string, token: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: COMMANDS });
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: COMMANDS });
  }
}

export function startDiscordBot(): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return; // bot disabled
  const g = globalThis as unknown as { __mcDiscordStarted?: boolean };
  if (g.__mcDiscordStarted) return;
  g.__mcDiscordStarted = true;

  const appId = process.env.DISCORD_APP_ID ?? '';
  const guildId = process.env.DISCORD_GUILD_ID || undefined;
  const allowed = parseAllowedIds(process.env.DISCORD_ALLOWED_USER_IDS);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    readyClient = c;
    console.log(`[discord] logged in as ${c.user.tag}`);
    try {
      if (appId) await registerCommands(appId, token, guildId);
      else console.warn('[discord] DISCORD_APP_ID not set — skipping slash-command registration');
    } catch (err) {
      console.error('[discord] command registration failed:', err instanceof Error ? err.message : err);
    }
  });

  client.on(Events.InteractionCreate, (i) => void handleInteraction(i, allowed));
  client.on(Events.MessageCreate, (m) => void handleMessage(m, allowed));
  client.on(Events.Error, (err) => console.error('[discord] client error:', err.message));

  client.login(token).catch((err) =>
    console.error('[discord] login failed:', err instanceof Error ? err.message : err),
  );
}

async function handleInteraction(interaction: Interaction, allowed: Set<string>): Promise<void> {
  if (interaction.isButton()) return handleButton(interaction, allowed);
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!isAllowed(interaction.user.id, allowed)) {
      await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;
    if (sub === 'bind') {
      const name = interaction.options.getString('project', true);
      const project = await findProjectByName(name);
      if (!project) {
        await interaction.reply({ content: `No project named "${name}".`, flags: MessageFlags.Ephemeral });
        return;
      }
      await setBinding(channelId, project.id);
      await interaction.reply(`Bound this channel to **${project.name}**.`);
    } else if (sub === 'unbind') {
      await removeBinding(channelId);
      await interaction.reply('Unbound this channel.');
    } else if (sub === 'status') {
      const b = await getBinding(channelId);
      await interaction.reply(b ? `Bound to project \`${b.project_id}\`.` : 'Not bound.');
    }
  } catch (err) {
    console.error('[discord] interaction failed:', err instanceof Error ? err.message : err);
  }
}

async function handleButton(interaction: ButtonInteraction, allowed: Set<string>): Promise<void> {
  const parsed = parseActionId(interaction.customId);
  if (!parsed) return; // not one of our proposal buttons
  try {
    if (!isAllowed(interaction.user.id, allowed)) {
      await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate(); // merge can take seconds; beat the 3s limit, keep the message
    const { action, sessionId } = parsed;

    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
    const title = session?.title ?? undefined;
    if (!session || !session.worktree_path) {
      await interaction.message.edit({ embeds: [proposalResultEmbed('stale', { sessionTitle: title })], components: [] });
      return;
    }
    const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
    if (!project) {
      await interaction.message.edit({ embeds: [proposalResultEmbed('stale', { sessionTitle: title })], components: [] });
      return;
    }

    if (action === 'merge') {
      const base = project.default_branch ?? 'dev';
      const result = await mergeWorktree(sessionId, project.repo_path, base);
      if (result.ok) {
        await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
        await interaction.message.edit({ embeds: [proposalResultEmbed('merged', { baseBranch: base, sessionTitle: title })], components: [] });
      } else {
        await interaction.message.edit({ embeds: [proposalResultEmbed('conflict', { sessionTitle: title })], components: [] });
      }
    } else {
      await discardWorktree(sessionId, project.repo_path);
      await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
      await interaction.message.edit({ embeds: [proposalResultEmbed('discarded', { sessionTitle: title })], components: [] });
    }
  } catch (err) {
    console.error('[discord] button action failed:', err instanceof Error ? err.message : err);
    try {
      await interaction.followUp({ content: `Action failed: ${err instanceof Error ? err.message : err}`, flags: MessageFlags.Ephemeral });
    } catch {
      /* best-effort */
    }
  }
}

async function handleMessage(message: Message, allowed: Set<string>): Promise<void> {
  try {
    if (message.author.bot) return;
    if (!isAllowed(message.author.id, allowed)) return; // silently ignore
    const text = message.content.trim();
    if (!text) return;
    const binding = await getBinding(message.channelId);
    if (!binding) return; // unbound channel → ignore

    const channel = message.channel;
    if (!('send' in channel) || typeof channel.send !== 'function') return;

    const sessionId = await getActiveSessionId(binding.project_id);
    const sink = createDiscordSink(channel as Parameters<typeof createDiscordSink>[0]);
    const result = await runSessionTurn(sessionId, { instruction: text, emit: sink.emit });
    if (result.status === 'skipped') {
      await channel.send('⏳ A turn is already running for this project — try again in a moment.');
      return;
    }
    await sink.finalize();
  } catch (err) {
    console.error('[discord] message handler failed:', err instanceof Error ? err.message : err);
  }
}
