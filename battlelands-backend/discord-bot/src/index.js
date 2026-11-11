'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Client, GatewayIntentBits, Events, Collection } = require('discord.js');
const commands = require('./commands');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
for (const cmd of commands) client.commands.set(cmd.data.name, cmd);

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`[bot] error in /${interaction.commandName}:`, err.message);
    const payload = { content: `Internal error: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
});

client.login(process.env.DISCORD_TOKEN);
