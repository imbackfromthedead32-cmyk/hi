const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    status: 'dnd', // online, idle, dnd, invisible
    activities: [
      {
        name: 'over the server',
        type: ActivityType.Watching
      }
    ]
  });
});
;
