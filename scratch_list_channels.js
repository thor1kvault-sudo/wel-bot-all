const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log(`=== CHANNELS IN GUILD ===`);
  const guild = client.guilds.cache.first();
  if (guild) {
    console.log(`Guild: ${guild.name} (${guild.id})`);
    const channels = await guild.channels.fetch();
    channels.forEach(ch => {
      if (ch && ch.isTextBased()) {
        console.log(`[TEXT CHANNEL] Name: "${ch.name}" | ID: ${ch.id} | Parent: ${ch.parent ? ch.parent.name : 'None'}`);
      }
    });
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
