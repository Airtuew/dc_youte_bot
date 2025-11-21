require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, InteractionResponseFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const playdl = require('play-dl');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID || null;

if (!token || !clientId) {
  console.error('請在 .env 裡設定 DISCORD_TOKEN 與 CLIENT_ID');
  process.exit(1);
}

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates ]
});

const queues = new Map();

function getOrCreateQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      player: createAudioPlayer(),
      playing: false
    });
  }
  return queues.get(guildId);
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.songs.length === 0) {
    q.playing = false;
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    return;
  }

  const track = q.songs.shift();
  try {
    const streamInfo = await playdl.stream(track.url, { quality: 2 });
    const resource = createAudioResource(streamInfo.stream, { inputType: streamInfo.type });
    q.player.play(resource);
    q.playing = true;

    q.player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
  } catch (err) {
    console.error('播放錯誤', err);
    playNext(guildId);
  }
}

// 連線語音頻道 + 訂閱 player
async function connectAndPlay(interaction, voiceChannel) {
  const guildId = interaction.guildId;
  const q = getOrCreateQueue(guildId);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // ✅ 防止加密模式錯誤
    selfMute: false
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }

  connection.subscribe(q.player);
}

// Slash commands
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('讓機器人加入你的語音頻道'),
  new SlashCommandBuilder().setName('leave').setDescription('讓機器人離開語音頻道'),
  new SlashCommandBuilder().setName('play').setDescription('播放 YouTube 音樂').addStringOption(opt => opt.setName('url').setDescription('YouTube 連結或關鍵字').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('跳過目前歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止並清空隊列'),
  new SlashCommandBuilder().setName('queue').setDescription('顯示隊列'),
  new SlashCommandBuilder().setName('now').setDescription('顯示現在正在播放的歌')
].map(cmd => cmd.toJSON());

// 註冊 slash 指令
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('已在指定伺服器註冊指令');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('已全域註冊指令（生效可能需要幾分鐘）');
    }
  } catch (err) {
    console.error('註冊指令失敗', err);
  }
}

// 處理互動
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const guildId = interaction.guildId;
  const q = getOrCreateQueue(guildId);

  try {
    if (interaction.commandName === 'join') {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: '你必須先加入語音頻道。', flags: InteractionResponseFlags.Ephemeral });
      await connectAndPlay(interaction, voiceChannel);
      return interaction.reply({ content: '已加入語音頻道。', flags: InteractionResponseFlags.Ephemeral });
    }

    if (interaction.commandName === 'leave') {
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();
      queues.delete(guildId);
      return interaction.reply({ content: '已離開語音頻道並清空隊列。', flags: InteractionResponseFlags.Ephemeral });
    }

    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('url', true);
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.editReply('你必須先加入語音頻道。');

      let url = query;
      let info;
      try {
        if (!playdl.yt_validate(query)) {
          const results = await playdl.search(query, { limit: 1 });
          if (results.length === 0) return interaction.editReply('找不到結果。');
          url = results[0].url;
          info = results[0];
        } else {
          info = await playdl.video_info(query);
        }
      } catch (err) {
        console.error('搜尋或取得影片資訊錯誤', err);
        return interaction.editReply('無法取得影片資訊。');
      }

      q.songs.push({
        title: info.title || (info.video_details && info.video_details.title) || 'Unknown',
        url: url
      });

      try {
        await connectAndPlay(interaction, voiceChannel);
      } catch (err) {
        console.error('連線語音錯誤', err);
        return interaction.editReply('連線語音頻道失敗。');
      }

      interaction.editReply(`已加入隊列：**${q.songs[q.songs.length-1].title}**`);
      if (!q.playing) playNext(guildId);
      return;
    }

    if (interaction.commandName === 'skip') {
      const conn = getVoiceConnection(guildId);
      if (!conn) return interaction.reply({ content: '機器人不在語音頻道。', flags: InteractionResponseFlags.Ephemeral });
      q.player.stop();
      return interaction.reply({ content: '已跳過目前歌曲。', flags: InteractionResponseFlags.Ephemeral });
    }

    if (interaction.commandName === 'stop') {
      q.songs = [];
      q.player.stop();
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();
      queues.delete(guildId);
      return interaction.reply({ content: '已停止並清空隊列。', flags: InteractionResponseFlags.Ephemeral });
    }

    if (interaction.commandName === 'queue') {
      if (!q.songs.length) return interaction.reply({ content: '目前隊列為空。', flags: InteractionResponseFlags.Ephemeral });
      const list = q.songs.slice(0, 10).map((s, i) => `${i+1}. ${s.title}`).join('\n');
      return interaction.reply({ content: `目前隊列（前10首）：\n${list}` });
    }

    if (interaction.commandName === 'now') {
      const current = q.player.state.status === AudioPlayerStatus.Playing ? '正在播放' : '目前無播放';
      const nextTitle = q.songs[0] ? `下一首：${q.songs[0].title}` : '隊列沒有下一首';
      return interaction.reply({ content: `${current}\n${nextTitle}` });
    }

  } catch (err) {
    console.error('指令處理錯誤', err);
    if (interaction.deferred || interaction.replied) {
      interaction.editReply('發生錯誤，請查看機器人日誌。');
    } else {
      interaction.reply({ content: '發生錯誤，請查看機器人日誌。', flags: InteractionResponseFlags.Ephemeral });
    }
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(token);