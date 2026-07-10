const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const PROTECTED_ROLE_ID = '893877167627325460';

const PROTECTED_USER_IDS = [
  '463545427841515542',
  '440148449820803072',
  '688126550708977715',
  '480132661998780418',
  '756233069148766361'
];
const ADMIN_ROLE_IDS = ['722968925897228290', '722968975356723310'];
const PORT = process.env.PORT || 3000;

// --- YouTube notifier config ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_HANDLE = '@rizzyandmizzy';
const YOUTUBE_NOTIFY_GUILD_ID = '722946197769289759';
const YOUTUBE_NOTIFY_CHANNEL_ID = '722965560849203210';
const FORCE_NOTIFY_USER_IDS = ['463545427841515542', '1234183450618232902'];
const YT_POLL_INTERVAL_MS = 3 * 60 * 1000;

let ytState = {
  channelId: null,
  seenVideoIds: [],
  premieres: {}, // videoId -> { messageId, channelId }
};
let ytStateDirty = false;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const rewards = {};
const users = {};
const guildSettings = {};
let lottoActive = false;
let lottoData = null;
let lottoLastEnd = 0;
let fourTwentyActive = false;
let fourTwentyMessageId = null;
let fourTwentyChannelId = null;
let fourTwentyIsAM = false;
const claimed420 = new Set();
const triviaSession = {};
const userTriviaCorrect = {};
const pendingSaves = new Set();

const KEYS = {
  JHD37Z: 500,
  '8SJR02': 500,
  RIZANDMIZ: 1000,
  RMCONTROLV2: 2000,
  CHOPPEDBOT: 750,
  NEWPHONEWHODIS: 500,
  SUBSCRIBE: 1000,
  CHOPPEDCITY: 500,
  YOURMOM: 500,
  YOURDAD: 500,
  FREEHUNDREDK: 100000,
};
const usedKeys = new Set();

async function initDB() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings_data (
      guild_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'
    )
  `);
  const { rows } = await pool.query('SELECT user_id, data FROM user_data');
  for (const row of rows) {
    users[row.user_id] = row.data;
  }
  const gs = await pool.query('SELECT guild_id, settings FROM guild_settings_data');
  for (const row of gs.rows) {
    guildSettings[row.guild_id] = row.settings;
  }
  const ytRow = await pool.query("SELECT value FROM bot_state WHERE key = 'youtube'");
  if (ytRow.rows.length > 0 && ytRow.rows[0].value) {
    ytState = { ...ytState, ...ytRow.rows[0].value };
  }
  console.log(`Loaded ${rows.length} users and ${gs.rows.length} guild settings from DB.`);
}

async function saveYtState() {
  if (!pool) return;
  if (ytStateDirty) return;
  ytStateDirty = true;
  setTimeout(async () => {
    ytStateDirty = false;
    try {
      await pool.query(
        "INSERT INTO bot_state (key, value) VALUES ('youtube', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [JSON.stringify(ytState)]
      );
    } catch (e) {
      console.error('DB youtube state save error:', e.message);
    }
  }, 1000);
}

async function saveUser(userId) {
  if (!pool || !users[userId]) return;
  if (pendingSaves.has(userId)) return;
  pendingSaves.add(userId);
  setTimeout(async () => {
    pendingSaves.delete(userId);
    try {
      await pool.query(
        'INSERT INTO user_data (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = $2',
        [userId, JSON.stringify(users[userId])]
      );
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 1000);
}

async function saveGuildSettings(guildId) {
  if (!pool || !guildSettings[guildId]) return;
  try {
    await pool.query(
      'INSERT INTO guild_settings_data (guild_id, settings) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET settings = $2',
      [guildId, JSON.stringify(guildSettings[guildId])]
    );
  } catch (e) {
    console.error('DB guild save error:', e.message);
  }
}

function getUser(id) {
  if (!users[id]) {
    users[id] = {
      balance: 0,
      plushies: [],
      messageCount: 0,
      lastGamble: 0,
      lastPet: {},
      dailyEnabled: false,
      dailyLastClaim: {},
      botUsed: false,
      _petCount: 0,
    };
  }
  return users[id];
}

function addBalance(id, amount) {
  getUser(id).balance += amount;
  saveUser(id);
}

function getBalance(id) {
  return getUser(id).balance;
}

const PLUSHIES = [
  { id: 'common', name: 'Common Plushie 🧸', rarity: 'Common', price: 100, petReward: 30, emoji: '🧸' },
  { id: 'uncommon', name: 'Uncommon Plushie 🐻', rarity: 'Uncommon', price: 250, petReward: 67, emoji: '🐻' },
  { id: 'rare', name: 'Rare Plushie 🦊', rarity: 'Rare', price: 500, petReward: 120, emoji: '🦊' },
  { id: 'legendary', name: 'Legendary Plushie 🐉', rarity: 'Legendary', price: 1000, petReward: 250, emoji: '🐉' },
];

const commands = [
  new SlashCommandBuilder().setName('moderatenickname').setDescription('Moderate a user\'s nickname').addUserOption(o => o.setName('user').setDescription('User to moderate').setRequired(true)),
  new SlashCommandBuilder().setName('balance').setDescription('Check your balance'),
  new SlashCommandBuilder().setName('balancetop').setDescription('Check top balances'),
  new SlashCommandBuilder().setName('curse').setDescription('Curse someone... maybe').addUserOption(o => o.setName('target').setDescription('Who to curse').setRequired(true)),
  new SlashCommandBuilder().setName('redeem').setDescription('Streamlabs Redeems'),
  new SlashCommandBuilder().setName('key').setDescription('Redeem a key for money').addStringOption(o => o.setName('code').setDescription('The key to redeem').setRequired(true)),
  new SlashCommandBuilder().setName('swag').setDescription('Get the ultimate swag link'),
  new SlashCommandBuilder().setName('freerobux').setDescription('Definitely Real Free Robux'),
  new SlashCommandBuilder().setName('shush').setDescription('Shush'),
  new SlashCommandBuilder().setName('egg').setDescription('Show an artistic masterpiece of Rizzy as an egg'),
  new SlashCommandBuilder().setName('nevergonnagiveyouup').setDescription('Show a good old rickroll'),
  new SlashCommandBuilder().setName('bomb').setDescription('Blow up a bomb'),
  new SlashCommandBuilder().setName('slots').setDescription('Game Of Slots'),
  new SlashCommandBuilder().setName('doubleornothing').setDescription('Double Or Nothing').addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin to win or lose $5'),
  new SlashCommandBuilder().setName('dice').setDescription('Roll Dice'),
  new SlashCommandBuilder().setName('scratch').setDescription('Scratch Ticket Game for $1 (Win $2 per 3 matched / $15 for 3 lots of 3)'),
  new SlashCommandBuilder().setName('beg').setDescription('Beg For Money'),
  new SlashCommandBuilder().setName('rockpaperscissors').setDescription('Small game of rock paper scissors'),
  new SlashCommandBuilder().setName('lgbtifyguild').setDescription('See a guild\'s logo with a hint of LGBT').addStringOption(o => o.setName('guildid').setDescription('Optional guild ID').setRequired(false)),
  new SlashCommandBuilder().setName('lgbtify').setDescription('See your profile picture with a hint of LGBT').addUserOption(o => o.setName('user').setDescription('Optional user').setRequired(false)),
  new SlashCommandBuilder().setName('help').setDescription('Show help/commands message'),
  new SlashCommandBuilder().setName('schedule').setDescription('Show Rizzy And Mizzy\'s current stream schedule'),
  new SlashCommandBuilder().setName('live').setDescription('Check if Rizzy And Mizzy are live'),
  new SlashCommandBuilder().setName('info').setDescription('Show information about this bot'),
  new SlashCommandBuilder().setName('ping').setDescription('Checks if the bot is working'),
  new SlashCommandBuilder().setName('cmds').setDescription('Show all commands'),
  new SlashCommandBuilder().setName('qrcode').setDescription('QR Code Generator').addStringOption(o => o.setName('text').setDescription('Text or link to encode').setRequired(true)),
  new SlashCommandBuilder().setName('trivia').setDescription('Answer a trivia question for money!').addStringOption(o => o.setName('difficulty').setDescription('Difficulty').setRequired(true).addChoices({ name: 'Easy ($500)', value: 'easy' }, { name: 'Medium ($999)', value: 'medium' }, { name: 'Hard ($1500)', value: 'hard' })),
  new SlashCommandBuilder().setName('lottery').setDescription('Buy a lottery ticket ($10 each)').addIntegerOption(o => o.setName('tickets').setDescription('Number of tickets to buy').setRequired(false).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('shop').setDescription('Browse and buy plushies'),
  new SlashCommandBuilder().setName('pet').setDescription('Pet your plushie for money (once per hour)').addStringOption(o => o.setName('plushie').setDescription('Which plushie to pet').setRequired(true).addChoices({ name: '🧸 Common', value: 'common' }, { name: '🐻 Uncommon', value: 'uncommon' }, { name: '🦊 Rare', value: 'rare' }, { name: '🐉 Legendary', value: 'legendary' })),
  new SlashCommandBuilder().setName('gamble').setDescription('The magic egg awaits...'),
  new SlashCommandBuilder().setName('prankrizzy').setDescription('Pull the ultimate prank'),
  new SlashCommandBuilder().setName('setup').setDescription('Set the bot command channel').addChannelOption(o => o.setName('channel').setDescription('Channel to use for bot commands').setRequired(true)),
  new SlashCommandBuilder().setName('enabledaily').setDescription('Toggle daily money for chatting'),
  new SlashCommandBuilder().setName('rememberance').setDescription('A message of appreciation'),
  new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway for a specific user (Admin only)')
    .addUserOption(o => o.setName('winner').setDescription('Who wins the giveaway').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount of money to give').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('prize').setDescription('Prize description (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('givemoney').setDescription('Give money to a user (Admin only)')
    .addUserOption(o => o.setName('user').setDescription('User to give money to').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount to give').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('forcenotify').setDescription('Force send a YouTube notification (restricted)')
    .addStringOption(o => o.setName('type').setDescription('Type of notification').setRequired(true).addChoices({ name: 'Video/Short', value: 'video' }, { name: 'Live Stream', value: 'live' }))
    .addStringOption(o => o.setName('link').setDescription('The YouTube link').setRequired(true)),
  new SlashCommandBuilder().setName('deletelastmsg').setDescription('Delete the bot\'s last message in the YouTube notification channel (restricted)'),
  new SlashCommandBuilder().setName('talk').setDescription('Make the bot send a message in a channel (restricted)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to send the message in').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption(o => o.setName('message').setDescription('The message to send').setRequired(true)),
].map(c => c.toJSON());

const app = express();
app.use(express.json());

app.get('/check', (req, res) => {
  res.json({ status: 'online', rewards, userCount: Object.keys(users).length, dbConnected: !!pool });
});

app.post('/give', (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || typeof amount !== 'number') return res.status(400).json({ error: 'userId and amount required' });
  addBalance(userId, amount);
  if (!rewards[userId]) rewards[userId] = [];
  rewards[userId].push({ amount, reason: reason || 'API grant', timestamp: new Date().toISOString() });
  res.json({ success: true, userId, newBalance: getBalance(userId) });
});

app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (e) { console.error('Failed to register commands:', e); }
  scheduleLottery();
  scheduleFourTwenty();
  scheduleYoutubePoll();
});

function checkSetupChannel(interaction) {
  const settings = guildSettings[interaction.guildId];
  if (!settings || !settings.commandChannelId) return true;
  if (interaction.channelId !== settings.commandChannelId) {
    interaction.reply({ content: `Bot commands can only be used in <#${settings.commandChannelId}>!`, ephemeral: true });
    return false;
  }
  return true;
}

