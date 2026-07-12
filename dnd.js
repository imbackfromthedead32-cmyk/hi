const { ActivityType } = require('discord.js');

module.exports = (client) => {
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'your mom',
        type: ActivityType.Streaming
      }
    ]
  });
};
