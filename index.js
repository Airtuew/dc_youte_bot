// index.js - 穩定版 Discord 音樂機器人
require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  InteractionResponseFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const playdl = require('play-dl');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ 請在 .env 設定 DISCORD_TOKEN 與 CLIENT_ID');
  process.exit(1);
}

// Optional: YouTube cookie (提升穩定性)
if (process.env.YOUTUBE_COOKIES) {
  try {
    playdl.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIES } });
    console.log('Using YOUTUBE_COOKIES for play-dl');
  } catch (e) {
    console.warn('Failed to set YOUTUBE_COOKIES', e);
  }
}

// =======================
// Express keep-alive
// =======================
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// =======================
// Discord client
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// queues per guild
const queues = new Map();
function getOrCreateQueue(gid) {
  if (!queues.has(gid)) {
    queues.set(gid, {
      songs: [],
      player: createAudioPlayer(),
      playing: false,
    });
  }
  return queues.get(gid);
}

// =======================
// 播放下一首 helper
// =======================
async function playNext(gid) {
  const q = queues.get(gid);
  if (!q) return;

  if (!q.songs.length) {
    q.playing = false;
    const conn = getVoiceConnection(gid);
    if (conn) conn.destroy();
    return;
  }

  const track = q.songs.shift();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const stream = await playdl.stream(track.url, { quality: 2 });
      const resource = createAudioResource(stream.stream, { inputType: stream.type });
      q.player.play(resource);
      q.playing = true;
      q.player.once(AudioPlayerStatus.Idle, () => playNext(gid));
      return;
    } catch (e) {
      console.error(`播放失敗 (attempt ${attempt}):`, e);
      if (attempt === 2) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // 跳過失敗歌曲
  playNext(gid);
}

// =======================
// 連線語音 & subscribe
// =======================
async function connectAndPlay(interaction, voiceChannel) {
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }

  connection.subscribe(q.player);
}

// =======================
// Slash commands
// =======================
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('加入語音頻道'),
  new SlashCommandBuilder().setName('leave').setDescription('離開語音頻道'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放 YouTube 音樂')
    .addStringOption((o) => o.setName('query').setDescription('連結或搜尋字').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('跳過目前歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止並清空隊列'),
  new SlashCommandBuilder().setName('queue').setDescription('顯示隊列'),
  new SlashCommandBuilder().setName('now').setDescription('顯示目前播放'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('✔ 指令已註冊到指定伺服器');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✔ 全域 Slash 指令已註冊（可能需要幾分鐘生效）');
    }
  } catch (err) {
    console.error('註冊指令失敗', err);
  }
}

// =======================
// Interaction handler
// =======================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  try {
    if (interaction.commandName === 'join') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) return await interaction.reply({ content: '❗ 請先加入語音頻道。', flags: InteractionResponseFlags.Ephemeral });
      try {
        await connectAndPlay(interaction, vc);
        return await interaction.reply({ content: '✅ 已加入語音頻道。' });
      } catch (e) {
        console.error('join 失敗', e);
        return await interaction.reply({ content: '❌ 無法加入語音頻道（請檢查權限）', flags: InteractionResponseFlags.Ephemeral });
      }
    }

    if (interaction.commandName === 'leave') {
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return await interaction.reply({ content: '✅ 已離開語音並清空隊列。' });
    }

    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const vc = interaction.member?.voice?.channel;
      if (!vc) return await interaction.editReply('❗ 請先加入語音頻道。');

      let url = query;
      let info = null;

      try {
        if (!playdl.yt_validate(query)) {
          const results = await playdl.search(query, { limit: 1 });
          if (!results || !results.length) return await interaction.editReply('🔍 找不到任何結果。');
          url = results[0].url;
          info = results[0];
        } else {
          info = await playdl.video_info(query);
        }
      } catch (err) {
        console.error('取得影片資訊失敗', err);
        return await interaction.editReply('❌ 無法取得影片資訊。');
      }

      q.songs.push({ title: info.title || info.video_details?.title || 'Unknown', url });
      await connectAndPlay(interaction, vc);
      await interaction.editReply(`🎵 已加入隊列：**${q.songs[q.songs.length - 1].title}**`);
      if (!q.playing) playNext(gid);
      return;
    }

    if (interaction.commandName === 'skip') {
      const conn = getVoiceConnection(gid);
      if (!conn) return await interaction.reply({ content: '❗ 機器人不在語音頻道。', flags: InteractionResponseFlags.Ephemeral });
      q.player.stop(true);
      return await interaction.reply({ content: '⏭ 已跳過目前歌曲。' });
    }

    if (interaction.commandName === 'stop') {
      q.songs = [];
      try { q.player.stop(); } catch(e) {}
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return await interaction.reply({ content: '⛔ 已停止並清空隊列。' });
    }

    if (interaction.commandName === 'queue') {
      if (!q.songs.length) return await interaction.reply({ content: '目前沒有排歌。', flags: InteractionResponseFlags.Ephemeral });
      const list = q.songs.slice(0, 20).map((s, i) => `${i+1}. ${s.title}`).join('\n');
      return await interaction.reply({ content: `🎶 隊列（前20）：\n${list}` });
    }

    if (interaction.commandName === 'now') {
      const playing = q.player.state.status === AudioPlayerStatus.Playing ? '正在播放' : '目前沒有播放';
      const next = q.songs[0] ? `下一首：${q.songs[0].title}` : '沒有下一首';
      return await interaction.reply({ content: `🎧 ${playing}\n${next}` });
    }
  } catch (err) {
    console.error('指令處理錯誤', err);
    try {
      if (interaction.deferred) await interaction.editReply('❌ 發生錯誤，請查看伺服器日誌。');
      else await interaction.reply({ content: '❌ 發生錯誤，請查看伺服器日誌。', flags: InteractionResponseFlags.Ephemeral });
    } catch (e) {
      console.error('回覆失敗', e);
    }
  }
});

// =======================
// Ready
// =======================
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands().catch((e) => console.error('registerCommands failed', e));
});

client.login(TOKEN).catch((e) => {
  console.error('login failed', e);
  process.exit(1);
});