function hasAdminRole(member) {
  return ADMIN_ROLE_IDS.some(r => member.roles.cache.has(r));
}

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const userId = message.author.id;
  const u = getUser(userId);
  u.messageCount++;

  if (u.dailyEnabled) {
    const today = new Date().toDateString();
    if (u.dailyLastClaim.date !== today) {
      u.dailyLastClaim.date = today;
      addBalance(userId, 1000);
      try { await message.channel.send(`Daily bonus! **${message.author.username}** earned **$1,000** for chatting today!`); } catch (_) {}
    }
  }

  saveUser(userId);

  const isReplyMention = message.type === 19 && message.mentions.repliedUser;

  if (message.mentions.users.size > 0 || isReplyMention) {
    const guild = message.guild;
    if (!guild) return;

    const mentionedUsers = [...message.mentions.users.values()];

    // Only count reply mentions if the reply actually pings the user
    if (isReplyMention && message.mentions.users.has(message.mentions.repliedUser.id)) {
      mentionedUsers.push(message.mentions.repliedUser);
    }
    for (const mentionedUser of mentionedUsers) {
      const member = await guild.members.fetch(mentionedUser.id).catch(() => null);
      if (member && (member.roles.cache.has(PROTECTED_ROLE_ID) || PROTECTED_USER_IDS.includes(mentionedUser.id))) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Reminder')
          .setDescription('Please do not ping, or reply with @mentions to, Admins and/or Founders (unless it\'s quite urgent)\nSee below if you are unsure on how to disable @mention upon reply\nAlso ensure you have also read **#rules**')
          .setImage('https://cdn.discordapp.com/attachments/1247303459359690805/1505698534140416030/Screenshot_20260517_232815_Discord.jpg?ex=6a0b9289&is=6a0a4109&hm=5d174b83c024cc9c5789fab2251b5ba718d3a640f16cdc9e85045705063754dd&')
          .setFooter({ text: `Directed at ${message.author.username} | ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` });
        try { await message.channel.send({ embeds: [embed] }); } catch (_) {}
        break;
      }
    }
  }

});

function scheduleLottery() {
  cron.schedule('0 * * * *', async () => {
    if (lottoActive) return;
    const now = Date.now();
    if (now - lottoLastEnd < 2 * 60 * 60 * 1000) return;
    const shouldFire = Math.random() < (1 / 12);
    if (!shouldFire) return;
    await startLottery();
  });
}

async function startLottery() {
  const channel = await findBotChannel();
  if (!channel) return;
  const prize = randomInt(100000, 1000000);
  const endTime = Date.now() + 10 * 60 * 60 * 1000;
  lottoActive = true;
  lottoData = { prize, endTime, tickets: {}, channelId: channel.id };
  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('The Lotto Has Started!')
    .setDescription(`The lotto has started! Use the command **/lottery** to buy a ticket! Good luck everyone!\n\n**Prize Pool:** $${prize.toLocaleString()}\nThe lotto will be drawn in **10 hours!**\n*Tickets cost $10 each — each gives a 0.2% chance of winning!*`)
    .setTimestamp()
    .setFooter({ text: 'Good luck!' });
  try { await channel.send({ embeds: [embed] }); } catch (_) {}
  setTimeout(async () => { await drawLottery(channel); }, 10 * 60 * 60 * 1000);
}

