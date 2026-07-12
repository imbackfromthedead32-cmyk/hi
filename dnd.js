const { ActivityType } = require('discord.js');

module.exports = (client) => {
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'rizzing your mom',
        type: ActivityType.Competing
      }
    ]
  });
};
