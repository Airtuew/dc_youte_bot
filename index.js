// Express anti-sleep server (for Render web service)
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// ---------------- Discord bot ----------------
require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection, entersState, VoiceConnectionStatus } = require("@discordjs/voice");
const play = require("play-dl");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error("請在 .env 裡設定 DISCORD_TOKEN 與 CLIENT_ID");
  process.exit(1);
}

// optional: set youtube cookie (helps avoid some YouTube restrictions)
if (process.env.YOUTUBE_COOKIES) {
  try {
    play.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIES } });
    console.log("Using provided YOUTUBE_COOKIES for play-dl");
  } catch (e) {
    console.warn("Failed to set YOUTUBE_COOKIES (ignored)", e);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// queues per guild
const queues = new Map();

function getOrCreateQueue(gid) {
  if (!queues.has(gid)) {
    queues.set(gid, { songs: [], player: createAudioPlayer(), playing: false });
  }
  return queues.get(gid);
}

async function playNext(gid) {
  const q = queues.get(gid);
  if (!q) return;
  if (q.songs.length === 0) {
    q.playing = false;
    const conn = getVoiceConnection(gid);
    if (conn) conn.destroy();
    return;
  }
  const track = q.songs.shift();
  // attempts with simple retry in case of transient failures
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const streamInfo = await play.stream(track.url, { quality: 2 });
      const resource = createAudioResource(streamInfo.stream, { inputType: streamInfo.type });
      q.player.play(resource);
      q.playing = true;
      q.player.once(AudioPlayerStatus.Idle, () => playNext(gid));
      return;
    } catch (err) {
      console.error(`播放錯誤 attempt ${attempt} for ${track.url}`, err);
      if (attempt === 2) {
        // skip to next after final failure
        playNext(gid);
      } else {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
}

async function connectAndPlay(interaction, voiceChannel) {
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);
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

// Slash commands
const commands = [
  new SlashCommandBuilder().setName("join").setDescription("讓機器人加入你的語音頻道"),
  new SlashCommandBuilder().setName("leave").setDescription("讓機器人離開語音頻道"),
  new SlashCommandBuilder().setName("play").setDescription("播放 YouTube 音樂").addStringOption(o => o.setName("query").setDescription("YouTube 連結或關鍵字").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("跳過目前歌曲"),
  new SlashCommandBuilder().setName("stop").setDescription("停止並清空隊列"),
  new SlashCommandBuilder().setName("queue").setDescription("顯示隊列"),
  new SlashCommandBuilder().setName("now").setDescription("顯示現在正在播放的歌")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("已在指定伺服器註冊指令");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("已全域註冊指令（可能需幾分鐘）");
    }
  } catch (err) {
    console.error("註冊指令失敗", err);
  }
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  try {
    if (interaction.commandName === "join") {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: "你必須先加入語音頻道。", ephemeral: true });
      await connectAndPlay(interaction, voiceChannel);
      return interaction.reply({ content: "已加入語音頻道。" });
    }

    if (interaction.commandName === "leave") {
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply({ content: "已離開語音頻道並清空隊列。" });
    }

    if (interaction.commandName === "play") {
      await interaction.deferReply();
      const query = interaction.options.getString("query", true);
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.editReply("你必須先加入語音頻道。");

      let url = query;
      let info = null;
      try {
        if (!play.yt_validate(query)) {
          const results = await play.search(query, { limit: 1 });
          if (!results || results.length === 0) return interaction.editReply("找不到結果。");
          url = results[0].url;
          info = results[0];
        } else {
          info = await play.video_info(query);
        }
      } catch (err) {
        console.error("搜尋或取得影片資訊錯誤", err);
        return interaction.editReply("無法取得影片資訊（YouTube 可能暫時阻擋）。");
      }

      q.songs.push({ title: info.title || info.video_details?.title || "Unknown", url });
      try {
        await connectAndPlay(interaction, voiceChannel);
      } catch (err) {
        console.error("連線語音錯誤", err);
        return interaction.editReply("連線語音頻道失敗。");
      }

      interaction.editReply(`已加入隊列：**${q.songs[q.songs.length - 1].title}**`);
      if (!q.playing) playNext(gid);
      return;
    }

    if (interaction.commandName === "skip") {
      const conn = getVoiceConnection(gid);
      if (!conn) return interaction.reply({ content: "機器人不在語音頻道。", ephemeral: true });
      q.player.stop();
      return interaction.reply({ content: "已跳過目前歌曲。" });
    }

    if (interaction.commandName === "stop") {
      q.songs = [];
      q.player.stop();
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply({ content: "已停止並清空隊列。" });
    }

    if (interaction.commandName === "queue") {
      if (!q.songs.length) return interaction.reply({ content: "目前隊列為空。", ephemeral: true });
      const list = q.songs.slice(0, 20).map((s, i) => `${i + 1}. ${s.title}`).join("\n");
      return interaction.reply({ content: `目前隊列（前20）：\n${list}` });
    }

    if (interaction.commandName === "now") {
      const status = q.player.state.status === AudioPlayerStatus.Playing ? `正在播放：${q.songs[0]?.title || "（正在輸出音訊）"}` : "目前無播放";
      return interaction.reply({ content: status });
    }

  } catch (err) {
    console.error("指令處理錯誤", err);
    if (interaction.deferred) interaction.editReply("發生錯誤，請查看機器人日誌。");
    else interaction.reply({ content: "發生錯誤，請查看機器人日誌。", ephemeral: true });
  }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(TOKEN);