async function drawLottery(channel) {
  if (!lottoActive || !lottoData) return;
  lottoActive = false;
  lottoLastEnd = Date.now();
  const { prize, tickets } = lottoData;
  const allTickets = [];
  for (const [uid, count] of Object.entries(tickets)) {
    for (let i = 0; i < count; i++) allTickets.push(uid);
  }
  let winnerId = null;
  for (const uid of allTickets) {
    if (Math.random() < 0.002) { winnerId = uid; break; }
  }
  const embed = new EmbedBuilder().setColor(0xFFD700).setTimestamp();
  if (winnerId) {
    addBalance(winnerId, prize);
    embed.setTitle('Lottery Results!').setDescription(`Congratulations <@${winnerId}>! You won the lottery!\n\n**Prize:** $${prize.toLocaleString()}`);
  } else {
    embed.setTitle('Lottery Results').setDescription(`No winner this round! The $${prize.toLocaleString()} prize has been rolled over.\n\nBetter luck next time!`);
  }
  try { await channel.send({ embeds: [embed] }); } catch (_) {}
  lottoData = null;
}

function scheduleFourTwenty() {
  cron.schedule('20 16 * * *', async () => { await fire420(false); }, { timezone: 'America/New_York' });
  cron.schedule('20 4 * * *', async () => { await fire420(true); }, { timezone: 'America/New_York' });
}

async function fire420(isAM) {
  if (fourTwentyActive) return;
  const channel = await findBotChannel();
  if (!channel) return;
  fourTwentyActive = true;
  claimed420.clear();
  fourTwentyIsAM = isAM;
  fourTwentyChannelId = channel.id;
  const desc = isAM
    ? '420 coins have been dropped by the haunted house.. so spooky..\n\nClick the button to claim them!'
    : 'Happy 4:20! Click the button below to claim **420 coins**!';
  const embed = new EmbedBuilder()
    .setColor(isAM ? 0x6B21A8 : 0x22C55E)
    .setTitle(isAM ? '4:20 AM — The Haunted Drop' : '4:20 PM — Happy 420!')
    .setDescription(desc)
    .setFooter({ text: 'Lasts 4 hours and 20 minutes!' })
    .setTimestamp();
  const btn = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('claim420').setLabel(isAM ? 'Collect from haunted house' : 'Happy 420').setStyle(isAM ? ButtonStyle.Secondary : ButtonStyle.Success)
  );
  const msg = await channel.send({ embeds: [embed], components: [btn] });
  fourTwentyMessageId = msg.id;
  setTimeout(async () => {
    fourTwentyActive = false;
    fourTwentyMessageId = null;
    fourTwentyChannelId = null;
    try {
      const m = await channel.messages.fetch(msg.id);
      await m.edit({ components: [] });
    } catch (_) {}
  }, (4 * 60 + 20) * 60 * 1000);
}

// --- YouTube notifier ---

async function resolveYoutubeChannelId() {
  if (ytState.channelId) return ytState.channelId;
  if (!YOUTUBE_API_KEY) return null;
  try {
    const handle = YOUTUBE_CHANNEL_HANDLE.replace(/^@/, '');
    const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'id', forHandle: handle, key: YOUTUBE_API_KEY },
      timeout: 10000,
    });
    const id = res.data.items && res.data.items[0] && res.data.items[0].id;
    if (id) {
      ytState.channelId = id;
      saveYtState();
    }
    return id || null;
  } catch (e) {
    console.error('Failed to resolve YouTube channel id:', e.message);
    return null;
  }
}

async function getYoutubeNotifyChannel() {
  try {
    const guild = client.guilds.cache.get(YOUTUBE_NOTIFY_GUILD_ID) || await client.guilds.fetch(YOUTUBE_NOTIFY_GUILD_ID);
    const channel = guild.channels.cache.get(YOUTUBE_NOTIFY_CHANNEL_ID) || await guild.channels.fetch(YOUTUBE_NOTIFY_CHANNEL_ID);
    return channel;
  } catch (e) {
    console.error('Failed to fetch YouTube notify channel:', e.message);
    return null;
  }
}

// Returns duration in seconds, or null if it couldn't be parsed (caller should
// treat null conservatively, e.g. as "too long", rather than assuming 0).
function parseIso8601DurationSeconds(duration) {
  if (!duration) return null;
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

async function pollYoutube() {
  if (!YOUTUBE_API_KEY) return;
  try {
    const channelId = await resolveYoutubeChannelId();
    if (!channelId) return;

    const isFirstRun = ytState.seenVideoIds.length === 0 && Object.keys(ytState.premieres).length === 0;

    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId,
        order: 'date',
        maxResults: 6,
        type: 'video',
        key: YOUTUBE_API_KEY,
      },
      timeout: 10000,
    });
    const items = searchRes.data.items || [];
    const videoIds = items.map(i => i.id && i.id.videoId).filter(Boolean);

    // Also re-check any pending premieres in case they aren't in the latest search page
    for (const pendingId of Object.keys(ytState.premieres)) {
      if (!videoIds.includes(pendingId)) videoIds.push(pendingId);
    }
    if (videoIds.length === 0) return;

    const detailsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,liveStreamingDetails,contentDetails',
        id: videoIds.join(','),
        key: YOUTUBE_API_KEY,
      },
      timeout: 10000,
    });
    const videos = (detailsRes.data.items || []).sort((a, b) => {
      return new Date(a.snippet.publishedAt) - new Date(b.snippet.publishedAt);
    });

    if (isFirstRun) {
      // First time the notifier has ever run for this channel — seed the seen list
      // with whatever is currently posted instead of blasting out a notification
      // for every recent video/short/stream found in this initial batch.
      for (const video of videos) {
        if (!ytState.seenVideoIds.includes(video.id)) ytState.seenVideoIds.push(video.id);
      }
      saveYtState();
      return;
    }

    const notifyChannel = await getYoutubeNotifyChannel();
    if (!notifyChannel) return;

    for (const video of videos) {
      const id = video.id;
      const link = `https://www.youtube.com/watch?v=${id}`;
      const liveStatus = video.snippet.liveBroadcastContent; // 'live' | 'upcoming' | 'none'
      const alreadySeen = ytState.seenVideoIds.includes(id);
      const pendingPremiere = ytState.premieres[id];

      if (pendingPremiere && liveStatus === 'live') {
        // Premiere has gone live — edit the original premiere message instead of posting a new one.
        try {
          const msg = await notifyChannel.messages.fetch(pendingPremiere.messageId);
          await msg.edit(`Rizzy and Mizzy are now live! Check it out:\n${link}`);
        } catch (e) {
          console.error('Failed to edit premiere message:', e.message);
        }
        delete ytState.premieres[id];
        if (!ytState.seenVideoIds.includes(id)) ytState.seenVideoIds.push(id);
        saveYtState();
        continue;
      }

      if (alreadySeen) continue;

      if (liveStatus === 'upcoming') {
        try {
          const msg = await notifyChannel.send(`Rizzy and Mizzy has a premiere starting! Check it out:\n${link}`);
          ytState.premieres[id] = { messageId: msg.id, channelId: notifyChannel.id };
        } catch (e) {
          console.error('Failed to send premiere message:', e.message);
        }
      } else if (liveStatus === 'live') {
        // No premiere was posted for this stream — send the live-now failsafe.
        try {
          await notifyChannel.send(`(this is a failsafe incase the other notifier does not correctly work.) LIVE NOW! Rizzy and Mizzy are now live! Check it out:\n${link}`);
        } catch (e) {
          console.error('Failed to send live-now failsafe message:', e.message);
        }
      } else {
        // Regular video or short — but a completed livestream/premiere also shows up here
        // with liveBroadcastContent 'none', so filter those out using liveStreamingDetails
        // and duration (anything a past livestream, or over 45 minutes, is not a normal video/short).
        const wasLivestream = !!(video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime);
        const durationSeconds = parseIso8601DurationSeconds(video.contentDetails && video.contentDetails.duration);
        // Treat an unparseable duration conservatively as "too long" rather than assuming it's short.
        const tooLong = durationSeconds === null || durationSeconds > 45 * 60;

        if (!wasLivestream && !tooLong) {
          try {
            await notifyChannel.send(`(this is a failsafe incase the other notifier does not correctly work.) A new video has been posted! Check it out:\n${link}`);
          } catch (e) {
            console.error('Failed to send video failsafe message:', e.message);
          }
        }
      }

      ytState.seenVideoIds.push(id);
      if (ytState.seenVideoIds.length > 200) {
        ytState.seenVideoIds = ytState.seenVideoIds.slice(-200);
      }
      saveYtState();
    }
  } catch (e) {
    console.error('YouTube poll error:', e.message);
  }
}

