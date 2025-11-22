require("dotenv").config();
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  InteractionResponseFlags
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const playdl = require("play-dl");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID || null;

if (!token || !clientId) {
  console.error("❌ 請在 .env 內設定 DISCORD_TOKEN 與 CLIENT_ID");
  process.exit(1);
}

// =========================
// Express Keep Alive (Render)
// =========================
const app = express();
app.get("/", (req, res) => res.send("Bot is running."));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Express keep alive enabled");
});

// =========================
// Discord Client
// =========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

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

// =========================
// Play Next Song
// =========================
async function playNext(gid) {
  const q = queues.get(gid);
  if (!q || q.songs.length === 0) {
    q.playing = false;
    const conn = getVoiceConnection(gid);
    if (conn) conn.destroy();
    return;
  }

  const track = q.songs.shift();
  try {
    const stream = await playdl.stream(track.url, { quality: 2 });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });
    q.player.play(resource);
    q.playing = true;

    q.player.once(AudioPlayerStatus.Idle, () => playNext(gid));
  } catch (e) {
    console.error("播放錯誤", e);
    playNext(gid);
  }
}

// =========================
// Connect to Voice (Encryption FIX)
// =========================
async function connectAndPlay(interaction, voiceChannel) {
  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  const encryptionMode =
    ["aead_xchacha20_poly1305_rtpsize", "aead_aes256_gcm_rtpsize"][0];

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    encryption: { mode: encryptionMode }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }

  connection.subscribe(q.player);
}

// =========================
// Slash Commands
// =========================
const commands = [
  new SlashCommandBuilder().setName("join").setDescription("讓機器人加入語音頻道"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("讓機器人離開語音頻道"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("播放 YouTube 音樂")
    .addStringOption(opt =>
      opt.setName("url").setDescription("YouTube 連結或搜尋字").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
  new SlashCommandBuilder().setName("stop").setDescription("停止音樂並清空隊列"),
  new SlashCommandBuilder().setName("queue").setDescription("顯示隊列"),
  new SlashCommandBuilder().setName("now").setDescription("顯示目前播放")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands
    });
    console.log("✔ 指令已註冊到伺服器");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✔ 全域 Slash 指令已註冊");
  }
}

// =========================
// Command Handler
// =========================
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;

  const gid = interaction.guildId;
  const q = getOrCreateQueue(gid);

  try {
    // JOIN
    if (interaction.commandName === "join") {
      const vc = interaction.member.voice.channel;
      if (!vc)
        return interaction.reply({
          content: "請先加入語音頻道",
          flags: InteractionResponseFlags.Ephemeral
        });

      await connectAndPlay(interaction, vc);
      return interaction.reply("已加入語音頻道 ✔");
    }

    // LEAVE
    if (interaction.commandName === "leave") {
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply("已離開語音並清空隊列");
    }

    // PLAY
    if (interaction.commandName === "play") {
      await interaction.deferReply();

      const query = interaction.options.getString("url", true);
      const vc = interaction.member.voice.channel;
      if (!vc) return interaction.editReply("請先加入語音頻道");

      let info;
      let url = query;

      try {
        if (!playdl.yt_validate(query)) {
          const results = await playdl.search(query, { limit: 1 });
          if (!results.length)
            return interaction.editReply("找不到任何結果");
          url = results[0].url;
          info = results[0];
        } else {
          info = await playdl.video_info(query);
        }
      } catch (e) {
        console.error(e);
        return interaction.editReply("無法取得影片資訊");
      }

      q.songs.push({
        title: info.title || info.video_details?.title || "Unknown",
        url
      });

      await connectAndPlay(interaction, vc);

      interaction.editReply(`🎵 已加入隊列：**${q.songs[q.songs.length - 1].title}**`);

      if (!q.playing) playNext(gid);
      return;
    }

    // SKIP
    if (interaction.commandName === "skip") {
      const conn = getVoiceConnection(gid);
      if (!conn)
        return interaction.reply({
          content: "機器人不在語音頻道",
          flags: InteractionResponseFlags.Ephemeral
        });

      q.player.stop();
      return interaction.reply("⏭ 已跳過");
    }

    // STOP
    if (interaction.commandName === "stop") {
      q.songs = [];
      q.player.stop();
      const conn = getVoiceConnection(gid);
      if (conn) conn.destroy();
      queues.delete(gid);
      return interaction.reply("⛔ 已停止並離開語音");
    }

    // QUEUE
    if (interaction.commandName === "queue") {
      if (!q.songs.length)
        return interaction.reply({
          content: "目前沒有排歌",
          flags: InteractionResponseFlags.Ephemeral
        });

      const list = q.songs
        .slice(0, 10)
        .map((x, i) => `${i + 1}. ${x.title}`)
        .join("\n");

      return interaction.reply(`🎶 **隊列（前10首）**\n${list}`);
    }

    // NOW PLAYING
    if (interaction.commandName === "now") {
      const status =
        q.player.state.status === AudioPlayerStatus.Playing
          ? "正在播放中"
          : "目前沒有播放";
      const next = q.songs[0] ? `下一首：${q.songs[0].title}` : "沒有下一首";

      return interaction.reply(`🎧 ${status}\n${next}`);
    }
  } catch (e) {
    console.error("指令處理錯誤", e);
    if (interaction.deferred)
      interaction.editReply("❌ 發生錯誤，請查看 logs");
    else
      interaction.reply({
        content: "❌ 發生錯誤，請查看 logs",
        flags: InteractionResponseFlags.Ephemeral
      });
  }
});

// =========================
// Bot Ready
// =========================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(token);