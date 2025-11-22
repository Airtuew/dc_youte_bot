require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  InteractionResponseFlags
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require('@discordjs/voice');
const playdl = require('play-dl');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ 請在 .env 裡設定 DISCORD_TOKEN 與 CLIENT_ID');
  process.exit(1);
}

// --- Express keep-alive ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// --- Discord client ---
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
      playing: false
    });
  }
  return queues.get(gid);
}

// play next song
async function playNext(gid) {
  const q = queues.get(gid);
  if (!q || !q.songs.length) {
    q.playing = false;
    const conn = getVoiceConnection(gid);
    if (conn) conn.destroy();
    return;
  }

  const track = q.songs.shift();
  try {
    const stream = await playdl.stream(track.url, { quality: 2 });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    q.player.play(resource);
    q.playing = true;

    q.player.once(AudioPlayerStatus.Idle, () => playNext(gid));
  } catch (err) {
    console.error('播放失敗', err);
    playNext(gid);
  }
}

// join & subscribe (Render friendly)
async function connectAndPlay(interaction, voiceChannel) {
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  try {
    // 延長等待時間到 30 秒
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
  } catch (err) {
    connection.destroy();
    throw new Error('無法加入語音頻道，請確認權限與頻道可用性');
  }

  connection.subscribe(q.player);
}

// --- Slash commands ---
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('讓機器人加入語音頻道'),
  new SlashCommandBuilder().setName('leave').setDescription('離開語音頻道並清空隊列'),
  new SlashCommandBuilder().setName('play')
    .setDescription('播放 YouTube 音樂')
    .addStringOption(opt => opt.setName('query').setDescription('YouTube 連結或搜尋字').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('跳過歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止並清空隊列'),
  new SlashCommandBuilder().setName('queue').setDescription('顯示隊列'),
  new SlashCommandBuilder().setName('now').setDescription('目前播放')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('✔ 指令已註冊到伺服器');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✔ 全域 Slash 指令已註冊');
    }
  } catch (err) {
    console.error('指令註冊失敗', err);
  }
}

// --- Interaction handler ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  try {
    // --- JOIN ---
    if (interaction.commandName === 'join') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.reply({ content: '❗ 請先加入語音頻道', flags: InteractionResponseFlags.Ephemeral });
      try {
        await connectAndPlay(interaction, vc);
        return interaction.reply('✅ 已加入語音頻道');
      } catch (err) {
        console.error('join 失敗', err);
        return interaction.reply({ content: '❌ 無法加入語音頻道', flags: InteractionResponseFlags.Ephemeral });
      }
    }

    // --- LEAVE ---
    if (interaction.commandName === 'leave') {
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply('✅ 已離開語音頻道並清空隊列');
    }

    // --- PLAY ---
    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.editReply('❗ 請先加入語音頻道');

      let url = query;
      let info = null;
      try {
        if (!playdl.yt_validate(query)) {
          const results = await playdl.search(query, { limit: 1 });
          if (!results.length) return interaction.editReply('🔍 找不到結果');
          url = results[0].url;
          info = results[0];
        } else {
          info = await playdl.video_info(query);
        }
      } catch (err) {
        console.error('取得影片資訊失敗', err);
        return interaction.editReply('❌ 無法取得影片資訊');
      }

      q.songs.push({ title: info.title || info.video_details?.title || 'Unknown', url });
      try {
        await connectAndPlay(interaction, vc);
      } catch (err) {
        console.error('連線語音失敗', err);
      }

      await interaction.editReply(`🎵 已加入隊列：**${q.songs[q.songs.length-1].title}**`);
      if (!q.playing) playNext(gid);
      return;
    }

    // --- SKIP ---
    if (interaction.commandName === 'skip') {
      const conn = getVoiceConnection(gid);
      if (!conn) return interaction.reply({ content: '❗ 機器人不在語音頻道', flags: InteractionResponseFlags.Ephemeral });
      q.player.stop(true);
      return interaction.reply('⏭ 已跳過歌曲');
    }

    // --- STOP ---
    if (interaction.commandName === 'stop') {
      q.songs = [];
      q.player.stop();
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply('⛔ 已停止並清空隊列');
    }

    // --- QUEUE ---
    if (interaction.commandName === 'queue') {
      if (!q.songs.length) return interaction.reply({ content: '目前沒有排歌', flags: InteractionResponseFlags.Ephemeral });
      const list = q.songs.slice(0, 20).map((s,i)=>`${i+1}. ${s.title}`).join('\n');
      return interaction.reply(`🎶 隊列（前20）：\n${list}`);
    }

    // --- NOW ---
    if (interaction.commandName === 'now') {
      const playing = q.player.state.status === AudioPlayerStatus.Playing ? '正在播放' : '目前沒有播放';
      const next = q.songs[0] ? `下一首：${q.songs[0].title}` : '沒有下一首';
      return interaction.reply(`🎧 ${playing}\n${next}`);
    }

  } catch (err) {
    console.error('指令處理失敗', err);
    try {
      if (interaction.deferred) await interaction.editReply('❌ 發生錯誤');
      else await interaction.reply({ content:'❌ 發生錯誤', flags: InteractionResponseFlags.Ephemeral });
    } catch {}
  }
});

// --- ready & register ---
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(TOKEN).catch(e => {
  console.error('login 失敗', e);
  process.exit(1);
});