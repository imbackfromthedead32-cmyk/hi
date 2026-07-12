const { ActivityType } = require('discord.js');

module.exports = (client) => {
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'over the server',
        type: ActivityType.Watching
      }
    ]
  });
};
