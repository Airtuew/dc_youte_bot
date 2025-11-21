// --- 防 Render 睡眠功能 ---
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

// 讓 Render 偵測到 PORT，避免睡眠
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Anti-sleep web server running on port ${PORT}`);
});

// ---------------- Discord Bot ------------------

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// 播放隊列
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

async function connectAndPlay(interaction, voiceChannel) {
  const guildId = interaction.guildId;
  const q = getOrCreateQueue(guildId);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }

  connection.subscribe(q.player);
}

// Slash Commands
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('讓機器人加入你的語音頻道'),
  new SlashCommandBuilder().setName('leave').setDescription('讓機器人離開語音頻道'),
  new SlashCommandBuilder().setName('play').setDescription('播放 YouTube 音樂').addStringOption(o => o.setName('url').setDescription('YouTube 連結或關鍵字').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('跳過目前歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止並清空隊列'),
  new SlashCommandBuilder().setName('queue').setDescription('顯示隊列'),
  new SlashCommandBuilder().setName('now').setDescription('顯示現在正在播放的歌')
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('已在指定伺服器註冊指令');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('已全域註冊指令（可能需幾分鐘）');
    }
  } catch (err) {
    console.error('註冊指令失敗', err);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const guildId = interaction.guildId;
  const q = getOrCreateQueue(guildId);

  try {
    if (interaction.commandName === 'join') {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: '你必須先加入語音頻道。', ephemeral: true });

      await connectAndPlay(interaction, voiceChannel);
      return interaction.reply('已加入語音頻道。');
    }

    if (interaction.commandName === 'leave') {
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();
      queues.delete(guildId);
      return interaction.reply('已離開語音頻道並清空隊列。');
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
        console.error('搜尋錯誤', err);
        return interaction.editReply('無法取得影片資訊。');
      }

      q.songs.push({
        title: info.title || info.video_details?.title || 'Unknown',
        url: url
      });

      try {
        await connectAndPlay(interaction, voiceChannel);
      } catch (err) {
        return interaction.editReply('連線語音頻道失敗。');
      }

      interaction.editReply(`已加入隊列：**${q.songs[q.songs.length - 1].title}**`);
      if (!q.playing) playNext(guildId);
      return;
    }

    if (interaction.commandName === 'skip') {
      const conn = getVoiceConnection(guildId);
      if (!conn) return interaction.reply({ content: '機器人不在語音頻道。', ephemeral: true });
      q.player.stop();
      return interaction.reply('已跳過目前歌曲。');
    }

    if (interaction.commandName === 'stop') {
      q.songs = [];
      q.player.stop();
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();
      queues.delete(guildId);
      return interaction.reply('已停止並清空隊列。');
    }

    if (interaction.commandName === 'queue') {
      if (!q.songs.length) return interaction.reply({ content: '目前隊列為空。', ephemeral: true });
      return interaction.reply(`目前隊列：\n${q.songs.map((s, i) => `${i+1}. ${s.title}`).join('\n')}`);
    }

    if (interaction.commandName === 'now') {
      const playing = q.player.state.status === AudioPlayerStatus.Playing ? '正在播放' : '目前無播放';
      return interaction.reply(`${playing}`);
    }

  } catch (err) {
    console.error(err);
    if (interaction.deferred) interaction.editReply('發生錯誤。');
    else interaction.reply({ content: '發生錯誤。', ephemeral: true });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(token);