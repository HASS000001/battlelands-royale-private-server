'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { REST, Routes } = require('discord.js');
const commands = require('./commands');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  const guildId  = process.env.DISCORD_GUILD_ID;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!guildId || !clientId) {
    console.error('Set DISCORD_GUILD_ID and DISCORD_CLIENT_ID in your .env');
    process.exit(1);
  }
  console.log(`Registering ${commands.length} commands to guild ${guildId}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands.map((c) => c.data.toJSON()) }
  );
  console.log(`Done - ${data.length} commands registered.`);
})();