function scheduleYoutubePoll() {
  pollYoutube();
  setInterval(() => { pollYoutube(); }, YT_POLL_INTERVAL_MS);
}

async function findBotChannel(guild = null) {
  const guilds = guild ? [guild] : [...client.guilds.cache.values()];

  for (const g of guilds) {
    const settings = guildSettings[g.id];

    if (settings && settings.commandChannelId) {
      const configured = g.channels.cache.get(settings.commandChannelId);
      if (configured && configured.isTextBased() && configured.permissionsFor(g.members.me)?.has('SendMessages')) {
        return configured;
      }
    }

    const fallback = g.channels.cache.find(
      c => c.isTextBased() && c.permissionsFor(g.members.me)?.has('SendMessages')
    );

    if (fallback) return fallback;
  }

  return null;
}

client.on('interactionCreate', async (interaction) => {
  const userId = interaction.user.id;
  const u = getUser(userId);

  if (!u.botUsed) {
    u.botUsed = true;
    saveUser(userId);
  }

  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'claim420') {
      if (!fourTwentyActive) return interaction.reply({ content: 'This event has ended!', ephemeral: true });
      if (claimed420.has(userId)) return interaction.reply({ content: 'You already claimed your 420 coins!', ephemeral: true });
      claimed420.add(userId);
      addBalance(userId, 420);
      const msg = fourTwentyIsAM
        ? 'You ran into the haunted house and put them in a bag. You can still feel the shivers of the house.. or maybe because it\'s cold **+420 coins!**'
        : 'You claimed your **420 coins!** Enjoy!';
      return interaction.reply({ content: msg, ephemeral: true });
    }

    if (customId.startsWith('trivia_')) {
      const session = triviaSession[userId];
      if (!session) return interaction.reply({ content: 'No active trivia session.', ephemeral: true });
      const chosen = customId.replace('trivia_', '');
      const isCorrect = chosen === session.correct;
      delete triviaSession[userId];
      const rewards_map = { easy: 500, medium: 999, hard: 1500 };
      const reward = rewards_map[session.difficulty];
      if (isCorrect) {
        addBalance(userId, reward);
        userTriviaCorrect[userId] = (userTriviaCorrect[userId] || 0) + 1;
        const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('Correct!').setDescription(`**${session.correct}** was right!\n\nYou earned **$${reward.toLocaleString()}**!\nNew balance: **$${getBalance(userId).toLocaleString()}**`);
        return interaction.update({ embeds: [embed], components: [] });
      } else {
        const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('Wrong!').setDescription(`The correct answer was **${session.correct}**.\nBetter luck next time!`);
        return interaction.update({ embeds: [embed], components: [] });
      }
    }

    if (customId === 'gamble_door') {
      await interaction.deferUpdate();
      const waitEmbed = new EmbedBuilder().setColor(0x8B5CF6).setTitle('The Magic Egg...').setDescription('The magic egg looks at you and decides if you\'re fit to come in...\n\n*It keeps you there, staring...*').setFooter({ text: 'Please wait 30 seconds...' });
      await interaction.editReply({ embeds: [waitEmbed], components: [] });
      setTimeout(async () => {
        addBalance(userId, 67);
        const embed = new EmbedBuilder().setColor(0xF5A623).setTitle('The Magic Egg Has Decided').setDescription('After 30 long seconds of intense eye contact, the egg hands you a **$67 bill** to leave.\n\n**+$67**\nNew balance: **$' + getBalance(userId).toLocaleString() + '**');
        await interaction.editReply({ embeds: [embed], components: [] });
      }, 30000);
      return;
    }

    if (customId === 'gamble_window') {
      const embed = new EmbedBuilder().setColor(0x8B5CF6).setTitle('Caught!').setDescription('The magic egg spots you climbing through the window!\n\nDo you accept the **$30** it offers you to leave quietly?');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gamble_yes').setLabel('Yes, take the $30').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('gamble_no').setLabel('No thanks').setStyle(ButtonStyle.Danger),
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'gamble_yes') {
      addBalance(userId, 42);
      const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('The Egg Is Pleased').setDescription('The egg is pleased by your honesty.\n\nIt gives you **$42** and a penny... and points you toward a dark alley.\n\n*Scary.*\n\n**+$42**\nNew balance: **$' + getBalance(userId).toLocaleString() + '**');
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId === 'gamble_no') {
      addBalance(userId, 30);
      const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('Kicked Out!').setDescription('You refuse, but the egg throws you out anyway.\n\nIt also throws the **$30** at you on the way out.\n\n**+$30** (whether you like it or not)\nNew balance: **$' + getBalance(userId).toLocaleString() + '**');
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId.startsWith('rps_')) {
      const choice = customId.replace('rps_', '');
      const options = ['rock', 'paper', 'scissors'];
      const botChoice = options[randomInt(0, 2)];
      const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
      const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
      let result, delta;
      if (choice === botChoice) { result = "It's a tie!"; delta = 0; }
      else if (beats[choice] === botChoice) { result = 'You win! +$10'; delta = 10; }
      else { result = 'You lose! -$5'; delta = -5; }
      addBalance(userId, delta);
      const embed = new EmbedBuilder()
        .setColor(delta > 0 ? 0x22C55E : delta < 0 ? 0xEF4444 : 0x6B7280)
        .setTitle('Rock Paper Scissors')
        .setDescription(`You chose ${emojis[choice]} **${choice}**\nBot chose ${emojis[botChoice]} **${botChoice}**\n\n**${result}**\nBalance: **$${getBalance(userId).toLocaleString()}**`);
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId.startsWith('shop_buy_')) {
      const pid = customId.replace('shop_buy_', '');
      const plushie = PLUSHIES.find(p => p.id === pid);
      if (!plushie) return interaction.reply({ content: 'Invalid plushie.', ephemeral: true });
      if (getBalance(userId) < plushie.price) return interaction.reply({ content: `You need $${plushie.price} but only have $${getBalance(userId)}.`, ephemeral: true });
      addBalance(userId, -plushie.price);
      u.plushies.push(pid);
      saveUser(userId);
      const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('Purchase Successful!').setDescription(`You bought a **${plushie.name}**!\n\nIt will give you **$${plushie.petReward}** every hour when you /pet it.\nNew balance: **$${getBalance(userId).toLocaleString()}**`);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId === 'lotto_confirm') {
      const pending = u._lottoPending;
      if (!pending) return interaction.reply({ content: 'No pending lottery purchase.', ephemeral: true });
      delete u._lottoPending;
      if (getBalance(userId) < pending.cost) return interaction.reply({ content: `You don't have enough money! You need **$${pending.cost}** but only have **$${getBalance(userId)}**.`, ephemeral: true });
      addBalance(userId, -pending.cost);
      if (!lottoData.tickets[userId]) lottoData.tickets[userId] = 0;
      lottoData.tickets[userId] += pending.count;
      const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('Tickets Purchased!').setDescription(`You bought **${pending.count}** ticket${pending.count > 1 ? 's' : ''} for **$${pending.cost}**!\nYou now have **${lottoData.tickets[userId]}** tickets.\n\nNew balance: **$${getBalance(userId).toLocaleString()}**\n*Each ticket gives a 0.2% chance of winning!*`);
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId === 'lotto_cancel') {
      delete u._lottoPending;
      return interaction.update({ content: 'Lottery purchase cancelled.', embeds: [], components: [] });
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const nonSetupCommands = ['setup', 'ping', 'cmds', 'help', 'info', 'rememberance', 'forcenotify', 'deletelastmsg', 'talk'];
  if (!nonSetupCommands.includes(commandName) && !checkSetupChannel(interaction)) return;

  if (commandName === 'ping') {
    return interaction.reply({ content: 'stop.' });
  }

  if (commandName === 'rememberance') {
    return interaction.reply({ content: 'this bot was made by treecap originally. we all wish them happiness and good luck! yay!' });
  }

  if (commandName === 'forcenotify') {
    if (!FORCE_NOTIFY_USER_IDS.includes(userId)) {
      return interaction.reply({ content: '😡😡😡', ephemeral: true });
    }
    const type = interaction.options.getString('type');
    const link = interaction.options.getString('link');
    const notifyChannel = await getYoutubeNotifyChannel();
    if (!notifyChannel) {
      return interaction.reply({ content: 'Could not find the notification channel.', ephemeral: true });
    }
    const content = type === 'live'
      ? `(this is a failsafe incase the other notifier does not correctly work.) LIVE NOW! Rizzy and Mizzy are now live! Check it out:\n${link}`
      : `(this is a failsafe incase the other notifier does not correctly work.) A new video has been posted! Check it out:\n${link}`;
    try {
      await notifyChannel.send(content);
      return interaction.reply({ content: 'Notification sent!', ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `Failed to send notification: ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'deletelastmsg') {
    if (!FORCE_NOTIFY_USER_IDS.includes(userId)) {
      return interaction.reply({ content: '😡😡😡', ephemeral: true });
    }
    const notifyChannel = await getYoutubeNotifyChannel();
    if (!notifyChannel) {
      return interaction.reply({ content: 'Could not find the notification channel.', ephemeral: true });
    }
    try {
      const recentMessages = await notifyChannel.messages.fetch({ limit: 20 });
      const lastBotMessage = recentMessages.find(m => m.author.id === client.user.id);
      if (!lastBotMessage) {
        return interaction.reply({ content: 'No recent message from me found in that channel.', ephemeral: true });
      }
      await lastBotMessage.delete();
      return interaction.reply({ content: 'Deleted my last message in that channel.', ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `Failed to delete message: ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'talk') {
    if (!FORCE_NOTIFY_USER_IDS.includes(userId)) {
      return interaction.reply({ content: '😡😡😡', ephemeral: true });
    }
    const targetChannel = interaction.options.getChannel('channel');
    const talkMessage = interaction.options.getString('message');
    const bannedWords = ['job', 'employment', 'grass'];
    const lowerMsg = talkMessage.toLowerCase();
    if (bannedWords.some(w => lowerMsg.includes(w))) {
      return interaction.reply({ content: `I cannot say such foul things such as j*b, empl*yment, or gr*ss. Shame on <@${userId}>!`, ephemeral: false });
    }
    try {
      const channel = await client.channels.fetch(targetChannel.id);
      await channel.send(talkMessage);
      return interaction.reply({ content: `Sent your message in <#${targetChannel.id}>.`, ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `Failed to send message: ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'giveaway') {
    if (!interaction.member || !hasAdminRole(interaction.member)) return interaction.reply({ content: '😡😡😡', ephemeral: true });
    const winner = interaction.options.getUser('winner');
    const amount = interaction.options.getInteger('amount');
    const prize = interaction.options.getString('prize') || `$${amount.toLocaleString()}`;
    addBalance(winner.id, amount);
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🎉 GIVEAWAY WINNER!')
      .setDescription(`Congratulations to <@${winner.id}>!\n\n**Prize:** ${prize}\n**Amount:** $${amount.toLocaleString()} added to their balance!\n\nNew balance: **$${getBalance(winner.id).toLocaleString()}**`)
      .setThumbnail(winner.displayAvatarURL())
      .setTimestamp()
      .setFooter({ text: `Hosted by ${interaction.user.username}` });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'givemoney') {
    if (!interaction.member || !hasAdminRole(interaction.member)) return interaction.reply({ content: '😡😡😡', ephemeral: true });
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    addBalance(target.id, amount);
    const embed = new EmbedBuilder()
      .setColor(0x22C55E)
      .setTitle('💸 Money Given')
      .setDescription(`**${interaction.user.username}** gave **$${amount.toLocaleString()}** to <@${target.id}>!\n\nNew balance: **$${getBalance(target.id).toLocaleString()}**`)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'balance') {
    const embed = new EmbedBuilder().setColor(0x3B82F6).setTitle(`${interaction.user.username}'s Balance`).setDescription(`**$${getBalance(userId).toLocaleString()}**`).setThumbnail(interaction.user.displayAvatarURL());
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'balancetop') {
    const sorted = Object.entries(users).sort((a, b) => b[1].balance - a[1].balance).slice(0, 10);
    const lines = await Promise.all(sorted.map(async ([uid, data], i) => {
      let name = uid;
      try { const usr = await client.users.fetch(uid); name = usr.username; } catch (_) {}
      return `**${i + 1}.** ${name} — $${data.balance.toLocaleString()}`;
    }));
    const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('Top Balances').setDescription(lines.join('\n') || 'No data yet.');
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setup') {
    if (!interaction.member || !hasAdminRole(interaction.member)) {
      return interaction.reply({ content: '😡😡😡', ephemeral: true });
    }
    const channel = interaction.options.getChannel('channel');
    if (!guildSettings[interaction.guildId]) guildSettings[interaction.guildId] = {};
    guildSettings[interaction.guildId].commandChannelId = channel.id;
    await saveGuildSettings(interaction.guildId);
    const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('Setup Complete').setDescription(`Bot commands are now restricted to ${channel}.\nUsers will get an error if they try commands elsewhere.`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'enabledaily') {
    u.dailyEnabled = !u.dailyEnabled;
    saveUser(userId);
    return interaction.reply({ content: u.dailyEnabled ? 'Daily money enabled! You\'ll earn **$1,000** every day you chat.' : 'Daily money disabled.', ephemeral: true });
  }

  if (commandName === 'cmds') {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Commands')
      .addFields(
        { name: 'Admin', value: '`/moderatenickname` <user> — Moderate Nickname\n`/giveaway` <winner> <amount> — Start a giveaway\n`/givemoney` <user> <amount> — Give money to a user' },
        { name: 'Economy', value: '`/balance` — Check Your Balance\n`/balancetop` — Check Top Balances\n`/shop` — Buy Plushies\n`/pet` — Pet your plushie for money\n`/enabledaily` — Toggle daily $1000 for chatting\n`/key` [code] — Redeem a key for money' },
        { name: 'Fun', value: '`/curse` [user] — Curse someone... maybe\n`/redeem` — Streamlabs Redeems\n`/freerobux` — Definitely Real Free Robux\n`/shush` — Shush\n`/egg` — Show Rizzy as an egg\n`/nevergonnagiveyouup` — Rickroll\n`/bomb` — Blow up a bomb\n`/prankrizzy` — Pull the ultimate prank\n`/swag` — Get the ultimate swag link' },
        { name: 'Games', value: '`/slots` — Game Of Slots\n`/doubleornothing` [bet] — Double Or Nothing\n`/coinflip` — Flip a coin to win or lose $5\n`/dice` — Roll Dice\n`/scratch` — Scratch Ticket for $1\n`/beg` — Beg For Money\n`/rockpaperscissors` — Rock Paper Scissors\n`/trivia` — Answer trivia for money!\n`/gamble` — The magic egg awaits...\n`/lottery` — Buy a lotto ticket' },
        { name: 'Image', value: '`/lgbtifyguild` [guild id] — Guild logo with a hint of LGBT\n`/lgbtify` [user] — Profile pic with a hint of LGBT' },
        { name: 'Information', value: '`/help` — Show this message\n`/schedule` — Rizzy And Mizzy\'s stream schedule\n`/live` — Check if Rizzy And Mizzy are live\n`/info` — Bot information\n`/rememberance` — A message of appreciation' },
        { name: 'Other', value: '`/ping` — Checks if the bot is working' },
        { name: 'Tools', value: '`/qrcode` [text or link] — QR Code Generator' },
        { name: 'Setup', value: '`/setup` — Set bot command channel (Admin only)' },
        { name: 'YouTube Notifier', value: '`/forcenotify` <type> <link> — Manually send a video/live notification (restricted)\n`/deletelastmsg` — Delete the bot\'s last message in the notification channel (restricted)' },
        { name: 'Restricted', value: '`/talk` <channel> <message> — Make the bot say something in a channel (restricted)' },
      )
      .setFooter({ text: 'RMControl Bot' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'help') {
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('RMControl Bot Help').setDescription('Use `/cmds` to see all commands!\n\nThis bot has economy, games, trivia, daily events, and more!').setFooter({ text: 'RMControl Bot' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'info') {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('RMControl Bot Info')
      .setDescription('A feature-packed Discord bot for the Rizzy & Mizzy community!')
      .addFields(
        { name: 'Version', value: '1.0.0', inline: true },
        { name: 'Users Tracked', value: Object.keys(users).length.toString(), inline: true },
        { name: 'DB Connected', value: pool ? 'Yes (persistent)' : 'No (in-memory only)', inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'schedule') {
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Rizzy & Mizzy Stream Schedule').setDescription('Check our socials for the latest stream schedule!');
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'live') {
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Are Rizzy & Mizzy Live?').setDescription('Check our Twitch/YouTube for current live status!');
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'moderatenickname') {
    if (!interaction.member || !hasAdminRole(interaction.member)) return interaction.reply({ content: '😡😡😡', ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: 'User not found.', ephemeral: true });
    const modal_nick = target.nickname || target.user.username;
    const cleaned = modal_nick.replace(/[^\w\s]/gi, '').trim() || 'ModeratedUser';
    try {
      await target.setNickname(cleaned, 'Nickname moderated by bot command');
      return interaction.reply({ content: `Nickname moderated for **${target.user.username}**: set to \`${cleaned}\``, ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: 'Could not change nickname. Make sure the bot has the Manage Nicknames permission.', ephemeral: true });
    }
  }

  if (commandName === 'curse') {
    const target = interaction.options.getUser('target');
    const won = Math.random() < 0.10;
    if (won) {
      addBalance(userId, 500);
      return interaction.reply({ content: `You put candles around you as you closed your eyes. Nothing happens, and you wasted $2 buying candles. But you found an extra $2 in your couch. yay! you didn't lose much. Maybe there's a chance this would have a different outcome?\n\n*...wait. Something stirs. The curse on **${target.username}** actually worked??* **+$500!**\nBalance: **$${getBalance(userId).toLocaleString()}**` });
    }
    return interaction.reply({ content: `You put candles around you as you closed your eyes. Nothing happens, and you wasted $2 buying candles. But you found an extra $2 in your couch. yay! you didn't lose much. Maybe there's a chance this would have a different outcome?` });
  }

  if (commandName === 'redeem') {
    const STREAMLABS_TOKEN = process.env.STREAMLABS_TOKEN;
    if (!STREAMLABS_TOKEN) {
      return interaction.reply({
        content: 'Streamlabs is not connected yet. To link it, set the `STREAMLABS_TOKEN` environment variable in Railway using your Streamlabs API token from https://streamlabs.com/dashboard#/settings/api-settings',
        ephemeral: true,
      });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await axios.get('https://streamlabs.com/api/v1.0/donations', {
        params: { access_token: STREAMLABS_TOKEN, limit: 5 },
        timeout: 8000,
      });
      const donations = res.data.data;
      if (!donations || donations.length === 0) {
        return interaction.editReply({ content: 'No recent redeems or donations found on Streamlabs.' });
      }
      const lines = donations.map(d => `**${d.name}** — $${d.amount} ${d.currency} *(${d.message || 'no message'})*`).join('\n');
      const embed = new EmbedBuilder().setColor(0x80F5D2).setTitle('Recent Streamlabs Donations').setDescription(lines).setFooter({ text: 'Powered by Streamlabs' });
      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      return interaction.editReply({ content: `Failed to fetch Streamlabs data: ${e.message}` });
    }
  }

  if (commandName === 'key') {
    const code = interaction.options.getString('code').toUpperCase().trim();
    if (usedKeys.has(code)) {
      return interaction.reply({ content: 'That key has already been redeemed!', ephemeral: true });
    }
    const userRedeemedKeys = u._redeemedKeys || [];
    if (userRedeemedKeys.includes(code)) {
      return interaction.reply({ content: 'You have already redeemed that key!', ephemeral: true });
    }
    const prize = KEYS[code];
    if (!prize) {
      return interaction.reply({ content: 'That key is invalid or does not exist.', ephemeral: true });
    }
    usedKeys.add(code);
    if (!u._redeemedKeys) u._redeemedKeys = [];
    u._redeemedKeys.push(code);
    addBalance(userId, prize);
    const embed = new EmbedBuilder()
      .setColor(0x22C55E)
      .setTitle('Key Redeemed!')
      .setDescription(`Key \`${code}\` accepted!\n\n**+$${prize.toLocaleString()}** added to your balance!\nNew balance: **$${getBalance(userId).toLocaleString()}**`)
      .setFooter({ text: 'Keys are one-use only' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'swag') {
    return interaction.reply({ content: 'Want the ultimate swag? Look no further 👇\n[Get your swag here!](https://rizzy-and-mizzy.creator-spring.com/)\n*This website gives you the ultimate swag!*' });
  }

  if (commandName === 'freerobux') {
    const embed = new EmbedBuilder().setColor(0x00B2FF).setTitle('FREE ROBUX!!!').setDescription('**Click here for FREE ROBUX:** [bit.ly/definitely-not-a-scam](https://www.roblox.com)\n\n*(There is no free Robux. There has never been free Robux. There will never be free Robux.)*').setFooter({ text: 'Definitely Real™' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'shush') {
    return interaction.reply({ content: 'SHUSH!' });
  }

  if (commandName === 'egg') {
    const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('Rizzy as an Egg').setDescription('*A true artistic masterpiece.*').setImage('https://i.imgur.com/UgVoGZH.png').setFooter({ text: 'Crafted with love and shell' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'nevergonnagiveyouup') {
    return interaction.reply({ content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n*Never gonna give you up, never gonna let you down...*' });
  }

  if (commandName === 'bomb') {
    await interaction.reply({ content: '. . .' });
    setTimeout(async () => { try { await interaction.editReply({ content: '**BOOM!**' }); } catch (_) {} }, 2000);
    return;
  }

  if (commandName === 'slots') {
    const cost = 5;
    if (getBalance(userId) < cost) return interaction.reply({ content: `Slots costs $${cost}. You only have $${getBalance(userId)}.`, ephemeral: true });
    addBalance(userId, -cost);
    const symbols = ['🍒', '🍋', '🍊', '⭐', '💎', '7️⃣'];
    const s = () => symbols[randomInt(0, symbols.length - 1)];
    const row1 = [s(), s(), s()];
    const won = row1.every(x => x === row1[0]);
    const jackpot = won && row1[0] === '💎';
    let prize = 0;
    if (jackpot) prize = 500;
    else if (won) prize = 50;
    addBalance(userId, prize);
    const embed = new EmbedBuilder()
      .setColor(jackpot ? 0xFFD700 : won ? 0x22C55E : 0xEF4444)
      .setTitle('Slots')
      .setDescription(`**| ${row1.join(' | ')} |**\n\n${jackpot ? '**JACKPOT! +$500!**' : won ? `**You win! +$${prize}!**` : `No match. -$${cost}`}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'doubleornothing') {
    const bet = interaction.options.getInteger('bet');
    if (getBalance(userId) < bet) return interaction.reply({ content: `You don't have $${bet}!`, ephemeral: true });
    addBalance(userId, -bet);
    const win = Math.random() < 0.5;
    const prize = win ? bet * 2 : 0;
    addBalance(userId, prize);
    const embed = new EmbedBuilder()
      .setColor(win ? 0x22C55E : 0xEF4444)
      .setTitle('Double Or Nothing')
      .setDescription(`You bet **$${bet}**.\n${win ? `**You doubled it! +$${prize}!**` : '**Nothing. You lost it all.**'}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'coinflip') {
    const win = Math.random() < 0.5;
    addBalance(userId, win ? 5 : -5);
    const embed = new EmbedBuilder()
      .setColor(win ? 0x22C55E : 0xEF4444)
      .setTitle('Coin Flip')
      .setDescription(`The coin landed on **${win ? 'Heads' : 'Tails'}**!\n${win ? '**+$5!**' : '**-$5.**'}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'dice') {
    const roll = randomInt(1, 6);
    const prize = roll >= 5 ? 20 : roll >= 3 ? 0 : -10;
    addBalance(userId, prize);
    const embed = new EmbedBuilder()
      .setColor(prize > 0 ? 0x22C55E : prize < 0 ? 0xEF4444 : 0x6B7280)
      .setTitle('Dice Roll')
      .setDescription(`You rolled a **${roll}**!\n${prize > 0 ? `+$${prize}` : prize < 0 ? `$${prize}` : 'Nothing happens.'}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'scratch') {
    if (getBalance(userId) < 1) return interaction.reply({ content: 'You need $1 for a scratch ticket!', ephemeral: true });
    addBalance(userId, -1);
    const s = () => randomInt(1, 6);
    const grid = [[s(), s(), s()], [s(), s(), s()], [s(), s(), s()]];
    const counts = {};
    grid.flat().forEach(n => { counts[n] = (counts[n] || 0) + 1; });
    const matches3 = Object.values(counts).filter(v => v >= 3).length;
    let prize = 0;
    let msg = 'No match. Better luck next time!';
    if (matches3 >= 3) { prize = 15; msg = '**3 LOTS OF 3! +$15!**'; }
    else if (matches3 >= 1) { prize = 2; msg = '**3 Matched! +$2!**'; }
    addBalance(userId, prize);
    const display = grid.map(row => row.join(' | ')).join('\n');
    const embed = new EmbedBuilder()
      .setColor(prize > 0 ? 0x22C55E : 0xEF4444)
      .setTitle('Scratch Ticket')
      .setDescription(`**Ticket:**\n\`\`\`\n${display}\n\`\`\`\n${msg}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'beg') {
    const responses = [
      { text: 'A kind stranger throws you $15!', amount: 15 },
      { text: 'Someone ignores you completely.', amount: 0 },
      { text: 'A pigeon drops $3 at your feet.', amount: 3 },
      { text: 'You find $8 on the ground while begging!', amount: 8 },
      { text: 'Someone lectures you for 10 minutes then gives you $1.', amount: 1 },
      { text: 'The wind blows away your sign. Nothing.', amount: 0 },
      { text: 'A rich person walks by and hands you $25!', amount: 25 },
    ];
    const res = responses[randomInt(0, responses.length - 1)];
    addBalance(userId, res.amount);
    const embed = new EmbedBuilder()
      .setColor(res.amount > 0 ? 0x22C55E : 0x6B7280)
      .setTitle('Begging...')
      .setDescription(`${res.text}${res.amount > 0 ? `\n**+$${res.amount}**` : ''}\nBalance: **$${getBalance(userId).toLocaleString()}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'rockpaperscissors') {
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Rock Paper Scissors').setDescription('Choose your move! (Win: +$10 | Lose: -$5 | Tie: $0)');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rps_rock').setLabel('Rock').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('rps_paper').setLabel('Paper').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('rps_scissors').setLabel('Scissors').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'lgbtify') {
    const target = interaction.options.getUser('user') || interaction.user;
    const avatarURL = target.displayAvatarURL({ extension: 'png', size: 256 });
    const embed = new EmbedBuilder().setColor(0xFF69B4).setTitle(`${target.username} — Pride Edition!`).setDescription('🌈❤️🧡💛💚💙💜\n*Your avatar, but make it pride!*').setImage(avatarURL).setFooter({ text: 'Love is love' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'lgbtifyguild') {
    const guildId = interaction.options.getString('guildid');
    let guild = interaction.guild;
    if (guildId) guild = client.guilds.cache.get(guildId) || interaction.guild;
    const iconURL = guild.iconURL({ extension: 'png', size: 256 });
    const embed = new EmbedBuilder().setColor(0xFF69B4).setTitle(`${guild.name} — Pride Edition!`).setDescription('🌈❤️🧡💛💚💙💜\n*This server\'s logo, but make it pride!*').setImage(iconURL || null).setFooter({ text: 'Love is love' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'qrcode') {
    const text = interaction.options.getString('text');
    await interaction.deferReply();
    try {
      const buffer = await QRCode.toBuffer(text, { width: 400, margin: 2 });
      const attachment = new AttachmentBuilder(buffer, { name: 'qrcode.png' });
      const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('QR Code').setDescription(`Generated for: \`${text.substring(0, 100)}\``).setImage('attachment://qrcode.png');
      return interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (e) {
      return interaction.editReply({ content: 'Failed to generate QR code.' });
    }
  }

  if (commandName === 'trivia') {
    if (triviaSession[userId]) return interaction.reply({ content: 'You already have an active trivia session! Answer the current question first.', ephemeral: true });
    const difficulty = interaction.options.getString('difficulty');
    const rewards_map = { easy: 500, medium: 999, hard: 1500 };
    await interaction.deferReply();
    try {
      const response = await axios.get(`https://opentdb.com/api.php?amount=1&difficulty=${difficulty}&type=multiple`, { timeout: 10000 });
      const result = response.data.results[0];
      if (!result) throw new Error('No question');
      const decode = (str) => str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&hellip;/g, '...').replace(/&ndash;/g, '–');
      const question = decode(result.question);
      const correctAnswer = decode(result.correct_answer);
      const allAnswers = [...result.incorrect_answers.map(decode), correctAnswer].sort(() => Math.random() - 0.5);
      triviaSession[userId] = { correct: correctAnswer, difficulty };
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Trivia — ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}`)
        .setDescription(`**${question}**\n\nCategory: *${decode(result.category)}*\n\nCorrect answer: **$${rewards_map[difficulty].toLocaleString()}**`)
        .setFooter({ text: 'Choose your answer below!' });
      const buttons = allAnswers.map(ans => new ButtonBuilder().setCustomId(`trivia_${ans}`).setLabel(ans.substring(0, 80)).setStyle(ButtonStyle.Primary));
      const row = new ActionRowBuilder().addComponents(...buttons);
      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      const fallbackQ = [
        { q: 'What color is the sky on a clear day?', correct: 'Blue', wrong: ['Red', 'Green', 'Yellow'] },
        { q: 'How many sides does a triangle have?', correct: '3', wrong: ['4', '5', '6'] },
        { q: 'What is 2 + 2?', correct: '4', wrong: ['3', '5', '22'] },
        { q: 'What animal says "moo"?', correct: 'Cow', wrong: ['Dog', 'Cat', 'Pig'] },
      ];
      const fb = fallbackQ[randomInt(0, fallbackQ.length - 1)];
      const allAnswers = [...fb.wrong, fb.correct].sort(() => Math.random() - 0.5);
      triviaSession[userId] = { correct: fb.correct, difficulty };
      const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`Trivia — ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}`).setDescription(`**${fb.q}**\n\nCorrect answer: **$${rewards_map[difficulty].toLocaleString()}**`).setFooter({ text: 'Choose your answer below!' });
      const buttons = allAnswers.map(ans => new ButtonBuilder().setCustomId(`trivia_${ans}`).setLabel(ans).setStyle(ButtonStyle.Primary));
      const row = new ActionRowBuilder().addComponents(...buttons);
      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  }

  if (commandName === 'lottery') {
    if (!lottoActive || !lottoData) {
      return interaction.reply({ content: 'No lottery is currently active! Wait for the next one to start automatically.', ephemeral: true });
    }
    const count = interaction.options.getInteger('tickets') || 1;
    const cost = count * 10;
    const timeLeft = Math.max(0, lottoData.endTime - Date.now());
    const hoursLeft = Math.floor(timeLeft / 3600000);
    const minutesLeft = Math.floor((timeLeft % 3600000) / 60000);
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('Lottery Ticket Purchase')
      .setDescription(`**Prize Pool:** $${lottoData.prize.toLocaleString()}\n\nYou want to buy **${count}** ticket${count > 1 ? 's' : ''} for a total of **$${cost}**.\n\nEach ticket gives you a **0.2%** chance of winning!\nTime remaining: **${hoursLeft}h ${minutesLeft}m**\n\nAre you sure?`);
    u._lottoPending = { count, cost };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lotto_confirm').setLabel(`Yes, buy ${count} ticket${count > 1 ? 's' : ''} for $${cost}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('lotto_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  if (commandName === 'shop') {
    const owned = u.plushies;
    const embed = new EmbedBuilder()
      .setColor(0xEC4899)
      .setTitle('Plushie Shop')
      .setDescription('Buy a plushie and use `/pet` every hour to earn money!\n')
      .addFields(
        ...PLUSHIES.map(p => ({
          name: `${p.emoji} ${p.name} (${p.rarity})`,
          value: `Price: **$${p.price}**\nPet reward: **$${p.petReward}/hour**\nYou own: **${owned.filter(x => x === p.id).length}**`,
          inline: true,
        }))
      )
      .setFooter({ text: `Your balance: $${getBalance(userId).toLocaleString()}` });
    const row = new ActionRowBuilder().addComponents(
      ...PLUSHIES.map(p => new ButtonBuilder().setCustomId(`shop_buy_${p.id}`).setLabel(`Buy ${p.emoji} $${p.price}`).setStyle(ButtonStyle.Primary))
    );
    return interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'pet') {
    const pid = interaction.options.getString('plushie');
    const owned = u.plushies.filter(x => x === pid);
    if (owned.length === 0) {
      const p = PLUSHIES.find(x => x.id === pid);
      return interaction.reply({ content: `You don't own a ${p ? p.name : 'plushie'} yet! Buy one from **/shop**.`, ephemeral: true });
    }
    const lastPet = u.lastPet[pid] || 0;
    const cooldown = 60 * 60 * 1000;
    if (Date.now() - lastPet < cooldown) {
      const remaining = cooldown - (Date.now() - lastPet);
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      return interaction.reply({ content: `Your plushie is resting! Come back in **${m}m ${s}s**.`, ephemeral: true });
    }
    u.lastPet[pid] = Date.now();
    const plushie = PLUSHIES.find(p => p.id === pid);
    addBalance(userId, plushie.petReward);
    u._petCount = (u._petCount || 0) + 1;
    saveUser(userId);
    const embed = new EmbedBuilder()
      .setColor(0xEC4899)
      .setTitle('Pet Time!')
      .setDescription(`You petted your **${plushie.name}**!\n\n**+$${plushie.petReward}**\nNew balance: **$${getBalance(userId).toLocaleString()}**\n\n*Come back in 1 hour to pet again!*`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'gamble') {
    const lastGamble = u.lastGamble || 0;
    const cooldown = 60 * 60 * 1000;
    if (Date.now() - lastGamble < cooldown) {
      const remaining = cooldown - (Date.now() - lastGamble);
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      return interaction.reply({ content: `The magic egg is still watching... try again in **${m}m ${s}s**.`, ephemeral: true });
    }
    u.lastGamble = Date.now();
    saveUser(userId);
    const embed = new EmbedBuilder()
      .setColor(0x8B5CF6)
      .setTitle('The Magic Egg\'s Domain')
      .setDescription('You approach a mysterious building. The **magic egg** waits inside.\n\nHow do you enter?');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gamble_door').setLabel('Through the door').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gamble_window').setLabel('Through the window').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'prankrizzy') {
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('LOTTERY RESULTS!')
      .setDescription('**OMG! RIZZY JUST WON $67,000,000 IN THE LOTTO! CONGRATS RIZZY!**\n\n*Rizzy wakes up feeling angry. It was just a dream.*')
      .setTimestamp()
      .setFooter({ text: '(This is a prank embed — no actual ping was sent)' });
    return interaction.reply({ embeds: [embed] });
  }
});

if (!TOKEN) {
  console.error('ERROR: No DISCORD_TOKEN set. Set it in Railway environment variables.');
  process.exit(1);
}

client.login(TOKEN).catch(err => {
  console.error('Failed to login:', err.message);
  process.exit(1);
});

